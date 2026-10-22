import numpy as np
import pandas as pd

from bot.config import config_from_dict
from bot.data import synthetic_ohlcv
from bot.indicators import atr, pivots
from bot.smc import order_blocks, structure
from bot.strategy import generate_signal, prepare_features
from conftest import make_df, mirror, swing_high_prefix


def _signal(cfg, rows):
    df = make_df(rows)
    f = prepare_features(df, cfg)
    return generate_signal(f, len(df) - 1, cfg.strategy)


def _pinbar_rows(spike_high=105.8, close=102.0):
    rows = swing_high_prefix()
    c = rows[-1][3]
    for n in (101.6, 101.2, 101.8, 101.4):  # 고점 아래에서 횡보
        rows.append((c, max(c, n) + 0.2, min(c, n) - 0.2, n))
        c = n
    rows.append((c, spike_high, c - 0.2, close))  # 고점 위를 찌르고 아래로 마감
    return rows


def _choch_rows(last_close=101.3):
    rows = swing_high_prefix()
    rows += [
        (101.0, 101.9, 100.9, 101.8),
        (101.8, 102.8, 101.6, 102.6),
        (102.6, 103.6, 102.4, 103.2),
        (103.2, 103.3, 101.5, 101.8),   # 내부 구조 저점 101.5
        (101.8, 103.0, 101.7, 102.9),
        (102.9, 104.2, 102.7, 104.0),
        (104.0, 104.9, 103.8, 104.7),
        (104.7, 105.7, 104.5, 105.4),   # 105.2 고점 훼손 (핀바 아님, 위에서 마감)
        (105.4, 105.5, 103.9, 104.1),
        (104.1, 104.3, 102.0, 102.3),
        (102.3, 102.5, 101.2, last_close),  # 101.5 이탈 마감 → 내부 구조 하락 전환
    ]
    return rows


def test_sweep_then_pinbar_gives_short(cfg):
    sig = _signal(cfg, _pinbar_rows())
    assert sig is not None
    assert (sig.side, sig.setup, sig.trigger) == ("short", "sweep", "pinbar")
    assert sig.level == 105.2 and sig.stop > 105.8
    assert sig.tp1 < sig.ref_price
    assert np.isclose(sig.ref_price - sig.tp1, cfg.strategy.tp1_r * (sig.stop - sig.ref_price))
    assert "바이사이드" in sig.reason and "핀바" in sig.reason


def test_weak_wick_is_not_a_pinbar(cfg):
    assert _signal(cfg, _pinbar_rows(spike_high=105.4, close=105.1)) is None


def test_too_deep_sweep_is_breakout_not_trap(cfg):
    assert _signal(cfg, _pinbar_rows(spike_high=112.0, close=104.0)) is None


def test_sweep_then_internal_structure_shift_gives_short(cfg):
    sig = _signal(cfg, _choch_rows())
    assert sig is not None
    assert (sig.side, sig.trigger) == ("short", "choch")
    assert sig.stop > 105.7
    assert "101.50 이탈" in sig.reason


def test_structure_shift_needs_close_beyond_swing(cfg):
    assert _signal(cfg, _choch_rows(last_close=101.6)) is None


def test_structure_shift_only_fires_on_first_cross(cfg):
    rows = _choch_rows()
    rows.append((101.3, 101.4, 100.6, 100.9))  # 이미 전환된 뒤 다음 봉
    assert _signal(cfg, rows) is None


def test_mirrored_scenarios_give_longs(cfg):
    sig = _signal(cfg, mirror(_pinbar_rows()))
    assert sig is not None and (sig.side, sig.trigger) == ("long", "pinbar") and sig.stop < 300 - 105.8
    sig = _signal(cfg, mirror(_choch_rows()))
    assert sig is not None and (sig.side, sig.trigger) == ("long", "choch")
    assert "셀사이드" in sig.reason


