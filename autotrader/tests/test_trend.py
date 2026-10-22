import numpy as np
import pandas as pd
import pytest

from bot import live
from bot.broker import CcxtBroker, PaperBroker
from bot.config import config_from_dict
from bot.data import synthetic_ohlcv
from bot.strategy import Signal
from bot.trend import decide, next_stop, run_trend_backtest, trend_levels
from conftest import make_df
from test_live_broker import FakeHyperliquid, Silent


def _daily(closes, spread=1.0):
    rows, prev = [], closes[0]
    for c in closes:
        rows.append((prev, max(prev, c) + spread, min(prev, c) - spread, c))
        prev = c
    return make_df(rows, start="2024-01-01", freq="1D")


def _cfg(**trend):
    return config_from_dict({"symbol": "BTC/USDC:USDC", "exchange": {"id": "hyperliquid"},
                             "trend": {"atr_period": 5, **trend},
                             "costs": {"fee_rate": 0, "maker_fee_rate": 0, "slippage": 0, "funding_apr": 0}})


# 30일 횡보(99~101) → 돌파 → 상승 → 하락 이탈
CLOSES = [100 + (k % 3 - 1) for k in range(30)] + [104, 106, 108, 110, 109, 111, 112] + [105, 100, 96, 94]


def test_decide_breakout_and_exit():
    cfg = _cfg()
    lv = trend_levels(_daily(CLOSES), cfg.trend)
    assert decide(lv, 29, None, cfg.trend) is None
    assert decide(lv, 30, None, cfg.trend) == "long"          # 104 > 직전 20일 최고가 102
    assert decide(lv, 36, "long", cfg.trend) is None
    first_exit = next(i for i in range(31, len(CLOSES)) if decide(lv, i, "long", cfg.trend) == "exit")
    assert CLOSES[first_exit] < min(CLOSES[first_exit - 10:first_exit]) - 1  # 직전 10일 최저가 아래
    assert decide(lv, 30, "long", cfg.trend) is None


def test_short_only_when_allowed():
    cfg = _cfg()
    lv = trend_levels(_daily([100 + (k % 3 - 1) for k in range(30)] + [95]), cfg.trend)
    assert decide(lv, 30, None, cfg.trend) is None
    cfg = _cfg(allow_short=True)
    assert decide(lv, 30, None, cfg.trend) == "short"


def test_emergency_stop_only_moves_in_favor():
    cfg = _cfg(disaster_stop_atr=2.0)
    lv = trend_levels(_daily(CLOSES), cfg.trend)
    s1 = next_stop(lv, 33, "long", None)
    assert s1 < min(CLOSES[24:34])
    assert next_stop(lv, 34, "long", s1 + 100) == s1 + 100  # 내려가지 않음


def test_trend_levels_have_no_lookahead():
    cfg = _cfg()
    df = synthetic_ohlcv(400, seed=3, timeframe="1d")
    full = trend_levels(df, cfg.trend)
    for i in (50, 120, 399):
        part = trend_levels(df.iloc[: i + 1], cfg.trend)
        for name in ("entry_hi", "entry_lo", "exit_hi", "exit_lo", "stop_lo"):
            assert np.isclose(getattr(full, name)[i], getattr(part, name)[i], equal_nan=True), (name, i)


def test_backtest_enters_next_open_exits_on_signal_and_charges_funding():
    df = _daily(CLOSES)
    cfg = _cfg(disaster_stop_atr=0)
    r = run_trend_backtest(df, cfg)
    tr = r.trades.iloc[0]
    assert pd.Timestamp(tr["opened_at"]) == df.index[31] and tr["entry"] == df["open"].iloc[31]
    assert tr["reason"] == "signal"
    qty = cfg.initial_equity / tr["entry"]
    assert tr["pnl"] == pytest.approx(qty * (tr["exit"] - tr["entry"]))

    cfg_f = _cfg(disaster_stop_atr=0)
    cfg_f.costs.funding_apr = 0.365  # 하루 0.1%
    tr_f = run_trend_backtest(df, cfg_f).trades.iloc[0]
    days = (pd.Timestamp(tr_f["closed_at"]) - pd.Timestamp(tr_f["opened_at"])).days
    assert tr_f["pnl"] < tr["pnl"]
    assert tr["pnl"] - tr_f["pnl"] == pytest.approx(days * 0.001 * qty * 108, rel=0.15)


def test_backtest_emergency_stop_on_crash():
    closes = CLOSES[:37]
    df = _daily(closes)
    crash = pd.DataFrame([(112, 112.5, 60, 62, 100.0)], columns=df.columns,
                         index=[df.index[-1] + pd.Timedelta(days=1)])
    df = pd.concat([df, crash])
    r = run_trend_backtest(df, _cfg(disaster_stop_atr=2.0))
    tr = r.trades.iloc[0]
    assert tr["reason"] == "emergency_stop" and tr["exit"] > 62


# ── 실시간: 추세추종 자동매매 ──

class DailyFeed:
    def __init__(self, df):
        self.df, self.i, self.price = df, 31, None  # i 번째 봉이 진행 중

    def recent(self, n):
        return self.df.iloc[max(0, self.i + 1 - n): self.i + 1]

    def now_ms(self):
        return int((self.df.index[self.i] + pd.Timedelta(minutes=1)).timestamp() * 1000)

    def last_price(self):
        return self.price or float(self.df["open"].iloc[self.i])


