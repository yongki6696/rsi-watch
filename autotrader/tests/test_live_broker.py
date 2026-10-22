import json

import pandas as pd
import pytest

from bot import live
from bot.broker import CcxtBroker, OrderTooSmall, PaperBroker
from bot.config import config_from_dict
from bot.data import synthetic_ohlcv
from bot.strategy import Signal
from bot.trade import Exit, new_position


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


def _signal_at(t):
    def fake(f, i, p, allow_short=True):
        if f.index[i] == t:
            c = f.close[i]
            return Signal("long", "sweep", "choch", c, c * 0.98, c * 1.03, 0.0, c * 0.99, f.index[i], "test")
        return None
    return fake


@pytest.fixture
def setup(tmp_path, monkeypatch):
    cfg = config_from_dict({"timeframe": "1h", "liquidity_timeframe": "1h",
                            "strategy": {"runner": "hold"},
                            "costs": {"fee_rate": 0.0, "maker_fee_rate": 0.0, "slippage": 0.0}})
    df = synthetic_ohlcv(600, seed=1, timeframe="1h")
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


def test_paper_partial_take_profit_then_breakeven_exit(setup):
    cfg, df, feed, trader, state = setup
    trader.step()
    pos = trader.pos
    feed.price = pos.tp1 * 1.001
    trader.step()
    assert trader.pos is not None and trader.pos.tp1_done
    assert trader.pos.qty == pytest.approx(pos.initial_qty / 2) and trader.pos.stop == trader.pos.entry
    feed.price = trader.pos.entry * 0.999
    trader.step()
    assert trader.pos is None
    trades = pd.read_csv(state.with_suffix(".trades.csv"))
    assert len(trades) == 1 and trades["reason"].iloc[0] == "breakeven" and trades["pnl"].iloc[0] > 0
    assert trader.broker.equity() > cfg.initial_equity


def test_paper_stop_loss(setup):
    cfg, df, feed, trader, state = setup
    trader.step()
    feed.price = trader.pos.stop * 0.999
    trader.step()
    assert trader.pos is None and trader.broker.equity() < cfg.initial_equity


def test_stale_bar_is_not_traded(setup):
    cfg, df, feed, trader, state = setup
    feed.offset = pd.Timedelta(minutes=45)  # 1시간봉이 마감된 지 45분 지남
    trader.step()
    assert trader.pos is None


def test_entry_skipped_when_price_already_past_tp1(setup):
    cfg, df, feed, trader, state = setup
    feed.price = float(df["close"].iloc[feed.i - 1]) * 1.05
    trader.step()
    assert trader.pos is None


# ── 거래소 브로커 (가짜 ccxt 거래소로 주문 흐름 검증) ──

TRIGGER = {"trigger": True}


class FakeExchange:
    id = "binance"
    has = {"setMarginMode": True}

    def __init__(self, contract=True, contract_size=1.0, fail_stop=False):
        self.orders, self.cancelled, self.fetched = [], [], []
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

    def set_leverage(self, lev, symbol, params=None):
        self.leverage = lev
        self.leverage_params = params

    def set_margin_mode(self, mode, symbol):
        self.margin_mode = mode

    def amount_to_precision(self, symbol, amount):
        return f"{int(amount * 1000 + 1e-9) / 1000:.3f}"

    def price_to_precision(self, symbol, price):
        return f"{price:.1f}"

    def create_order(self, symbol, type_, side, amount, price=None, params=None):
        params = params or {}
        if self.fail_stop and "stopLossPrice" in params:
            raise RuntimeError("stop rejected")
        oid = str(len(self.orders) + 1)
        self.orders.append({"id": oid, "type": type_, "side": side, "amount": amount, "price": price,
                            "params": params})
        market_fill = type_ == "market" and not params.get("stopLossPrice")
        return {"id": oid, "average": 100.0 if market_fill else None, "filled": amount if market_fill else 0}

    def cancel_order(self, oid, symbol, params=None):
        self.cancelled.append((oid, params or {}))

    def fetch_order(self, oid, symbol, params=None):
        self.fetched.append((oid, params or {}))
        return {"id": oid, "status": self.status.get(oid, "open"), "average": None}

    def fetch_positions(self, symbols):
        return self.positions

    def fetch_balance(self):
        return {"total": {"USDT": 1000.0, "BTC": 0.0}, "free": {"BTC": 0.5}}


