"""매매 규칙.

  1) 중기 방향(상위 TF)  : 4시간봉 EMA50/EMA200 + 종가 위치로 상승/하락/중립 판단
  2) 핵심 가격대         : 스윙 고점·저점 + 매물대를 묶은 지지·저항 구간 (levels.py)
  3) 셋업 A - 함정(스윕) : 지지 구간 아래를 꼬리로 찌르고(손절 물량 사냥) 다시 구간 위로 마감 → 롱
                           저항 구간 위를 찌르고 다시 아래로 마감 → 숏
  4) 셋업 B - 리테스트   : 저항 돌파 후 처음 되돌아와 지지 확인 → 롱 (숏은 반대)
  5) 손절은 꼬리/구간 바깥, 목표는 다음 반대편 가격대. 손익비 min_rr 미만이면 진입 안 함.

신호는 i 번째 봉이 '마감된 뒤' 그 봉까지의 정보만으로 계산하고, 진입은 다음 봉 시가다.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .config import Config, StrategyParams
from .indicators import atr, ema, pivots, sma
from .levels import Zone, find_zones
from .timeframes import timeframe_seconds


@dataclass
class Signal:
    side: str          # long | short
    setup: str         # sweep | retest
    ref_price: float   # 신호 봉 종가 (실제 진입은 다음 봉 시가 근처)
    stop: float
    target: float
    rr: float
    zone_low: float
    zone_high: float
    bar_time: pd.Timestamp
    reason: str


@dataclass
class Features:
    index: pd.DatetimeIndex
    open: np.ndarray
    high: np.ndarray
    low: np.ndarray
    close: np.ndarray
    volume: np.ndarray
    atr: np.ndarray
    vol_sma: np.ndarray
    bias: np.ndarray      # +1 상승 / -1 하락 / 0 중립 / nan 워밍업
    pivot_hi: np.ndarray
    pivot_lo: np.ndarray


def compute_bias(df: pd.DataFrame, timeframe: str, bias_timeframe: str, fast: int, slow: int) -> np.ndarray:
    """상위 타임프레임 방향을 하위 봉마다 매핑. 마감된 상위 봉만 사용한다."""
    ltf = pd.Timedelta(seconds=timeframe_seconds(timeframe))
    htf = pd.Timedelta(seconds=timeframe_seconds(bias_timeframe))
    closes = df["close"].resample(htf, origin="epoch", label="left", closed="left").last().dropna()
    ef, es = ema(closes, fast), ema(closes, slow)
    up = (closes > es) & (ef > es)
    down = (closes < es) & (ef < es)
    bias = np.where(up, 1.0, np.where(down, -1.0, 0.0))
    bias[es.isna().to_numpy()] = np.nan
    htf_frame = pd.DataFrame({"t": closes.index + htf, "bias": bias})
    ltf_frame = pd.DataFrame({"t": df.index + ltf})
    merged = pd.merge_asof(ltf_frame, htf_frame, on="t", direction="backward")
    return merged["bias"].to_numpy(dtype=float)


def prepare_features(df: pd.DataFrame, cfg: Config) -> Features:
    p = cfg.strategy
    ph, pl = pivots(df["high"].to_numpy(float), df["low"].to_numpy(float), p.pivot_window)
    return Features(
        index=df.index,
        open=df["open"].to_numpy(float),
        high=df["high"].to_numpy(float),
        low=df["low"].to_numpy(float),
        close=df["close"].to_numpy(float),
        volume=df["volume"].to_numpy(float),
        atr=atr(df, p.atr_period).to_numpy(float),
        vol_sma=sma(df["volume"], p.volume_sma).to_numpy(float),
        bias=compute_bias(df, cfg.timeframe, cfg.bias_timeframe, p.ema_fast, p.ema_slow),
        pivot_hi=ph,
        pivot_lo=pl,
    )


def _bias_ok(side: str, b: float, mode: str) -> bool:
    if mode == "off":
        return True
    if np.isnan(b):
        return False
    if mode == "strict":
        return b == (1.0 if side == "long" else -1.0)
    return b >= 0 if side == "long" else b <= 0


def _volume_ok(f: Features, j: int, p: StrategyParams) -> bool:
    if p.volume_mult <= 0:
        return True
    return bool(np.isfinite(f.vol_sma[j]) and f.volume[j] >= p.volume_mult * f.vol_sma[j])


def _plan(side, setup, f, i, stop, zone, zones, p, reason) -> Signal | None:
    entry = f.close[i]
    risk = entry - stop if side == "long" else stop - entry
    if risk <= 0:
        return None
    key = [z for z in zones if z.strength >= p.target_min_strength]
    if side == "long":
        above = [z.low for z in key if z.low > max(entry, zone.high)]
        target = min(above) if above else entry + p.fallback_rr * risk
    else:
        below = [z.high for z in key if z.high < min(entry, zone.low)]
        target = max(below) if below else entry - p.fallback_rr * risk
    rr = abs(target - entry) / risk
    if rr < p.min_rr:
        return None
    return Signal(side, setup, float(entry), float(stop), float(target), float(rr),
                  zone.low, zone.high, f.index[i], reason)


def _fmt(x: float) -> str:
    return f"{x:,.2f}" if x < 1000 else f"{x:,.0f}"


def _sweep_signals(f: Features, i: int, zones: list[Zone], p: StrategyParams, a: float) -> list[Signal]:
    k = p.sweep_clean_bars
    rng = f.high[i] - f.low[i]
    if i < k or rng <= 0 or not _volume_ok(f, i, p):
        return []
    close_pos = (f.close[i] - f.low[i]) / rng
    prev = f.close[i - k : i]
    vol_x = f.volume[i] / f.vol_sma[i] if f.vol_sma[i] > 0 else float("nan")
    out = []
    for z in zones:
        depth = z.low - f.low[i]
        if (p.sweep_min_atr * a <= depth <= p.sweep_max_atr * a and f.close[i] > z.low
                and close_pos >= p.reclaim_close_pos and prev.min() > z.low):
            reason = (f"지지 {_fmt(z.low)}~{_fmt(z.high)} 아래 유동성 스윕 후 회복 "
                      f"(깊이 {depth / a:.2f} ATR, 거래량 {vol_x:.1f}배)")
            s = _plan("long", "sweep", f, i, f.low[i] - p.stop_buffer_atr * a, z, zones, p, reason)
            if s:
                out.append(s)
        depth = f.high[i] - z.high
        if (p.sweep_min_atr * a <= depth <= p.sweep_max_atr * a and f.close[i] < z.high
                and (1 - close_pos) >= p.reclaim_close_pos and prev.max() < z.high):
            reason = (f"저항 {_fmt(z.low)}~{_fmt(z.high)} 위 유동성 스윕 후 이탈 "
                      f"(깊이 {depth / a:.2f} ATR, 거래량 {vol_x:.1f}배)")
            s = _plan("short", "sweep", f, i, f.high[i] + p.stop_buffer_atr * a, z, zones, p, reason)
            if s:
                out.append(s)
    return out


def _retest_signals(f: Features, i: int, zones: list[Zone], p: StrategyParams, a: float) -> list[Signal]:
    tol = p.retest_tolerance_atr * a
    buf = p.stop_buffer_atr * a
    first = max(1, i - p.retest_window)
    c, h, l = f.close, f.high, f.low
    out = []
    for z in zones:
        # 롱: 저항 상향 돌파 → 처음 되돌아와 구간 위에서 지지
        for j in range(i - 1, first - 1, -1):
            if c[j] > z.high and c[j - 1] <= z.high:
                held = (c[j:i] > z.high).all() and (l[j + 1 : i] > z.high + tol).all()
                if (held and _volume_ok(f, j, p) and l[i] <= z.high + tol
                        and c[i] > z.high and l[i] > z.low - buf):
                    reason = f"저항 {_fmt(z.low)}~{_fmt(z.high)} 돌파({i - j}봉 전) 후 첫 리테스트 지지"
                    s = _plan("long", "retest", f, i, min(l[i], z.low) - buf, z, zones, p, reason)
                    if s:
                        out.append(s)
                break
        # 숏: 지지 하향 이탈 → 처음 되돌아와 구간 아래에서 저항
        for j in range(i - 1, first - 1, -1):
            if c[j] < z.low and c[j - 1] >= z.low:
                held = (c[j:i] < z.low).all() and (h[j + 1 : i] < z.low - tol).all()
                if (held and _volume_ok(f, j, p) and h[i] >= z.low - tol
                        and c[i] < z.low and h[i] < z.high + buf):
                    reason = f"지지 {_fmt(z.low)}~{_fmt(z.high)} 이탈({i - j}봉 전) 후 첫 리테스트 저항"
                    s = _plan("short", "retest", f, i, max(h[i], z.high) + buf, z, zones, p, reason)
                    if s:
                        out.append(s)
                break
    return out


def warmup_bars(p: StrategyParams) -> int:
    return max(p.atr_period, p.volume_sma, 2 * p.pivot_window + 1, p.sweep_clean_bars) + 1


def generate_signal(f: Features, i: int, p: StrategyParams, allow_short: bool = True) -> Signal | None:
    """i 번째 봉 마감 시점의 진입 신호. 없으면 None."""
    if i < warmup_bars(p):
        return None
    a = f.atr[i]
    if not np.isfinite(a) or a <= 0:
        return None
    start = max(0, i - p.level_lookback)
    zones = find_zones(f.high, f.low, f.close, f.volume, f.pivot_hi, f.pivot_lo, start, i,
                       p.pivot_window, p.zone_width_atr * a, p.min_touches, p.vp_bins, p.hvn_quantile)
    if not zones:
        return None
    cands: list[Signal] = []
    if p.enable_sweep:
        cands += _sweep_signals(f, i, zones, p, a)
    if p.enable_retest:
        cands += _retest_signals(f, i, zones, p, a)
    cands = [s for s in cands
             if (allow_short or s.side == "long") and _bias_ok(s.side, f.bias[i], p.bias_mode)]
    if not cands:
        return None
    return max(cands, key=lambda s: s.rr)
