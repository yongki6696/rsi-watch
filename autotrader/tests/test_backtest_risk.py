import pandas as pd
import pytest

from bot import backtest
from bot.config import CostParams, RiskParams, config_from_dict
from bot.data import synthetic_ohlcv
from bot.risk import RiskManager
from bot.strategy import Signal
from bot.trade import apply_exit, new_position, plan_exits, trade_record
from conftest import make_df


def _pos(side="long", entry=100.0, stop=95.0, tp1=110.0, tp2=0.0, qty=2.0, frac=0.5):
    return new_position(side, qty, entry, stop, tp1, tp2, frac, "2024-01-01T00:00:00+00:00", "t", 0.0)


def _plan(pos, o, h, l):
    return [(e.price, e.qty, e.reason) for e in plan_exits(pos, o, h, l)]


def test_stop_first_when_stop_and_tp1_in_same_bar():
    assert _plan(_pos(), 100, 111, 94) == [(95.0, 2.0, "stop")]
    assert _plan(_pos("short", 100, 105, 90), 100, 106, 89) == [(105.0, 2.0, "stop")]


def test_tp1_then_breakeven_in_same_bar_is_conservative():
    assert _plan(_pos(), 100, 111, 99) == [(110.0, 1.0, "tp1"), (100.0, 1.0, "breakeven")]


def test_tp1_only_moves_stop_to_breakeven():
    pos = _pos()
    exits = plan_exits(pos, 100, 111, 101)
    assert [(e.price, e.qty, e.reason) for e in exits] == [(110.0, 1.0, "tp1")]
    pnl = apply_exit(pos, exits[0], 110.0, 0.0)
    assert pnl == pytest.approx(10.0)
    assert pos.qty == 1.0 and pos.tp1_done and pos.stop == 100.0


def test_gaps_and_final_target():
    assert _plan(_pos(), 93, 96, 92) == [(93, 2.0, "stop")]
    assert _plan(_pos(tp2=120.0), 100, 121, 101) == [(110.0, 1.0, "tp1"), (120.0, 1.0, "tp2")]
    assert _plan(_pos(tp2=120.0), 125, 126, 124) == [(125, 1.0, "tp1"), (125, 1.0, "tp2")]


def test_plan_does_not_mutate_position():
    pos = _pos()
    plan_exits(pos, 100, 111, 99)
    assert pos.qty == 2.0 and not pos.tp1_done and pos.stop == 95.0


def test_trade_record_r_multiple_includes_partial_and_fees():
    pos = new_position("long", 2.0, 100.0, 95.0, 110.0, 0.0, 0.5, "t0", "sweep/choch", entry_fee=0.2)
    for ex in plan_exits(pos, 100, 111, 101):
        apply_exit(pos, ex, ex.price, 0.0002)
    for ex in plan_exits(pos, 105, 106, 99):
        last = ex
        apply_exit(pos, ex, ex.price, 0.0005)
    tr = trade_record(pos, last, last.price, "t1")
    expected = 10.0 - 110 * 0.0002 - 100 * 0.0005 - 0.2
    assert tr["reason"] == "breakeven" and tr["tp1_done"]
    assert tr["pnl"] == pytest.approx(expected)
    assert tr["r"] == pytest.approx(expected / 10.0)


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


def test_backtest_partial_then_breakeven(cfg, monkeypatch):
    cfg.strategy.runner = "hold"
    rows = [(100, 101, 99, 100)] * 11 + [(100.5, 108, 101, 107), (107, 107.5, 100.3, 101)] + [(101, 102, 100, 101)] * 2
    df = make_df(rows)

    def fake_signal(f, i, p, allow_short=True):
        if i == 10:
            return Signal("long", "sweep", "pinbar", 100, 95, 107.5, 0.0, 99, f.index[i], "test")
        return None

    monkeypatch.setattr(backtest, "generate_signal", fake_signal)
    res = backtest.run_backtest(df, cfg)
    assert len(res.trades) == 1
    tr = res.trades.iloc[0]
    qty = cfg.initial_equity * cfg.risk.risk_per_trade / (100.5 - 95)
    assert tr["entry"] == 100.5 and tr["tp1_done"] and tr["reason"] == "breakeven"
    assert tr["pnl"] == pytest.approx(qty / 2 * 7.0)
    assert res.equity.iloc[-1] == pytest.approx(cfg.initial_equity + qty / 2 * 7.0)


def test_backtest_runs_on_synthetic_data():
    res = backtest.run_backtest(synthetic_ohlcv(3000, seed=5, timeframe="15m"), config_from_dict({}))
    assert res.stats["거래 수"] == len(res.trades)
    if len(res.trades):
        # 한 번 손실은 1R(=자산의 1%) 근처를 크게 넘지 않아야 함 (수수료·슬리피지·갭 감안)
        assert res.trades["r"].min() > -1.6


def test_costs_default_maker_cheaper_than_taker():
    c = CostParams()
    assert c.maker_fee_rate < c.fee_rate


def test_limit_entry_fills_only_when_price_trades_through(cfg, monkeypatch):
    cfg.strategy.entry_mode = "limit"
    cfg.strategy.runner = "hold"
    rows = ([(100, 101, 99, 100)] * 11
            + [(100.5, 101, 100.0, 100.8),   # 저가가 지정가(100)에 '닿기만' → 미체결
               (100.8, 101, 99.5, 100.6),    # 100 아래로 뚫음 → 100 에 체결, 이 봉에선 익절 안 봄
               (100.6, 108, 100.2, 107)]     # 1차 익절
            + [(107, 107.5, 99.8, 100.5)] * 2)
    df = make_df(rows)

    def fake_signal(f, i, p, allow_short=True):
        if i == 10:
            return Signal("long", "sweep", "choch", 100, 95, 107.5, 0.0, 99, f.index[i], "test")
        return None

    monkeypatch.setattr(backtest, "generate_signal", fake_signal)
    tr = backtest.run_backtest(df, cfg).trades.iloc[0]
    assert tr["entry"] == 100 and tr["opened_at"].startswith(str(df.index[12].date()))
    assert pd.Timestamp(tr["opened_at"]) == df.index[12]
    assert tr["tp1_done"] and tr["reason"] == "breakeven"


def test_limit_entry_expires_when_target_hit_first(cfg, monkeypatch):
    cfg.strategy.entry_mode = "limit"
    rows = [(100, 101, 99, 100)] * 11 + [(100.5, 108, 100.2, 107)] + [(107, 107.5, 98, 99)] * 3
    df = make_df(rows)

    def fake_signal(f, i, p, allow_short=True):
        if i == 10:
            return Signal("long", "sweep", "choch", 100, 95, 107.5, 0.0, 99, f.index[i], "test")
        return None

    monkeypatch.setattr(backtest, "generate_signal", fake_signal)
    assert backtest.run_backtest(df, cfg).trades.empty  # 체결 전에 목표 도달 → 기회 놓침
