import numpy as np

from bot.config import config_from_dict
from bot.data import synthetic_ohlcv
from bot.strategy import compute_bias, generate_signal, prepare_features
from conftest import make_df, range_market


def _case(cfg, n, path, last_bar, allow_short=True):
    """n봉 박스권(지지 ~100, 저항 ~110) 뒤에 path 로 이동하고 마지막 봉 last_bar(o→OHLCV) 로 끝나는 시세."""
    rows = range_market(n)
    for c in path:
        o = rows[-1][3]
        rows.append((o, max(o, c) + 0.3, min(o, c) - 0.3, c, 100.0))
    o = rows[-1][3]
    rows.append((o, *last_bar(o)))
    df = make_df(rows)
    f = prepare_features(df, cfg)
    return generate_signal(f, len(df) - 1, cfg.strategy, allow_short)


def _long_sweep(cfg, sweep_low, close):
    # 박스 상단(n=106)에서 지지(100) 위로 급락한 뒤, 마지막 봉이 지지 아래를 찌르고 회복
    return _case(cfg, 106, [106.5, 103.5, 100.9], lambda o: (o + 0.2, sweep_low, close, 300.0))


def _short_sweep(cfg, allow_short=True):
    # 박스 하단(n=116)에서 저항(110) 아래로 급등한 뒤, 마지막 봉이 저항 위를 찌르고 이탈
    return _case(cfg, 116, [103.5, 106.5, 109.2], lambda o: (111.6, o - 0.2, 109.1, 300.0), allow_short)


def test_sweep_and_reclaim_gives_long(cfg):
    sig = _long_sweep(cfg, sweep_low=99.3, close=100.9)
    assert sig is not None
    assert sig.side == "long" and sig.setup == "sweep"
    assert sig.stop < 99.3 < sig.ref_price < sig.target
    assert sig.rr >= cfg.strategy.min_rr
    assert "스윕" in sig.reason


def test_close_below_support_is_breakdown_not_trap(cfg):
    assert _long_sweep(cfg, sweep_low=99.3, close=99.8) is None


def test_too_deep_sweep_is_ignored(cfg):
    assert _long_sweep(cfg, sweep_low=96.0, close=100.9) is None


def test_volume_filter_blocks_weak_sweep(cfg):
    cfg.strategy.volume_mult = 5.0
    assert _long_sweep(cfg, sweep_low=99.3, close=100.9) is None


def test_poor_reward_to_risk_is_skipped(cfg):
    # 꼬리가 깊어 손절폭이 커지면 다음 가격대(박스 중앙 매물대)까지 손익비가 안 나온다
    assert _long_sweep(cfg, sweep_low=98.4, close=100.9) is None


def test_strict_bias_blocks_trade_without_trend(cfg):
    assert _long_sweep(cfg, sweep_low=99.3, close=100.9) is not None
    cfg.strategy.bias_mode = "strict"  # EMA200 워밍업 전이라 방향 미정 → 진입 금지
    assert _long_sweep(cfg, sweep_low=99.3, close=100.9) is None


def test_short_sweep_and_spot_disallows_short(cfg):
    sig = _short_sweep(cfg)
    assert sig is not None and sig.side == "short" and sig.stop > 111.6 and sig.target < sig.ref_price
    assert _short_sweep(cfg, allow_short=False) is None


def test_breakout_retest_gives_long(cfg):
    cfg.strategy.enable_sweep = False
    # 박스 상단에서 저항(~110)을 돌파해 위에서 버티다가, 처음으로 저항 상단까지 되돌아와 지지
    sig = _case(cfg, 106, [111.5, 112.5, 113.0], lambda o: (o + 0.2, 110.1, 111.6, 100.0))
    assert sig is not None and sig.setup == "retest" and sig.side == "long"
    assert sig.stop < 108.1 and sig.target > sig.ref_price


def test_bias_uses_only_closed_higher_timeframe_bars():
    df = synthetic_ohlcv(3000, seed=3)
    full = compute_bias(df, "1h", "4h", 5, 20)
    cut = 2003  # 4시간봉 중간에서 자름
    part = compute_bias(df.iloc[: cut + 1], "1h", "4h", 5, 20)
    assert np.array_equal(full[: cut + 1], part, equal_nan=True)


def test_signals_have_no_lookahead():
    """i 시점 신호는 i 이후 데이터를 붙여도 바뀌면 안 된다 (백테스트 신뢰성의 핵심)."""
    cfg = config_from_dict({"timeframe": "1h", "bias_timeframe": "4h", "strategy": {
        "bias_mode": "loose", "volume_mult": 1.0, "level_lookback": 200, "ema_slow": 50}})
    df = synthetic_ohlcv(1500, seed=11)
    full = prepare_features(df, cfg)
    checked = 0
    for i in range(300, 1500, 7):
        a = generate_signal(full, i, cfg.strategy)
        part = prepare_features(df.iloc[: i + 1], cfg)
        b = generate_signal(part, i, cfg.strategy)
        assert (a is None) == (b is None), i
        if a is not None:
            checked += 1
            assert (a.side, a.setup) == (b.side, b.setup)
            assert np.isclose(a.stop, b.stop) and np.isclose(a.target, b.target)
    assert checked > 0


def test_only_first_retest_counts(cfg):
    cfg.strategy.enable_sweep = False
    # 돌파 후 이미 한 번 저항 상단까지 되돌아왔던 경우(112.5 → 110.2) 두 번째 리테스트는 무시
    rows_path = [111.5, 112.5, 110.4, 112.8]
    sig = _case(cfg, 106, rows_path, lambda o: (o + 0.2, 110.1, 111.6, 100.0))
    assert sig is None