T0 = pd.Timestamp("2024-01-01", tz="UTC")


def _sig():
    return Signal("long", "sweep", "pinbar", 100.0, 95.0, 107.5, 0.0, 99, T0, "t")


def _cfg(market_type="future", **live_kw):
    sym = "BTC/USDT:USDT" if market_type == "future" else "BTC/USDT"
    return config_from_dict({"symbol": sym, "exchange": {"market_type": market_type}, "live": live_kw})


def test_ccxt_open_places_entry_stop_and_tp1():
    ex = FakeExchange()
    b = CcxtBroker(ex, _cfg())
    pos = b.open(_sig(), 0.5, 100.0, T0)
    entry, sl, tp1 = ex.orders
    assert (entry["type"], entry["side"], entry["amount"], entry["params"]) == ("market", "buy", 0.5, {})
    assert sl["type"] == "market" and sl["params"] == {"stopLossPrice": 95.0, "reduceOnly": True}
    assert (tp1["type"], tp1["side"], tp1["amount"], tp1["price"]) == ("limit", "sell", 0.25, 107.5)
    assert tp1["params"] == {"reduceOnly": True}
    assert pos.order_ids == {"entry": "1", "sl": "2", "tp1": "3"} and pos.qty == 0.5
    assert ex.leverage == 3 and ex.margin_mode == "isolated"


def test_ccxt_tp1_fill_moves_stop_to_breakeven_with_trigger_param():
    ex = FakeExchange()
    b = CcxtBroker(ex, _cfg())
    pos = b.open(_sig(), 0.5, 100.0, T0)
    ex.positions = [{"symbol": "BTC/USDT:USDT", "contracts": 0.5}]
    assert b.sync(pos, 103.0, T0) == []
    ex.positions = [{"symbol": "BTC/USDT:USDT", "contracts": 0.25}]
    ex.status["3"] = "closed"
    fills = b.sync(pos, 107.6, T0)
    assert [(e.reason, e.qty) for e, _ in fills] == [("tp1", 0.25)]
    assert pos.tp1_done and pos.qty == pytest.approx(0.25) and pos.stop == 100.0
    new_sl = ex.orders[-1]
    assert new_sl["params"]["stopLossPrice"] == 100.0 and new_sl["amount"] == 0.25
    assert ("2", TRIGGER) in ex.cancelled  # 스탑 주문 취소엔 trigger 파라미터 필요 (바이낸스 algo 주문)
    assert ("2", TRIGGER) in ex.fetched or ("3", {}) in ex.fetched


def test_ccxt_sync_detects_stop_close():
    ex = FakeExchange()
    b = CcxtBroker(ex, _cfg())
    pos = b.open(_sig(), 0.5, 100.0, T0)
    ex.positions = []
    ex.status["2"] = "closed"
    fills = b.sync(pos, 95.0, T0)
    assert [(e.reason, e.qty) for e, _ in fills] == [("stop", 0.5)]
    assert pos.qty == 0 and ("3", {}) in ex.cancelled


def test_ccxt_contract_size_converts_quantity():
    ex = FakeExchange(contract_size=0.01)  # OKX 처럼 1계약 = 0.01 BTC
    b = CcxtBroker(ex, _cfg())
    pos = b.open(_sig(), 0.5, 100.0, T0)
    assert ex.orders[0]["amount"] == 50.0 and pos.qty == pytest.approx(0.5)
    assert ex.orders[2]["amount"] == 25.0


def test_ccxt_stop_failure_flattens_position():
    ex = FakeExchange(fail_stop=True)
    b = CcxtBroker(ex, _cfg())
    with pytest.raises(RuntimeError):
        b.open(_sig(), 0.5, 100.0, T0)
    close = ex.orders[-1]
    assert close["side"] == "sell" and close["params"] == {"reduceOnly": True}


def test_ccxt_rejects_too_small_order():
    with pytest.raises(OrderTooSmall):
        CcxtBroker(FakeExchange(), _cfg()).open(_sig(), 0.0004, 100.0, T0)


