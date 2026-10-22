import numpy as np

from bot.indicators import atr, pivots, volume_nodes
from bot.levels import cluster_levels, find_zones
from conftest import make_df


def test_atr_constant_range():
    df = make_df([(10, 11, 9, 10)] * 30)
    assert np.isclose(atr(df, 14).iloc[-1], 2.0)


def test_pivots_detect_swing_points():
    high = np.array([1, 2, 3, 9, 3, 2, 1, 2, 3, 4, 5], float)
    low = np.array([5, 4, 3, 2, 3, 4, 5, 4, 1, 4, 5], float)
    ph, pl = pivots(high, low, 2)
    assert list(ph) == [3]
    assert list(pl) == [3, 8]


def test_pivot_needs_right_side_confirmation():
    # 마지막 n 봉 안의 극값은 아직 피벗이 아니다
    high = np.array([1, 2, 3, 4, 5, 9, 1], float)
    ph, _ = pivots(high, high, 2)
    assert 5 not in ph


def test_volume_nodes_find_high_volume_price():
    n = 200
    close = np.linspace(100, 120, n)
    vol = np.ones(n)
    vol[90:110] = 50  # ~110 부근에 거래량 집중
    nodes = volume_nodes(close + 0.1, close - 0.1, close, vol, bins=40, quantile=0.8)
    poc = max(nodes, key=lambda x: x[1])
    assert 108 < poc[0] < 112 and poc[1] == 1.0


def test_cluster_merges_close_levels_and_filters_single_touch():
    zones = cluster_levels([(100.0, 1, 0), (100.4, 1, 0), (105.0, 1, 0), (110.0, 0, 0.9)], width=1.0,
                           min_touches=2)
    assert len(zones) == 2
    z = zones[0]
    assert z.low <= 100.0 and z.high >= 100.4 and z.touches == 2
    assert zones[1].volume_score == 0.9  # 매물대는 터치 수와 무관하게 인정


def test_find_zones_ignores_bars_at_or_after_end():
    rows = [(100, 101, 99, 100)] * 60
    df = make_df(rows)
    h, l, c, v = (df[k].to_numpy() for k in ("high", "low", "close", "volume"))
    ph, pl = pivots(h, l, 3)
    before = find_zones(h, l, c, v, ph, pl, 0, 40, 3, 1.0, 2, 20, 0.8)
    h2, l2 = h.copy(), l.copy()
    h2[40:] = 500
    l2[40:] = 1
    ph2, pl2 = pivots(h2, l2, 3)
    after = find_zones(h2, l2, c, v, ph2, pl2, 0, 40, 3, 1.0, 2, 20, 0.8)
    assert before == after
