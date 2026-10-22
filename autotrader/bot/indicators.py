"""기술적 지표. 모두 '과거 데이터만' 쓰는 인과적(causal) 계산이다."""
from __future__ import annotations

import numpy as np
import pandas as pd
from numpy.lib.stride_tricks import sliding_window_view


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