def test_ccxt_rejects_when_half_take_profit_is_below_minimum():
    ex = FakeExchange()
    with pytest.raises(OrderTooSmall):
        CcxtBroker(ex, _cfg()).open(_sig(), 0.0015, 100.0, T0)  # 절반 0.00075 < 최소 0.001
    assert ex.orders == []  # 진입 주문 자체를 내지 않음


def test_ccxt_refuses_to_start_with_unknown_position():
    ex = FakeExchange()
    ex.positions = [{"symbol": "BTC/USDT:USDT", "contracts": 1.0}]
    with pytest.raises(RuntimeError):
        CcxtBroker(ex, _cfg()).startup_check(None)


def test_ccxt_spot_uses_software_exits_and_checks_symbol_type():
    ex = FakeExchange(contract=False)
    b = CcxtBroker(ex, _cfg("spot"))
    assert not b.native_exits
    pos = b.open(_sig(), 0.4, 100.0, T0)
    assert len(ex.orders) == 1  # 현물은 거래소 손절 주문 없이 진입만
    with pytest.raises(ValueError):
        CcxtBroker(FakeExchange(contract=False), _cfg("future"))
    with pytest.raises(ValueError):
        CcxtBroker(FakeExchange(contract=False), _cfg("spot", exits="exchange"))
    b.execute(pos, Exit(96.0, pos.qty, "stop", False), T0)
    assert ex.orders[-1]["side"] == "sell" and ex.orders[-1]["params"] == {} and pos.qty == 0


def test_ccxt_spot_close_is_capped_by_available_balance():
    ex = FakeExchange(contract=False)
    b = CcxtBroker(ex, _cfg("spot"))
    pos = new_position("long", 0.6, 100.0, 95.0, 107.5, 0.0, 0.5, "t", "x", 0.0)
    b.execute(pos, Exit(96.0, pos.qty, "stop", False), T0)
    assert ex.orders[-1]["amount"] == 0.5


# ── 하이퍼리퀴드 ──

class FakeHyperliquid(FakeExchange):
    id = "hyperliquid"
    has = {}

    def __init__(self):
        super().__init__()
        self._market.update(symbol="BTC/USDC:USDC", quote="USDC", settle="USDC",
                            limits={"amount": {"min": None}, "cost": {"min": 10}})

    def create_order(self, symbol, type_, side, amount, price=None, params=None):
        if type_ == "market" and price is None:  # ccxt hyperliquid 와 같은 제약
            raise ValueError("market orders require price")
        return super().create_order(symbol, type_, side, amount, price, params)

    def cancel_order(self, oid, symbol, params=None):
        assert not params, "하이퍼리퀴드에는 추가 파라미터를 보내면 안 됨"
        super().cancel_order(oid, symbol, params)

    def fetch_order(self, oid, symbol, params=None):
        assert not params, "하이퍼리퀴드에는 추가 파라미터를 보내면 안 됨"
        return super().fetch_order(oid, symbol, params)


def _hl_cfg():
    return config_from_dict({"symbol": "BTC/USDC:USDC", "exchange": {"id": "hyperliquid"}})


def test_hyperliquid_market_and_stop_orders_carry_price_and_no_trigger_param():
    ex = FakeHyperliquid()
    b = CcxtBroker(ex, _hl_cfg())
    pos = b.open(_sig(), 0.5, 100.0, T0)
    entry, sl, tp1 = ex.orders
    assert entry["type"] == "market" and entry["price"] == 100.0
    assert sl["price"] == 95.0 and sl["params"] == {"stopLossPrice": 95.0, "reduceOnly": True}
    assert tp1["type"] == "limit" and tp1["price"] == 107.5
    assert ex.leverage_params == {"marginMode": "isolated"}
    ex.positions = [{"symbol": "BTC/USDC:USDC", "contracts": 0.25}]
    ex.status["3"] = "closed"
    b.sync(pos, 107.6, T0)  # 1차 익절 → 본절 손절로 교체 (조회·취소에 trigger 파라미터 없이)
    assert pos.tp1_done and ex.orders[-1]["price"] == 100.0 and ("2", {}) in ex.cancelled


HL_MARKET = {"id": "0", "symbol": "BTC/USDC:USDC", "base": "BTC", "quote": "USDC", "settle": "USDC",
             "baseId": "0", "quoteId": "USDC", "settleId": "USDC", "type": "swap", "spot": False,
             "margin": False, "swap": True, "future": False, "option": False, "active": True,
             "contract": True, "linear": True, "inverse": False, "contractSize": 1,
             "precision": {"amount": 0.00001, "price": 1},
             "limits": {"amount": {"min": None}, "cost": {"min": 10}, "leverage": {"max": 40}},
             "info": {"szDecimals": "5"}}