@pytest.fixture
def trend_setup(tmp_path):
    cfg = _cfg()
    feed = DailyFeed(_daily(CLOSES))
    state = tmp_path / "trend.json"
    trader = live.TrendTrader(cfg, feed, PaperBroker(cfg), state, Silent())
    return cfg, feed, trader, state


def test_trend_trader_enters_on_breakout_and_persists(trend_setup):
    cfg, feed, trader, state = trend_setup
    trader.step()  # 30번째 일봉(104) 마감 직후
    pos = trader.pos
    assert pos is not None and pos.side == "long" and pos.setup == "trend/breakout"
    assert pos.qty == pytest.approx(cfg.initial_equity / feed.last_price())
    assert 0 < pos.stop < pos.entry and pos.tp1_qty == 0
    trader.step()
    assert trader.pos.entry == pos.entry  # 같은 날 중복 진입 없음
    again = live.TrendTrader(cfg, feed, PaperBroker(cfg, trader.broker.state()), state, Silent())
    assert again.pos.entry == pos.entry and "롱 보유 중" in again.status_text()


def test_trend_trader_exits_on_breakdown(trend_setup):
    cfg, feed, trader, state = trend_setup
    trader.step()
    while trader.pos is not None and feed.i < len(feed.df) - 1:
        feed.i += 1
        trader.step()
    assert trader.pos is None
    trades = pd.read_csv(state.with_suffix(".trades.csv"))
    assert list(trades["reason"]) == ["signal"]


def test_trend_trader_skips_when_started_too_late(trend_setup):
    cfg, feed, trader, state = trend_setup
    feed.now_ms = lambda: int((feed.df.index[feed.i] + pd.Timedelta(hours=8)).timestamp() * 1000)
    trader.step()
    assert trader.pos is None


def test_trend_trader_retries_failed_exit(trend_setup):
    cfg, feed, trader, state = trend_setup
    trader.step()
    real = trader.broker.execute
    calls = {"n": 0}

    def flaky(pos, ex, t):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("network")
        return real(pos, ex, t)

    trader.broker.execute = flaky
    while trader.pos is not None and not trader.pending_exit:
        feed.i += 1
        trader.step()
    assert trader.pos is not None and trader.pending_exit
    trader.step()  # 같은 날 다음 확인에서 재시도
    assert trader.pos is None and trader.pending_exit is None


def test_trend_trader_on_hyperliquid_places_market_and_stop_only(tmp_path):
    cfg = _cfg()
    ex = FakeHyperliquid()
    feed = DailyFeed(_daily(CLOSES))
    trader = live.TrendTrader(cfg, feed, CcxtBroker(ex, cfg), tmp_path / "t.json", Silent())
    trader.step()
    entry, sl = ex.orders
    assert entry["type"] == "market" and entry["side"] == "buy" and entry["price"] is not None
    assert sl["params"]["reduceOnly"] and "stopLossPrice" in sl["params"] and sl["price"] is not None
    assert set(trader.pos.order_ids) == {"entry", "sl"}  # 익절 주문 없음
    ex.positions = [{"symbol": "BTC/USDC:USDC", "contracts": trader.pos.qty}]
    while trader.pos is not None and feed.i < len(feed.df) - 1:
        feed.i += 1
        trader.step()
    assert trader.pos is None
    close = ex.orders[-1]
    assert close["type"] == "market" and close["side"] == "sell" and close["price"] is not None
    assert close["params"] == {"reduceOnly": True} and ("2", {}) in ex.cancelled


# ── 실시간: 채널 방식 신호 알림 ──

class Feed15m:
    def __init__(self, df, i):
        self.df, self.i = df, i

    def recent(self, n):
        return self.df.iloc[max(0, self.i + 1 - n): self.i + 1]

    def now_ms(self):
        return int((self.df.index[self.i] + pd.Timedelta(seconds=30)).timestamp() * 1000)


class Recorder:
    def __init__(self):
        self.sent = []

    def send(self, text):
        self.sent.append(text)


def test_alerter_sends_once_per_signal_and_never_trades(tmp_path, monkeypatch):
    cfg = config_from_dict({})
    df = synthetic_ohlcv(400, seed=2, timeframe="15m")
    feed = Feed15m(df, 300)
    sig_bar = df.index[299]

    def fake(f, i, p, allow_short=True):
        if f.index[i] == sig_bar:
            return Signal("short", "sweep", "pinbar", 100.0, 101.0, 98.5, 0.0, 100.5, f.index[i], "근거 테스트")
        return None

    monkeypatch.setattr(live, "generate_signal", fake)
    rec = Recorder()
    alerter = live.SignalAlerter(cfg, feed, tmp_path / "a.json", rec, lambda: "추세추종 봇: 현금 대기")
    alerter.step()
    alerter.step()
    assert len(rec.sent) == 1
    msg = rec.sent[0]
    assert "자동 주문 아님" in msg and "숏 후보" in msg and "근거 테스트" in msg and "현금 대기" in msg
    assert "1.5R" in msg
    feed.i += 1
    alerter.step()
    assert len(rec.sent) == 1


def test_run_forever_isolates_component_errors():
    class Boom:
        label = "boom"

        def step(self):
            raise RuntimeError("x")

    class Ok:
        n = 0

        def step(self):
            self.n += 1

    ok, rec = Ok(), Recorder()

    def stop_after_two(_):
        if ok.n >= 2:
            raise KeyboardInterrupt

    with pytest.raises(KeyboardInterrupt):
        live.run_forever([Boom(), ok], 1, rec, "start", sleep=stop_after_two)
    assert ok.n == 2 and rec.sent[0] == "start" and any("boom 오류 1회" in m for m in rec.sent)
