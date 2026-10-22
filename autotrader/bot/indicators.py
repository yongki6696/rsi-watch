"""기술적 지표. 모두 '과거 데이터만' 쓰는 인과적(causal) 계산이다."""
from __future__ import annotations

import numpy as np
import pandas as pd
from numpy.lib.stride_tricks import sliding_window_view


def ema(series: pd.Series, period: int) -> pd.Series:
    return series.ewm(span=period, adjust=False, min_periods=period).mean()


def sma(series: pd.Series, period: int) -> pd.Series:
    return series.rolling(period, min_periods=period).mean()


def atr(df: pd.DataFrame, period: int) -> pd.Series:
    """Wilder ATR."""
    prev_close = df["close"].shift(1)
    tr = pd.concat(
        [
            df["high"] - df["low"],
            (df["high"] - prev_close).abs(),
            (df["low"] - prev_close).abs(),
        ],
        axis=1,
    ).max(axis=1)
    return tr.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()


def pivots(high: np.ndarray, low: np.ndarray, n: int) -> tuple[np.ndarray, np.ndarray]:
    """스윙 고점/저점 인덱스.

    j 가 피벗 고점 = high[j] 가 [j-n, j+n] 구간 최고가 (왼쪽 동률 허용, 오른쪽은 엄격히 큼).
    j 봉의 피벗 여부는 j+n 봉이 마감돼야 확정되므로, 사용하는 쪽에서
    'j + n <= 현재 알고 있는 마지막 봉' 조건으로 걸러야 미래 참조가 없다.
    """
    size = len(high)
    if size < 2 * n + 1:
        return np.array([], dtype=int), np.array([], dtype=int)
    hw = sliding_window_view(high, 2 * n + 1)
    lw = sliding_window_view(low, 2 * n + 1)
    hc, lc = hw[:, n], lw[:, n]
    is_ph = (hc >= hw[:, :n].max(axis=1)) & (hc > hw[:, n + 1 :].max(axis=1))
    is_pl = (lc <= lw[:, :n].min(axis=1)) & (lc < lw[:, n + 1 :].min(axis=1))
    return np.flatnonzero(is_ph) + n, np.flatnonzero(is_pl) + n


def volume_nodes(
    high: np.ndarray,
    low: np.ndarray,
    close: np.ndarray,
    volume: np.ndarray,
    bins: int,
    quantile: float,
) -> list[tuple[float, float]]:
    """매물대(High Volume Node) 가격과 상대 강도(0~1).

    대표가격 (H+L+C)/3 에 거래량을 쌓는 근사 볼륨 프로파일에서
    분위수 이상이면서 양옆보다 큰 봉우리만 고른다. POC(최대 매물대)는 강도 1.
    """
    if len(close) == 0:
        return []
    lo, hi = float(low.min()), float(high.max())
    if hi <= lo:
        return []
    typical = (high + low + close) / 3.0
    hist, edges = np.histogram(typical, bins=bins, range=(lo, hi), weights=volume)
    if hist.max() <= 0:
        return []
    centers = (edges[:-1] + edges[1:]) / 2
    cut = np.quantile(hist, quantile)
    padded = np.concatenate([[-np.inf], hist, [-np.inf]])
    peak = (hist >= padded[:-2]) & (hist > padded[2:]) & (hist >= cut) & (hist > 0)
    top = hist.max()
    return [(float(centers[k]), float(hist[k] / top)) for k in np.flatnonzero(peak)]