def test_make_exchange_hyperliquid_uses_wallet_keys_and_disables_ccxt_extras(monkeypatch):
    from bot.data import make_exchange

    monkeypatch.setenv("HYPERLIQUID_WALLET_ADDRESS", "0x" + "1" * 40)
    monkeypatch.setenv("HYPERLIQUID_PRIVATE_KEY", "0x" + "2" * 64)
    ex = make_exchange(_hl_cfg().exchange, with_keys=True)
    assert ex.walletAddress == "0x" + "1" * 40 and ex.privateKey == "0x" + "2" * 64
    assert ex.options["builderFee"] is False and ex.options["refSet"] is True
    assert "testnet" in ex.urls["api"]["private"]
    monkeypatch.delenv("HYPERLIQUID_PRIVATE_KEY")
    with pytest.raises(RuntimeError, match="HYPERLIQUID_PRIVATE_KEY"):
        make_exchange(_hl_cfg().exchange, with_keys=True)


def test_make_exchange_binance_uses_api_keys(monkeypatch):
    from bot.data import make_exchange

    monkeypatch.setenv("EXCHANGE_API_KEY", "k")
    monkeypatch.setenv("EXCHANGE_API_SECRET", "s")
    ex = make_exchange(_cfg().exchange, with_keys=True)
    assert (ex.apiKey, ex.secret) == ("k", "s")


def test_hyperliquid_real_ccxt_order_path_offline(monkeypatch):
    """실제 ccxt 하이퍼리퀴드 코드(주문 생성·서명)를 돌리고 HTTP 전송만 가로챈다."""
    from bot.data import make_exchange

    monkeypatch.setenv("HYPERLIQUID_WALLET_ADDRESS", "0x" + "1" * 40)
    monkeypatch.setenv("HYPERLIQUID_PRIVATE_KEY", "0x" + "2" * 64)
    ex = make_exchange(_hl_cfg().exchange, with_keys=True)
    ex.set_markets([HL_MARKET])
    sent = []

    def private_post(req, *a, **k):
        sent.append(req["action"])
        assert "signature" in req
        if req["action"]["type"] != "order":
            return {"status": "ok", "response": {"type": "default"}}
        o = req["action"]["orders"][0]
        ioc = o["t"].get("limit", {}).get("tif") == "Ioc"
        st = {"filled": {"totalSz": o["s"], "avgPx": "62000", "oid": 7}} if ioc else {"resting": {"oid": len(sent)}}
        return {"status": "ok", "response": {"type": "order", "data": {"statuses": [st]}}}

    ex.privatePostExchange = private_post
    ex.publicPostInfo = lambda req, *a, **k: {}
    b = CcxtBroker(ex, _hl_cfg())
    sig = Signal("long", "sweep", "pinbar", 62000.0, 60000.0, 65000.0, 0.0, 61000, T0, "t")
    pos = b.open(sig, 0.02, 62000.0, T0)

    types = [a["type"] for a in sent]
    assert "setReferrer" not in types  # ccxt 추천인 코드 등록 안 함
    for a in sent:
        if a["type"] == "approveBuilderFee":
            assert a["maxFeeRate"] == "0%"  # 빌더 수수료 0%
    lev = next(a for a in sent if a["type"] == "updateLeverage")
    assert lev["isCross"] is False and lev["leverage"] == 3
    orders = [a["orders"][0] for a in sent if a["type"] == "order"]
    entry, sl, tp1 = orders
    assert entry["b"] is True and entry["t"] == {"limit": {"tif": "Ioc"}} and entry["p"] == "65100"
    assert sl["b"] is False and sl["r"] is True
    assert sl["t"] == {"trigger": {"isMarket": True, "triggerPx": "60000", "tpsl": "sl"}}
    assert tp1["r"] is True and tp1["t"] == {"limit": {"tif": "Gtc"}} and tp1["p"] == "65000" and tp1["s"] == "0.01"
    assert pos.entry == 62000.0 and pos.qty == pytest.approx(0.02)
