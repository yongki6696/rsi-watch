import json

import pandas as pd
import pytest

from bot import live
from bot.broker import CcxtBroker, OrderTooSmall, PaperBroker
from bot.config import config_from_dict
from bot.data import synthetic_ohlcv
from bot.strategy import Signal
from bot.trade import Position


class FakeFeed:
    def __init__(self, df):
        self.df = df
        self.i = 400          # 현재 진행 중인 봉 인덱스
        self.price = None
        self.offset = pd.Timedelta(seconds=30)

    def recent(self, n):
        return self.df.iloc[max(0, self.i + 1 - n): self.i + 1]  # 마지막 봉은 미마감

    def now_ms(self):
        return int((self.df.index[self.i] + self.offset).timestamp() * 1000)

    def last_price(self):
        return self.price if self.price is not None else float(self.df["open"].iloc[self.i])


class Silent:
    def send(self, text):
        self.last = text


def _signal_at(df_index_time):
    def fake(f, i, p, allow_short=True):
        if f.index[i] == df_index_time:
            c = f.close[i]
            return Signal("long", "sweep", c, c * 0.98, c * 1.06, 3.0, c * 0.99, c, f.index[i], "test")
        return None
    return fake


@pytest.fixture
def setup(tmp_path, monkeypatch):
    cfg = config_from_dict({"timeframe": "1h", "bias_timeframe": "4h", "costs": {"fee_rate": 0.0, "slippage": 0.0}})
    df = synthetic_ohlcv(600, seed=1)
    feed = FakeFeed(df)
    monkeypatch.setattr(live, "generate_signal", _signal_at(df.index[feed.i - 1]))
    state = tmp_path / "state.json"
    trader = live.LiveTrader(cfg, feed, PaperBroker(cfg), state, Silent())
    return cfg, df, feed, trader, state


def test_paper_enters_once_per_bar_and_persists(setup):
    cfg, df, feed, trader, state = setup
    trader.step()
    assert trader.pos is not None and trader.pos.side == "long"
    entry = trader.pos.entry
    trader.step()  # 같은 봉에서 다시 돌아도 중복 진입 없음
    assert trader.pos.entry == entry
    saved = json.loads(state.read_text())
    assert saved["position"]["entry"] == entry and saved["last_bar"] == df.index[feed.i - 1].isoformat()

    restarted = live.LiveTrader(cfg, feed, PaperBroker(cfg, saved["broker"]), state, Silent())
    assert restarted.pos is not None and restarted.pos.entry == entry


def test_paper_stop_closes_and_records_trade(setup):
    cfg, df, feed, trader, state = setup
    trader.step()
    pos = trader.pos
    feed.price = pos.stop * 0.999
    trader.step()
    assert trader.pos is None
    trades = pd.read_csv(state.with_suffix(".trades.csv"))
    assert len(trades) == 1 and trades["reason"].iloc[0] == "stop"
    assert trades["pnl"].iloc[0] < 0
    assert trader.broker.equity() < cfg.initial_equity


def test_stale_bar_is_not_traded(setup):
    cfg, df, feed, trader, state = setup
    feed.offset = pd.Timedelta(minutes=45)  # 1시간봉이 마감된 지 45분 지남
    trader.step()
    assert trader.pos is None


def test_entry_skipped_when_price_ran_away(setup):
    cfg, df, feed, trader, state = setup
    feed.price = float(df["close"].iloc[feed.i - 1]) * 1.05  # 목표 근처까지 이미 올라감
    trader.step()
    assert trader.pos is None


# ── 거래소 브로커 (가짜 ccxt 거래소로 주문 흐름 검증) ──

class FakeExchange:
    def __init__(self, contract=True, contract_size=1.0, fail_stop=False):
        self.orders, self.cancelled = [], []
        self.positions = []
        self.options = {}
        self.fail_stop = fail_stop
        self.status = {}
        self._market = {
            "symbol": "BTC/USDT:USDT" if contract else "BTC/USDT", "base": "BTC", "quote": "USDT",
            "settle": "USDT" if contract else None, "contract": contract, "contractSize": contract_size,
            "limits": {"amount": {"min": 0.001}, "cost": {"min": 5}},
        }

    def load_markets(self):
        return {}

    def market(self, symbol):
        return self._market

    def set_leverage(self, lev, symbol):
        self.leverage = lev

    def amount_to_precision(self, symbol, amount):
        return f"{int(amount * 1000) / 1000:.3f}"

    def price_to_precision(self, symbol, price):
        return f"{price:.1f}"

    def create_order(self, symbol, type_, side, amount, price=None, params=None):
        params = params or {}
        if self.fail_stop and "stopLossPrice" in params:
            raise RuntimeError("stop rejected")
        oid = str(len(self.orders) + 1)
        self.orders.append({"id": oid, "type": type_, "side": side, "amount": amount, "params": params})
        return {"id": oid, "average": 100.0 if not params else None, "filled": amount if not params else 0}

    def cancel_order(self, oid, symbol):
        self.cancelled.append(oid)

    def fetch_order(self, oid, symbol):
        return {"id": oid, "status": self.status.get(oid, "open"), "average": 110.0}

    def fetch_positions(self, symbols):
        return self.positions

    def fetch_balance(self):
        return {"total": {"USDT": 1000.0, "BTC": 0.0}, "free": {"BTC": 0.5}}


