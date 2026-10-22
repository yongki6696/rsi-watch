"""시세 데이터: 거래소(ccxt) 수집, CSV 저장/로드, 미마감 봉 제거, 데모용 합성 데이터."""
from __future__ import annotations

import os
from pathlib import Path

import numpy as np
import pandas as pd

from .config import ExchangeParams
from .timeframes import timeframe_seconds

COLUMNS = ["open", "high", "low", "close", "volume"]


def make_exchange(p: ExchangeParams, with_keys: bool = False):
    import ccxt

    if not hasattr(ccxt, p.id):
        raise ValueError(f"ccxt 에 없는 거래소 id: {p.id}")
    options: dict = {}
    if p.market_type == "future":
        options["defaultType"] = "swap"
    if p.id == "hyperliquid":
        options["builderFee"] = False  # ccxt 기본값은 주문마다 0.01% 빌더 수수료를 ccxt 주소로 보냄 → 끔
        options["refSet"] = True       # ccxt 기본값은 첫 주문 때 계정에 ccxt 추천인 코드를 영구 등록 → 끔
    ex = getattr(ccxt, p.id)({"enableRateLimit": True, "options": options})
    if with_keys:
        set_credentials(ex, p)
    if p.sandbox:
        if not (ex.urls or {}).get("test"):
            raise ValueError(f"{p.id} 는 테스트넷이 없습니다. exchange.sandbox: false 로 두고 "
                             f"모의매매(--live 없이)로 확인한 뒤 소액으로 시작하세요")
        ex.set_sandbox_mode(True)
    elif p.demo:
        ex.enable_demo_trading(True)  # 바이낸스 데모 트레이딩 계정
    return ex


def set_credentials(ex, p: ExchangeParams) -> None:
    """환경변수의 키를 거래소 객체에 넣는다. 지갑 서명 방식(하이퍼리퀴드)과 API 키 방식을 구분."""
    need = ex.requiredCredentials
    if need.get("walletAddress") or need.get("privateKey"):
        addr, key = os.environ.get(p.wallet_address_env), os.environ.get(p.private_key_env)
        if not addr or not key:
            raise RuntimeError(f"환경변수 {p.wallet_address_env}(메인 지갑 주소) / "
                               f"{p.private_key_env}(API 지갑 개인키)를 넣어주세요")
        ex.walletAddress, ex.privateKey = addr, key
        return
    key, secret = os.environ.get(p.api_key_env), os.environ.get(p.secret_env)
    if not key or not secret:
        raise RuntimeError(f"환경변수 {p.api_key_env} / {p.secret_env} 에 API 키를 넣어주세요")
    ex.apiKey, ex.secret = key, secret
    if os.environ.get(p.password_env):
        ex.password = os.environ[p.password_env]


def to_frame(rows: list[list]) -> pd.DataFrame:
    df = pd.DataFrame(rows, columns=["ts"] + COLUMNS)
    df["ts"] = pd.to_datetime(df["ts"], unit="ms", utc=True)
    df = df.drop_duplicates("ts").sort_values("ts").set_index("ts")
    return df.astype(float)


def ohlcv_limit(ex, market_type: str = "spot") -> int | None:
    """ccxt 에 적힌 거래소별 봉 조회 최대 개수 (빗썸·업비트 200, 바이낸스 1000, 하이퍼리퀴드 5000)."""
    feats = getattr(ex, "features", None) or {}
    node = feats.get("swap" if market_type == "future" else "spot") or {}
    for d in (node, node.get("linear") or {}, feats.get("spot") or {}):
        lim = (d.get("fetchOHLCV") or {}).get("limit")
        if lim:
            return int(lim)
    return None


# 시작 시각(since)을 무시하고 '최근 N개'만 주는 거래소: to(이 시각 이전) 로 뒤로 넘겨 가며 받는다
BACKWARD_PAGING = {"bithumb"}


def fetch_ohlcv(ex, symbol: str, timeframe: str, since_ms: int, until_ms: int | None = None,
                page_limit: int | None = None) -> pd.DataFrame:
    """since 부터 현재(또는 until)까지 페이지를 넘기며 모두 수집."""
    page_limit = page_limit or ohlcv_limit(ex, "future" if ":" in symbol else "spot")
    if getattr(ex, "id", "") in BACKWARD_PAGING:
        rows = _fetch_backward(ex, symbol, timeframe, since_ms, page_limit or 200)
    else:
        rows = _fetch_forward(ex, symbol, timeframe, since_ms, until_ms, page_limit)
    df = to_frame(rows) if rows else pd.DataFrame(columns=COLUMNS)
    if len(df):
        df = df[df.index >= pd.Timestamp(since_ms, unit="ms", tz="UTC")]
    if until_ms is not None and len(df):
        df = df[df.index < pd.Timestamp(until_ms, unit="ms", tz="UTC")]
    return df


