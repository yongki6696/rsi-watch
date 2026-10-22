"""스마트 머니(SMC) 개념 계산: 유동성 레벨, 훼손(스윕), 가격 구조, 오더블록.

채널 용어 → 코드
  바이사이드 유동성 : 스윙 고점 (그 뒤에 숏 포지션 손절 물량)      → Levels side=+1
  셀사이드 유동성   : 스윙 저점 (그 뒤에 롱 포지션 손절 물량)      → Levels side=-1
  내부 / 외부 유동성: 유동성 봉(1h) 스윙 / 구조 봉(4h) 스윙         → Levels.external
  훼손(수입)        : 가격이 그 레벨을 처음 넘어서는 봉              → Levels.swept
  서플라이/디맨드 존: 구조를 깬 임펄스 캔들 직전의 반대 색 캔들 구간 → Zones
  구조의 기준 가격  : 추세를 만든 마지막 다리의 출발점. 종가로 깨지면 구조 전환 → structure()

모든 값에는 '진입 봉 몇 번째부터 알 수 있는지'(known)가 붙어 있다.
진입 봉 i 에서는 known <= i 인 정보만 써야 미래 참조가 없다.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .indicators import atr, pivots
from .timeframes import timeframe_seconds

AGG = {"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"}


def resample(df: pd.DataFrame, timeframe: str) -> pd.DataFrame:
    rule = pd.Timedelta(seconds=timeframe_seconds(timeframe))
    return df.resample(rule, origin="epoch", label="left", closed="left").agg(AGG).dropna()


def known_index(base_index: pd.DatetimeIndex, base_tf: str, times: pd.DatetimeIndex) -> np.ndarray:
    """정보가 확정되는 시각 times 에 대해, 그 정보를 처음 쓸 수 있는 진입 봉 인덱스.

    진입 봉 i 는 index[i] + base_tf 에 마감되므로 마감 시각 >= T 인 첫 봉.
    """
    close_ns = (base_index + pd.Timedelta(seconds=timeframe_seconds(base_tf))).asi8
    return np.searchsorted(close_ns, pd.DatetimeIndex(times).asi8, side="left")


def first_cross(values: np.ndarray, start: np.ndarray, price: np.ndarray, above: bool,
                limit: np.ndarray | None = None, chunk: int = 256) -> np.ndarray:
    """각 레벨에 대해 start 이후 처음으로 values 가 price 를 넘는(above) / 밑도는 인덱스. 없으면 len."""
    n = len(values)
    out = np.full(len(price), n, dtype=np.int64)
    for k in range(len(price)):
        j = int(start[k])
        stop = n if limit is None else min(n, int(limit[k]))
        while j < stop:
            seg = values[j:min(stop, j + chunk)]
            hit = seg > price[k] if above else seg < price[k]
            if hit.any():
                out[k] = j + int(np.argmax(hit))
                break
            j += chunk
    return out


@dataclass
class Levels:
    price: np.ndarray
    side: np.ndarray      # +1 고점(바이사이드) / -1 저점(셀사이드)
    external: np.ndarray  # True = 구조 봉(4h) 스윙
    known: np.ndarray     # 진입 봉 인덱스: 이 봉 마감부터 레벨을 앎
    swept: np.ndarray     # 처음 훼손된 진입 봉 인덱스 (없으면 n)


def _pivot_levels(frame: pd.DataFrame, n: int, tf: str, base: pd.DataFrame, base_tf: str, external: bool):
    h, l = frame["high"].to_numpy(float), frame["low"].to_numpy(float)
    ph, pl = pivots(h, l, n)
    tf_td = pd.Timedelta(seconds=timeframe_seconds(tf))
    out = []
    for idx, side, src in ((ph, 1, h), (pl, -1, l)):
        idx = idx[idx + n < len(frame)]
        conf_times = frame.index[idx + n] + tf_td
        out.append((src[idx], np.full(len(idx), side), np.full(len(idx), external),
                    known_index(base.index, base_tf, conf_times), frame.index[idx]))
    return out


def liquidity_levels(base: pd.DataFrame, base_tf: str, lq: pd.DataFrame, lq_tf: str, lq_n: int,
                     st: pd.DataFrame, st_tf: str, st_n: int) -> Levels:
    parts = _pivot_levels(lq, lq_n, lq_tf, base, base_tf, False) + _pivot_levels(st, st_n, st_tf, base, base_tf, True)
    price = np.concatenate([p[0] for p in parts])
    side = np.concatenate([p[1] for p in parts]).astype(int)
    ext = np.concatenate([p[2] for p in parts]).astype(bool)
    known = np.concatenate([p[3] for p in parts]).astype(np.int64)
    high, low = base["high"].to_numpy(float), base["low"].to_numpy(float)
    swept = np.full(len(price), len(base), dtype=np.int64)
    up, dn = side == 1, side == -1
    swept[up] = first_cross(high, known[up] + 1, price[up], above=True)
    swept[dn] = first_cross(low, known[dn] + 1, price[dn], above=False)
    return Levels(price, side, ext, known, swept)


@dataclass
class Events:
    """한 방향의 '무장' 이벤트: 유동성 훼손 또는 오더블록 터치. idx 오름차순."""
    idx: np.ndarray       # 이벤트가 일어난 진입 봉
    level: np.ndarray     # 넘어서면 안 되는 가격 (훼손 레벨 / 존 바깥쪽 끝)
    kind: np.ndarray      # 0 = 유동성 훼손, 1 = 오더블록
    external: np.ndarray  # 외부 유동성 여부
    zone_low: np.ndarray
    zone_high: np.ndarray


def sweep_events(lv: Levels, side: int, n: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """같은 봉에서 여러 레벨을 훼손하면 가장 바깥 레벨 하나로 묶는다."""
    m = (lv.side == side) & (lv.swept < n)
    idx, price, ext = lv.swept[m], lv.price[m], lv.external[m]
    if len(idx) == 0:
        return idx, price, ext
    order = np.lexsort((price * side, idx))  # idx 오름차순, 같은 idx 안에서 바깥 레벨이 마지막
    idx, price, ext = idx[order], price[order], ext[order]
    last = np.r_[idx[1:] != idx[:-1], True]
    any_ext = pd.Series(ext).groupby(idx).transform("max").to_numpy(bool)
    return idx[last], price[last], any_ext[last]


@dataclass
class Zones:
    low: np.ndarray
    high: np.ndarray
    side: np.ndarray      # +1 서플라이(숏 자리) / -1 디맨드(롱 자리)
    known: np.ndarray
    touched: np.ndarray   # 처음 닿은 진입 봉 (유효기간 안에 없으면 n)


def order_blocks(base: pd.DataFrame, base_tf: str, st: pd.DataFrame, st_tf: str, n: int,
                 impulse_atr: float, max_age: int, atr_period: int) -> Zones:
    """임펄스 = 몸통이 ATR x impulse_atr 이상이고 직전 스윙을 처음 종가로 깨는 캔들.
    오더블록 = 임펄스 직전 3봉 안의 마지막 반대 색 캔들의 고가~저가."""
    o, h, l, c = (st[k].to_numpy(float) for k in ("open", "high", "low", "close"))
    a = atr(st, atr_period).to_numpy(float)
    ph, pl = pivots(h, l, n)
    st_td = pd.Timedelta(seconds=timeframe_seconds(st_tf))
    rows = []
    for k in range(1, len(st)):
        if not np.isfinite(a[k]) or abs(c[k] - o[k]) < impulse_atr * a[k]:
            continue
        bear = c[k] < o[k]
        piv = pl if bear else ph
        piv = piv[piv + n <= k]
        if len(piv) == 0:
            continue
        j = piv[-1]
        ref = l[j] if bear else h[j]
        between = c[j + 1:k]
        broke_now = c[k] < ref if bear else c[k] > ref
        fresh = (between >= ref).all() if bear else (between <= ref).all()
        if not (broke_now and fresh):
            continue
        ob = None
        for m in range(k - 1, max(-1, k - 4), -1):
            if (c[m] > o[m]) if bear else (c[m] < o[m]):
                ob = m
                break
        ob = k - 1 if ob is None else ob
        rows.append((l[ob], h[ob], 1 if bear else -1, st.index[k] + st_td))
    if not rows:
        e = np.array([])
        return Zones(e, e, e.astype(int), e.astype(np.int64), e.astype(np.int64))
    zl, zh, zs, zt = (np.array(x) for x in zip(*rows))
    known = known_index(base.index, base_tf, pd.DatetimeIndex(zt)).astype(np.int64)
    age = int(max_age * timeframe_seconds(st_tf) / timeframe_seconds(base_tf))
    high, low = base["high"].to_numpy(float), base["low"].to_numpy(float)
    touched = np.full(len(zl), len(base), dtype=np.int64)
    sup, dem = zs == 1, zs == -1
    # 서플라이는 고가가 존 하단을 넘을 때, 디맨드는 저가가 존 상단 아래로 올 때 '터치'
    touched[sup] = first_cross(high, known[sup] + 1, zl[sup] - 1e-12, above=True, limit=known[sup] + 1 + age)
    touched[dem] = first_cross(low, known[dem] + 1, zh[dem] + 1e-12, above=False, limit=known[dem] + 1 + age)
    return Zones(zl, zh, zs.astype(int), known, touched)


def build_events(lv: Levels, zones: Zones, n: int, side: int, use_sweep: bool, use_ob: bool,
                 external_only: bool = False) -> Events:
    """side=+1: 숏 셋업(바이사이드 훼손, 서플라이 터치) / -1: 롱 셋업."""
    parts = []
    if use_sweep:
        if external_only:
            m = lv.external
            lv = Levels(lv.price[m], lv.side[m], lv.external[m], lv.known[m], lv.swept[m])
        idx, price, ext = sweep_events(lv, side, n)
        parts.append((idx, price, np.zeros(len(idx), int), ext, price, price))
    if use_ob and len(zones.low):
        m = (zones.side == side) & (zones.touched < n)
        far = zones.high[m] if side == 1 else zones.low[m]
        parts.append((zones.touched[m], far, np.ones(m.sum(), int), np.zeros(m.sum(), bool),
                      zones.low[m], zones.high[m]))
    if not parts:
        e = np.array([], dtype=np.int64)
        return Events(e, e.astype(float), e, e.astype(bool), e.astype(float), e.astype(float))
    cols = [np.concatenate([p[k] for p in parts]) for k in range(6)]
    order = np.argsort(cols[0], kind="stable")
    return Events(*(c[order] for c in cols))


def structure(st: pd.DataFrame, n: int) -> tuple[np.ndarray, np.ndarray]:
    """구조 봉의 가격 구조 상태(+1 상승 / -1 하락 / 0 미정)와 기준 가격.

    - 상승 구조의 기준 가격 = 마지막으로 고점을 돌파한 다리의 출발 저점. 종가로 깨지면 하락 전환
    - 하락 구조의 기준 가격 = 마지막으로 저점을 이탈한 다리의 출발 고점. 종가로 넘으면 상승 전환
    - 같은 방향으로 스윙을 깨면(BOS) 기준 가격을 새 다리의 출발점으로 옮긴다
    """
    h, l, c = (st[k].to_numpy(float) for k in ("high", "low", "close"))
    ph, pl = pivots(h, l, n)
    ph_at = {j + n: j for j in ph}
    pl_at = {j + n: j for j in pl}
    state, ref, ref_i = 0, np.nan, -1
    last_ph = last_pl = None  # (가격, 인덱스, 깨졌는지)
    out_s = np.zeros(len(st))
    out_r = np.full(len(st), np.nan)
    for t in range(len(st)):
        if t in ph_at:
            last_ph = [h[ph_at[t]], ph_at[t], False]
        if t in pl_at:
            last_pl = [l[pl_at[t]], pl_at[t], False]
        up = last_ph is not None and not last_ph[2] and c[t] > last_ph[0]
        dn = last_pl is not None and not last_pl[2] and c[t] < last_pl[0]
        if state == 1 and c[t] < ref:
            state = -1
            ref_i = ref_i + int(np.argmax(h[ref_i:t + 1]))
            ref = h[ref_i]
        elif state == -1 and c[t] > ref:
            state = 1
            ref_i = ref_i + int(np.argmin(l[ref_i:t + 1]))
            ref = l[ref_i]
        elif up and state >= 0:
            state = 1
            ref_i = last_ph[1] + int(np.argmin(l[last_ph[1]:t + 1]))
            ref = l[ref_i]
        elif dn and state <= 0:
            state = -1
            ref_i = last_pl[1] + int(np.argmax(h[last_pl[1]:t + 1]))
            ref = h[ref_i]
        if up:
            last_ph[2] = True
        if dn:
            last_pl[2] = True
        out_s[t], out_r[t] = state, ref
    return out_s, out_r


def to_base(values: np.ndarray, known: np.ndarray, n: int, fill=np.nan) -> np.ndarray:
    """상위 봉 값(known 오름차순)을 진입 봉마다 '그때까지 확정된 마지막 값'으로 펼친다."""
    pos = np.searchsorted(known, np.arange(n), side="right") - 1
    out = np.where(pos >= 0, values[np.clip(pos, 0, None)] if len(values) else fill, fill)
    return out.astype(float)