def _sig():
    return Signal("long", "sweep", 100.0, 95.0, 110.0, 2.0, 99, 100, pd.Timestamp("2024-01-01", tz="UTC"), "t")


def _cfg(market_type="future", **live_kw):
    sym = "BTC/USDT:USDT" if market_type == "future" else "BTC/USDT"
    return config_from_dict({"symbol": sym, "exchange": {"market_type": market_type}, "live": live_kw})


def test_ccxt_open_places_market_then_reduce_only_stop_and_target():
    ex = FakeExchange()
    b = CcxtBroker(ex, _cfg())
    pos = b.open(_sig(), 0.5, 100.0, pd.Timestamp("2024-01-01", tz="UTC"))
    entry, sl, tp = ex.orders
    assert (entry["side"], entry["amount"], entry["params"]) == ("buy", 0.5, {})
    assert sl["side"] == "sell" and sl["params"] == {"stopLossPrice": 95.0, "reduceOnly": True}
    assert tp["side"] == "sell" and tp["params"] == {"takeProfitPrice": 110.0, "reduceOnly": True}
    assert pos.order_ids["sl"] == "2" and pos.order_ids["tp"] == "3" and pos.qty == 0.5
    assert ex.leverage == 3


def test_ccxt_contract_size_converts_quantity():
    ex = FakeExchange(contract_size=0.01)  # OKX 처럼 1계약 = 0.01 BTC
    b = CcxtBroker(ex, _cfg())
    pos = b.open(_sig(), 0.5, 100.0, pd.Timestamp("2024-01-01", tz="UTC"))
    assert ex.orders[0]["amount"] == 50.0 and pos.qty == pytest.approx(0.5)


def test_ccxt_stop_failure_flattens_position():
    ex = FakeExchange(fail_stop=True)
    b = CcxtBroker(ex, _cfg())
    with pytest.raises(RuntimeError):
        b.open(_sig(), 0.5, 100.0, pd.Timestamp("2024-01-01", tz="UTC"))
    close = ex.orders[-1]
    assert close["side"] == "sell" and close["params"] == {"reduceOnly": True}


def test_ccxt_rejects_too_small_order():
    b = CcxtBroker(FakeExchange(), _cfg())
    with pytest.raises(OrderTooSmall):
        b.open(_sig(), 0.0004, 100.0, pd.Timestamp("2024-01-01", tz="UTC"))


def test_ccxt_sync_detects_exchange_side_take_profit():
    ex = FakeExchange()
    b = CcxtBroker(ex, _cfg())
    pos = b.open(_sig(), 0.5, 100.0, pd.Timestamp("2024-01-01", tz="UTC"))
    ex.positions = [{"symbol": "BTC/USDT:USDT", "contracts": 0.5}]
    assert b.sync(pos, 105.0, pd.Timestamp("2024-01-02", tz="UTC")) is None
    ex.positions = []
    ex.status["3"] = "closed"
    tr = b.sync(pos, 110.0, pd.Timestamp("2024-01-02", tz="UTC"))
    assert tr["reason"] == "target" and tr["exit"] == 110.0
    assert "2" in ex.cancelled  # 남은 손절 주문 취소


def test_ccxt_update_stop_places_new_before_cancelling_old():
    ex = FakeExchange()
    b = CcxtBroker(ex, _cfg())
    pos = b.open(_sig(), 0.5, 100.0, pd.Timestamp("2024-01-01", tz="UTC"))
    b.update_stop(pos, 100.0)
    assert ex.orders[-1]["params"]["stopLossPrice"] == 100.0
    assert ex.cancelled == ["2"] and pos.order_ids["sl"] == "4" and pos.stop == 100.0


def test_ccxt_refuses_to_start_with_unknown_position():
    ex = FakeExchange()
    ex.positions = [{"symbol": "BTC/USDT:USDT", "contracts": 1.0}]
    with pytest.raises(RuntimeError):
        CcxtBroker(ex, _cfg()).startup_check(None)


def test_ccxt_spot_uses_software_exits_and_checks_symbol_type():
    b = CcxtBroker(FakeExchange(contract=False), _cfg("spot"))
    assert not b.native_exits
    with pytest.raises(ValueError):
        CcxtBroker(FakeExchange(contract=False), _cfg("future"))
    with pytest.raises(ValueError):
        CcxtBroker(FakeExchange(contract=False), _cfg("spot", exits="exchange"))


def test_ccxt_spot_close_sells_available_balance():
    ex = FakeExchange(contract=False)
    b = CcxtBroker(ex, _cfg("spot"))
    pos = Position("long", 0.6, 100.0, 95.0, 110.0, 95.0, "t")
    b.close(pos, 96.0, "stop", pd.Timestamp("2024-01-01", tz="UTC"))
    assert ex.orders[-1]["amount"] == 0.5 and ex.orders[-1]["params"] == {}