def _fetch_forward(ex, symbol, timeframe, since_ms, until_ms, page_limit) -> list[list]:
    tf_ms = timeframe_seconds(timeframe) * 1000
    now = ex.milliseconds()
    end = min(until_ms or now, now)
    rows: list[list] = []
    cursor = since_ms
    while cursor < end:
        batch = ex.fetch_ohlcv(symbol, timeframe, since=cursor, limit=page_limit)
        if not batch:
            break
        rows.extend(batch)
        nxt = batch[-1][0] + tf_ms
        if nxt <= cursor:
            break
        cursor = nxt
    return rows


def _fetch_backward(ex, symbol, timeframe, since_ms, page_limit) -> list[list]:
    rows: list[list] = []
    to = None
    while True:
        params = {"to": pd.Timestamp(to, unit="ms", tz="UTC").strftime("%Y-%m-%dT%H:%M:%SZ")} if to else {}
        batch = ex.fetch_ohlcv(symbol, timeframe, limit=page_limit, params=params)
        if not batch:
            break
        rows = batch + rows
        oldest = batch[0][0]
        if oldest <= since_ms or (to is not None and oldest >= to):
            break
        to = oldest
    return rows


def drop_unclosed(df: pd.DataFrame, timeframe: str, now_ms: int) -> pd.DataFrame:
    """아직 마감되지 않은(진행 중인) 봉 제거."""
    if df.empty:
        return df
    tf = pd.Timedelta(seconds=timeframe_seconds(timeframe))
    now = pd.Timestamp(now_ms, unit="ms", tz="UTC")
    return df[df.index + tf <= now]


def save_csv(df: pd.DataFrame, path: str | Path) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    out = df.copy()
    out.index = out.index.strftime("%Y-%m-%dT%H:%M:%SZ")
    out.to_csv(path, index_label="timestamp")


def load_csv(path: str | Path) -> pd.DataFrame:
    """timestamp,open,high,low,close,volume 형식. timestamp 는 ISO 문자열 또는 ms 정수."""
    raw = pd.read_csv(path)
    first = raw.columns[0]
    ts = raw[first]
    if pd.api.types.is_numeric_dtype(ts):
        idx = pd.to_datetime(ts, unit="ms", utc=True)
    else:
        idx = pd.to_datetime(ts, utc=True)
    df = raw[COLUMNS].astype(float)
    df.index = pd.DatetimeIndex(idx, name="ts")
    return df[~df.index.duplicated()].sort_index()


def synthetic_ohlcv(n: int = 6000, seed: int = 7, timeframe: str = "1h",
                    start: str = "2024-01-01", price: float = 60_000.0) -> pd.DataFrame:
    """데모/테스트용 합성 시세. 횡보(박스)와 추세 구간이 번갈아 나오고 가끔 긴 꼬리(스윕)가 섞인다.

    실제 시장이 아니므로 이 데이터의 백테스트 수익은 전략의 실력과 무관하다.
    """
    rng = np.random.default_rng(seed)
    vol = 0.006
    closes, opens, highs, lows, vols = [], [], [], [], []
    p = price
    i = 0
    while i < n:
        length = int(rng.integers(150, 600))
        trending = rng.random() < 0.45
        drift = rng.choice([-1, 1]) * rng.uniform(0.0003, 0.0009) if trending else 0.0
        anchor = np.log(p)
        for _ in range(min(length, n - i)):
            r = drift + vol * rng.standard_normal()
            if not trending:
                r -= 0.03 * (np.log(p) - anchor)
            o, cl = p, p * np.exp(r)
            up = abs(rng.standard_normal()) * vol * 0.5
            dn = abs(rng.standard_normal()) * vol * 0.5
            spike = 1.0
            if rng.random() < 0.03:  # 손절 사냥성 긴 꼬리
                extra = rng.uniform(1.5, 3.0) * vol
                if rng.random() < 0.5:
                    dn += extra
                else:
                    up += extra
                spike = rng.uniform(2.0, 4.0)
            opens.append(o)
            closes.append(cl)
            highs.append(max(o, cl) * np.exp(up))
            lows.append(min(o, cl) * np.exp(-dn))
            vols.append(100 * np.exp(0.3 * rng.standard_normal()) * (1 + abs(r) / vol) * spike)
            p = cl
            i += 1
    idx = pd.date_range(start, periods=n, freq=pd.Timedelta(seconds=timeframe_seconds(timeframe)),
                        tz="UTC", name="ts")
    return pd.DataFrame({"open": opens, "high": highs, "low": lows, "close": closes, "volume": vols},
                        index=idx)


def parse_date_ms(s: str) -> int:
    return int(pd.Timestamp(s, tz="UTC").timestamp() * 1000)