def test_spot_and_bias_filters(cfg):
    df = make_df(_pinbar_rows())
    f = prepare_features(df, cfg)
    assert generate_signal(f, len(df) - 1, cfg.strategy, allow_short=False) is None
    cfg.strategy.bias_mode = "structure"
    f.struct[:] = 1  # 4h 상승 구조면 숏 금지
    assert generate_signal(f, len(df) - 1, cfg.strategy) is None
    f.struct[:] = -1
    assert generate_signal(f, len(df) - 1, cfg.strategy) is not None


def test_stop_size_limits(cfg):
    cfg.strategy.max_stop_atr = 0.5  # 손절폭이 너무 넓으면 패스
    assert _signal(cfg, _pinbar_rows()) is None


def test_structure_state_and_reference_price():
    # 고점 돌파 → 상승 구조, 기준 가격(출발 저점) 이탈 → 하락 구조
    rows = [(10.5, 11, 10, 10.8), (10.8, 13, 11, 12.5), (12.5, 12.6, 10.5, 11.0),
            (11.0, 14, 11.5, 13.8), (13.8, 15, 12.5, 14.5), (14.5, 14.6, 12, 12.5),
            (12.5, 16, 13, 15.8), (15.8, 15.9, 10, 10.2)]
    state, ref = structure(make_df(rows, freq="4h"), 1)
    assert state[3] == 1 and ref[3] == 10.5     # 13 돌파: 기준 = 다리 출발 저점 10.5
    assert state[6] == 1 and ref[6] == 12       # 15 돌파(BOS): 기준이 12 로 올라감
    assert state[7] == -1 and ref[7] == 16      # 12 이탈(CHoCH): 하락 구조, 기준 = 고점 16


def test_order_block_is_last_opposite_candle_before_impulse():
    rows = [(100, 100.6, 99.6, 100.2) if k % 2 else (100.2, 100.7, 99.7, 100) for k in range(20)]
    rows += [(100, 100.4, 98.9, 99.2),      # 스윙 저점 98.9
             (99.2, 100.8, 99.1, 100.6),
             (100.6, 101.5, 100.4, 101.3),  # 마지막 양봉 = 오더블록 100.4~101.5
             (101.3, 101.4, 96.0, 96.5),    # 장대 음봉: 98.9 이탈 = 임펄스
             (96.5, 97.5, 96.2, 97.3),
             (97.3, 100.9, 97.1, 100.5)]    # 서플라이 존 터치
    df = make_df(rows, freq="4h")
    z = order_blocks(df, "4h", df, "4h", 1, 1.5, 180, 14)
    assert list(z.side) == [1]
    assert (z.low[0], z.high[0]) == (100.4, 101.5)
    assert z.touched[0] == len(rows) - 1


def test_signals_have_no_lookahead():
    """i 시점 신호는 i 이후 데이터를 붙여도 바뀌면 안 된다 (백테스트 신뢰성의 핵심)."""
    cfg = config_from_dict({"strategy": {"min_stop_atr": 0.3}})
    df = synthetic_ohlcv(4000, seed=11, timeframe="15m")
    full = prepare_features(df, cfg)
    checked = 0
    for i in range(600, 4000, 3):
        a = generate_signal(full, i, cfg.strategy)
        if a is None and i % 30:
            continue
        part = prepare_features(df.iloc[: i + 1], cfg)
        b = generate_signal(part, i, cfg.strategy)
        assert (a is None) == (b is None), i
        if a is not None:
            checked += 1
            assert (a.side, a.setup, a.trigger) == (b.side, b.setup, b.trigger)
            assert np.isclose(a.stop, b.stop) and np.isclose(a.tp1, b.tp1)
    assert checked >= 5


def test_atr_and_pivots():
    df = make_df([(10, 11, 9, 10)] * 30)
    assert np.isclose(atr(df, 14).iloc[-1], 2.0)
    high = np.array([1, 2, 3, 9, 3, 2, 1, 2, 3, 4, 5], float)
    low = np.array([5, 4, 3, 2, 3, 4, 5, 4, 1, 4, 5], float)
    ph, pl = pivots(high, low, 2)
    assert list(ph) == [3] and list(pl) == [3, 8]
    assert isinstance(df.index, pd.DatetimeIndex)
