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
    opts: dict = {"enableRateLimit": True}
    if p.market_type == "future":
        opts["options"] = {"defaultType": "swap"}
    if with_keys:
        key, secret = os.environ.get(p.api_key_env), os.environ.get(p.secret_env)
        if not key or not secret:
            raise RuntimeError(f"환경변수 {p.api_key_env} / {p.secret_env} 에 API 키를 넣어주세요")
        opts.update(apiKey=key, secret=secret)
        if os.environ.get(p.password_env):
            opts["password"] = os.environ[p.password_env]
    ex = getattr(ccxt, p.id)(opts)
    if p.sandbox:
        ex.set_sandbox_mode(True)
    return ex


def to_frame(rows: list[list]) -> pd.DataFrame:
    df = pd.DataFrame(rows, columns=["ts"] + COLUMNS)
    df["ts"] = pd.to_datetime(df["ts"], unit="ms", utc=True)
    df = df.drop_duplicates("ts").sort_values("ts").set_index("ts")
    return df.astype(float)


def fetch_ohlcv(ex, symbol: str, timeframe: str, since_ms: int, until_ms: int | None = None,
                page_limit: int | None = None) -> pd.DataFrame:
    """since 부터 현재(또는 until)까지 페이지를 넘기며 모두 수집."""
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
    df = to_frame(rows) if rows else pd.DataFrame(columns=COLUMNS)
    if until_ms is not None and len(df):
        df = df[df.index < pd.Timestamp(until_ms, unit="ms", tz="UTC")]
    return df


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
