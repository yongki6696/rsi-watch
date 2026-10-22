"""핵심 가격대(지지·저항 구간) 탐지.

스윙 고점/저점(여러 번 반응한 자리)과 매물대(거래량이 몰린 자리)를 후보로 모아
ATR 기반 폭 안에 있는 것끼리 하나의 '구간(zone)'으로 묶는다.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from .indicators import volume_nodes


@dataclass(frozen=True)
class Zone:
    low: float
    high: float
    touches: int        # 스윙 고점/저점 반응 횟수
    volume_score: float # 매물대 강도 합 (0이면 매물대 아님)

    @property
    def mid(self) -> float:
        return (self.low + self.high) / 2

    @property
    def strength(self) -> float:
        return self.touches + 3.0 * self.volume_score  # POC(1.0) 하나 = 터치 3회와 같은 무게


def cluster_levels(
    candidates: list[tuple[float, int, float]],
    width: float,
    min_touches: int,
) -> list[Zone]:
    """candidates: (가격, 터치 수, 매물대 강도). 가격 오름차순으로 탐욕적 클러스터링."""
    if not candidates or width <= 0:
        return []
    cands = sorted(candidates, key=lambda c: c[0])
    zones: list[Zone] = []
    group = [cands[0]]

    def flush(g):
        prices = [c[0] for c in g]
        touches = sum(c[1] for c in g)
        vol = sum(c[2] for c in g)
        if touches < min_touches and vol <= 0:
            return
        lo, hi = min(prices), max(prices)
        pad = max(0.0, 0.25 * width - (hi - lo)) / 2  # 너무 얇은 구간은 최소 폭 확보
        zones.append(Zone(lo - pad, hi + pad, touches, vol))

    for c in cands[1:]:
        if c[0] - group[-1][0] <= width and c[0] - group[0][0] <= 2 * width:
            group.append(c)
        else:
            flush(group)
            group = [c]
    flush(group)
    return zones


def find_zones(
    high: np.ndarray,
    low: np.ndarray,
    close: np.ndarray,
    volume: np.ndarray,
    pivot_hi: np.ndarray,
    pivot_lo: np.ndarray,
    start: int,
    end: int,
    pivot_window: int,
    width: float,
    min_touches: int,
    vp_bins: int,
    hvn_quantile: float,
) -> list[Zone]:
    """[start, end) 구간 봉만으로 가격대를 만든다 (end 봉 자체는 쓰지 않음).

    피벗은 j + pivot_window < end 인 것, 즉 end 이전에 확정된 것만 사용한다.
    """
    if end - start < 2 * pivot_window + 1:
        return []
    last_ok = end - 1 - pivot_window
    ph = pivot_hi[(pivot_hi >= start) & (pivot_hi <= last_ok)]
    pl = pivot_lo[(pivot_lo >= start) & (pivot_lo <= last_ok)]
    candidates: list[tuple[float, int, float]] = []
    candidates += [(float(high[j]), 1, 0.0) for j in ph]
    candidates += [(float(low[j]), 1, 0.0) for j in pl]
    sl = slice(start, end)
    for price, score in volume_nodes(high[sl], low[sl], close[sl], volume[sl], vp_bins, hvn_quantile):
        candidates.append((price, 0, score))
    return cluster_levels(candidates, width, min_touches)
