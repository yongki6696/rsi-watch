"""매매 규칙 — 차슐랭 채널 자막에서 정리한 방식 (RULES.md 참고).

  1) 유동성 훼손 또는 오더블록 터치로 '무장'
     - 바이사이드(스윙 고점) 훼손 / 서플라이 존 터치 → 숏 후보
     - 셀사이드(스윙 저점) 훼손 / 디맨드 존 터치   → 롱 후보
  2) arm_bars 안에 트리거가 나오면 다음 봉 진입
     - 핀바   : 훼손이 일어난 유동성 봉(1h)이 긴 꼬리를 남기고 레벨 안쪽으로 마감
                 ("1시간봉 … 윗꼬리를 말아내리고 핀바 형태로 바로 캔들이 안으로 회귀")
     - 구조 전환: 훼손 뒤 진입 봉에서 직전 스윙을 종가로 반대로 깸 ("내부 구조가 하락으로 전환")
     - 훼손 폭이 sweep_max_atr 보다 크면 함정이 아니라 돌파 → 무효 ("저점을 미리 예상하지 않는다")
  3) 손절 = 훼손 꼬리 끝 너머 / 1차 익절 tp1_r 에서 일부 → 본절 → 나머지는 스윙 따라 보유
  4) 방향은 고집하지 않는다(bias_mode: off). structure 로 바꾸면 4h 구조 방향으로만 진입

신호는 i 번째 진입 봉이 마감된 뒤 그때까지 확정된 정보만으로 계산하고, 진입은 다음 봉에서 한다.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .config import Config, StrategyParams
from .indicators import atr, pivots
from .smc import (Events, build_events, known_index, liquidity_levels, order_blocks, resample,
                  structure, to_base)
from .timeframes import timeframe_seconds


@dataclass
class Signal:
    side: str          # long | short
    setup: str         # sweep | ob
    trigger: str       # pinbar | choch
    ref_price: float   # 신호 봉 종가 (실제 진입은 다음 봉 시가 근처)
    stop: float
    tp1: float
    tp2: float         # 0 이면 최종 목표 없음
    level: float       # 훼손된 레벨 / 존 바깥 끝
    bar_time: pd.Timestamp
    reason: str


@dataclass
class Features:
    index: pd.DatetimeIndex
    open: np.ndarray
    high: np.ndarray
    low: np.ndarray
    close: np.ndarray
    atr: np.ndarray        # 유동성 봉(1h) ATR, 진입 봉 기준으로 확정된 값
    lq_ohlc: np.ndarray    # (n, 4) 유동성 봉이 마감되는 진입 봉 자리에 그 봉의 OHLC, 나머지는 nan
    lq_start: np.ndarray   # 같은 자리에 그 유동성 봉의 첫 진입 봉 인덱스
    struct: np.ndarray     # 4h 구조 상태 +1/-1/0
    struct_ref: np.ndarray # 4h 구조 기준 가격
    piv_hi: np.ndarray     # 진입 봉 스윙 고점 인덱스 (j + entry_pivot_window 에 확정)
    piv_lo: np.ndarray
    short_ev: Events
    long_ev: Events
    trail: dict  # {(runner, 'hi'|'lo'): (확정 봉, 가격)} 트레일링 기준 스윙 (trail=1h, trail_ext=4h)


def prepare_features(df: pd.DataFrame, cfg: Config) -> Features:
    p = cfg.strategy
    n = len(df)
    lq = resample(df, cfg.liquidity_timeframe)
    st = resample(df, cfg.structure_timeframe)
    lv = liquidity_levels(df, cfg.timeframe, lq, cfg.liquidity_timeframe, p.liq_pivot_window,
                          st, cfg.structure_timeframe, p.ext_pivot_window)
    zones = order_blocks(df, cfg.timeframe, st, cfg.structure_timeframe, p.ext_pivot_window,
                         p.ob_impulse_atr, p.ob_max_age, p.atr_period)

    lq_td = pd.Timedelta(seconds=timeframe_seconds(cfg.liquidity_timeframe))
    st_td = pd.Timedelta(seconds=timeframe_seconds(cfg.structure_timeframe))
    lq_known = known_index(df.index, cfg.timeframe, lq.index + lq_td)
    st_known = known_index(df.index, cfg.timeframe, st.index + st_td)
    s_state, s_ref = structure(st, p.ext_pivot_window)

    h, l = df["high"].to_numpy(float), df["low"].to_numpy(float)
    ph, pl = pivots(h, l, p.entry_pivot_window)

    lq_ohlc = np.full((n, 4), np.nan)
    lq_start = np.full(n, -1, dtype=np.int64)
    ok = lq_known < n
    lq_ohlc[lq_known[ok]] = lq[["open", "high", "low", "close"]].to_numpy(float)[ok]
    lq_start[lq_known[ok]] = np.searchsorted(df.index.asi8, lq.index.asi8[ok], side="left")

    trail = {}
    for runner, ext in (("trail", False), ("trail_ext", True)):
        for side, m in (("hi", lv.side == 1), ("lo", lv.side == -1)):
            m = m & (lv.external == ext)
            order = np.argsort(lv.known[m], kind="stable")
            trail[(runner, side)] = (lv.known[m][order], lv.price[m][order])

    return Features(
        index=df.index,
        open=df["open"].to_numpy(float), high=h, low=l, close=df["close"].to_numpy(float),
        atr=to_base(atr(lq, p.atr_period).to_numpy(float), lq_known, n),
        lq_ohlc=lq_ohlc, lq_start=lq_start,
        struct=to_base(s_state, st_known, n, 0.0),
        struct_ref=to_base(s_ref, st_known, n),
        piv_hi=ph, piv_lo=pl,
        short_ev=build_events(lv, zones, n, 1, p.enable_sweep, p.enable_ob, p.sweep_levels == "external"),
        long_ev=build_events(lv, zones, n, -1, p.enable_sweep, p.enable_ob, p.sweep_levels == "external"),
        trail=trail,
    )


def _fmt(x: float) -> str:
    return f"{x:,.0f}" if abs(x) >= 1000 else f"{x:,.2f}"


def _candidate(f: Features, i: int, p: StrategyParams, side: str, pivot_window: int) -> Signal | None:
    short = side == "short"
    ev = f.short_ev if short else f.long_ev
    k = int(np.searchsorted(ev.idx, i, side="right")) - 1
    if k < 0 or ev.idx[k] < i - p.arm_bars:
        return None
    s, level = int(ev.idx[k]), float(ev.level[k])
    a = f.atr[i]
    if not np.isfinite(a) or a <= 0:
        return None
    seg = f.high[s:i + 1] if short else f.low[s:i + 1]
    e = s + int(np.argmax(seg) if short else np.argmin(seg))
    extreme = f.high[e] if short else f.low[e]
    depth = (extreme - level) if short else (level - extreme)
    if depth > p.sweep_max_atr * a:
        return None  # 함정이 아니라 돌파
    c = f.close
    inside = c[i] < level if short else c[i] > level
    if not inside:
        return None

    trigger = None
    if p.enable_pinbar and ev.kind[k] == 0 and f.lq_start[i] >= 0 and f.lq_start[i] <= s:
        o1, h1, l1, c1 = f.lq_ohlc[i]  # i 봉에서 마감된 유동성 봉이 훼손을 포함
        rng = h1 - l1
        wick = (h1 - max(o1, c1)) if short else (min(o1, c1) - l1)
        back = c1 < level if short else c1 > level
        if rng > 0 and back and wick / rng >= p.pinbar_wick:
            trigger = "pinbar"
    ref = np.nan
    if trigger is None and p.enable_choch:
        piv = f.piv_lo if short else f.piv_hi
        piv = piv[(piv < e) & (piv + pivot_window <= i)]
        if len(piv):
            j = piv[-1]
            ref = f.low[j] if short else f.high[j]
            crossed = c[i] < ref if short else c[i] > ref
            earlier = c[e:i]
            fresh = (earlier >= ref).all() if short else (earlier <= ref).all()
            if crossed and fresh:
                trigger = "choch"
    if trigger is None:
        return None

    buf = p.stop_buffer_atr * a
    entry = c[i]
    stop = extreme + buf if short else extreme - buf
    risk = abs(stop - entry)
    if not (p.min_stop_atr * a <= risk <= p.max_stop_atr * a):
        return None
    sign = -1 if short else 1
    tp1 = entry + sign * p.tp1_r * risk
    tp2 = entry + sign * p.tp2_r * risk if p.tp2_r > 0 else 0.0

    if ev.kind[k] == 0:
        where = f"{'외부' if ev.external[k] else '내부'} {'바이' if short else '셀'}사이드 유동성 {_fmt(level)} 훼손"
    else:
        where = f"{'서플라이' if short else '디맨드'} 존 {_fmt(ev.zone_low[k])}~{_fmt(ev.zone_high[k])} 터치"
    if trigger == "pinbar":
        how = f"유동성 봉 {'윗' if short else '밑'}꼬리 핀바로 안쪽 마감"
    else:
        how = f"내부 구조 {'하락' if short else '상승'} 전환({_fmt(ref)} {'이탈' if short else '돌파'} 마감)"
    st = {1: "상승", -1: "하락"}.get(int(f.struct[i]), "미정")
    reason = f"{where} → {how} | 4h 구조 {st}"
    return Signal(side, "sweep" if ev.kind[k] == 0 else "ob", trigger, float(entry), float(stop),
                  float(tp1), float(tp2), level, f.index[i], reason)


def generate_signal(f: Features, i: int, p: StrategyParams, allow_short: bool = True) -> Signal | None:
    """i 번째 봉 마감 시점의 진입 신호. 없으면 None."""
    cands = []
    for side in ("short", "long"):
        if side == "short" and not allow_short:
            continue
        if p.bias_mode == "structure" and f.struct[i] != (-1 if side == "short" else 1):
            continue
        sig = _candidate(f, i, p, side, p.entry_pivot_window)
        if sig:
            cands.append(sig)
    if not cands:
        return None
    return cands[0] if len(cands) == 1 else None  # 양방향 신호가 동시에 나오면 애매하므로 패스


def trail_stop(f: Features, i: int, side: str, current: float, p: StrategyParams) -> float | None:
    """남은 물량 손절을 i 봉까지 확정된 마지막 스윙(trail=1h, trail_ext=4h) 너머로 옮길 가격 (더 유리할 때만)."""
    if p.runner not in ("trail", "trail_ext"):
        return None
    known, price = f.trail[(p.runner, "lo" if side == "long" else "hi")]
    k = int(np.searchsorted(known, i, side="right")) - 1
    if k < 0 or not np.isfinite(f.atr[i]):
        return None
    buf = p.stop_buffer_atr * f.atr[i]
    c = f.close[i]
    if side == "long":
        new = price[k] - buf
        return new if current < new < c else None
    new = price[k] + buf
    return new if c < new < current else None
