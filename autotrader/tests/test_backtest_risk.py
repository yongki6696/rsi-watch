import pandas as pd
import pytest

from bot import backtest
from bot.config import RiskParams
from bot.data import synthetic_ohlcv
from bot.risk import RiskManager
from bot.strategy import Signal
from bot.trade import Position, breakeven_price, check_exit, close_trade, entry_valid
from conftest import make_df


def _pos(side="long", entry=100.0, stop=95.0, target=110.0, qty=2.0):
    return Position(side, qty, entry, stop, target, stop, "2024-01-01T00:00:00+00:00")


def test_stop_first_when_both_hit_in_same_bar():
    assert check_exit(_pos(), 100, 111, 94) == (95.0, "stop")
    assert check_exit(_pos("short", 100, 105, 90), 100, 106, 89) == (105.0, "stop")


def test_gap_through_stop_fills_at_open():
    assert check_exit(_pos(), 93, 96, 92) == (93, "stop")


def test_target_hit():
    assert check_exit(_pos(), 100, 110.5, 99) == (110.0, "target")


def test_breakeven_move_and_label():
    p = _pos()
    assert breakeven_price(p, 104, 99, 1.0) is None
    assert breakeven_price(p, 105, 99, 1.0) == 100.0
    p.stop = 100.0
    assert close_trade(p, 100.0, "stop", "t", 0.0)["reason"] == "breakeven"


def test_close_trade_pnl_and_r_with_fees():
    p = _pos(qty=2.0)
    p.entry_fee = 0.2
    tr = close_trade(p, 110.0, "target", "t", 0.001)
    assert tr["pnl"] == pytest.approx(20 - 0.2 - 0.22)
    assert tr["r"] == pytest.approx(tr["pnl"] / 10)


def test_entry_valid_rechecks_rr_at_fill_price():
    assert entry_valid("long", 100, 95, 110, 1.5)
    assert not entry_valid("long", 103, 95, 110, 1.5)  # 많이 올라 손익비 부족
    assert not entry_valid("long", 94, 95, 110, 1.5)   # 이미 손절가 아래


def test_position_size_risks_fixed_fraction_and_caps_leverage():
    rm = RiskManager(RiskParams(risk_per_trade=0.01, max_leverage=3), "UTC", 3)
    assert rm.size(10_000, 100, 95) == pytest.approx(20)       # 100 / 5
    assert rm.size(10_000, 100, 99.9) == pytest.approx(300)    # 레버리지 3배 상한


def test_daily_loss_limit_and_streak_block_until_next_day():
    rm = RiskManager(RiskParams(daily_loss_limit=0.03, max_consecutive_losses=2), "Asia/Seoul", 3)
    t = pd.Timestamp("2024-01-01T01:00", tz="UTC")
    rm.roll_day(t, 10_000)
    rm.on_trade_closed(-100)
    assert rm.can_trade()
    rm.on_trade_closed(-100)
    assert not rm.can_trade()  # 2연패
    rm.roll_day(t + pd.Timedelta(hours=1), 9_800)
    assert not rm.can_trade()  # 같은 날(KST)
    rm.roll_day(t + pd.Timedelta(days=1), 9_800)
    assert rm.can_trade()
    rm.on_trade_closed(-300)
    assert not rm.can_trade()  # 하루 3% 초과


def test_backtest_executes_next_open_and_books_pnl(cfg, monkeypatch):
    rows = [(100, 101, 99, 100)] * 10 + [(100, 101, 99, 100), (100.5, 112, 100, 111)] + [(111, 112, 110, 111)] * 3
    df = make_df(rows)
    fired = {"done": False}

    def fake_signal(f, i, p, allow_short=True):
        if i == 10 and not fired["done"]:
            fired["done"] = True
            return Signal("long", "sweep", 100, 95, 110, 2.0, 99, 100, f.index[i], "test")
        return None

    monkeypatch.setattr(backtest, "generate_signal", fake_signal)
    res = backtest.run_backtest(df, cfg)
    assert len(res.trades) == 1
    tr = res.trades.iloc[0]
    assert tr["entry"] == 100.5 and tr["exit"] == 110 and tr["reason"] == "target"
    qty = cfg.initial_equity * cfg.risk.risk_per_trade / (100.5 - 95)
    assert tr["pnl"] == pytest.approx(qty * 9.5)
    assert res.equity.iloc[-1] == pytest.approx(cfg.initial_equity + qty * 9.5)


def test_backtest_runs_on_synthetic_data():
    from bot.config import config_from_dict

    res = backtest.run_backtest(synthetic_ohlcv(3000, seed=5, timeframe="4h"), config_from_dict({}))
    assert res.stats["거래 수"] == len(res.trades)
    if len(res.trades):
        # 한 번 손실은 대략 1R(=자산의 1%) 근처를 넘지 않아야 함 (수수료·슬리피지·갭 감안)
        assert res.trades["r"].min() > -1.5
