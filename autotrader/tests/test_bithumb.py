"""빗썸: 실제 ccxt 빗썸 코드를 돌리고 HTTP 호출만 가로챈다 (개발 환경에서 빗썸 접속이 막혀 있음)."""
import ccxt
import pandas as pd
import pytest

from bot import live
from bot.broker import CcxtBroker
from bot.config import config_from_dict
from bot.data import fetch_ohlcv
from test_live_broker import Silent
from test_trend import CLOSES, DailyFeed, _daily

NOW = pd.Timestamp("2026-10-22T10:07:00Z")
MARKET = {"id": "BTC_KRW", "symbol": "BTC/KRW", "base": "BTC", "quote": "KRW", "baseId": "BTC", "quoteId": "KRW",
          "type": "spot", "spot": True, "margin": False, "swap": False, "future": False, "option": False,
          "active": True, "contract": False, "linear": None, "inverse": None,
          "precision": {"amount": 4, "price": 4},  # 빗썸: 수량 소수 4자리, 가격 유효숫자 4자리
          "limits": {"amount": {"min": None}, "cost": {"min": 5000}}, "info": {}}


def _bithumb():
    ex = ccxt.bithumb({"apiKey": "k", "secret": "s"})
    ex.set_markets([MARKET])
    ex.milliseconds = lambda: int(NOW.timestamp() * 1000)
    return ex


def test_bithumb_candles_page_backwards_with_to_param():
    ex = _bithumb()
    calls = []

    def minutes(req, *a, **k):
        calls.append(dict(req))
        end = pd.Timestamp(req["to"]) - pd.Timedelta(minutes=15) if "to" in req else NOW.floor("15min")
        return [{"market": req["market"], "candle_date_time_utc": (end - pd.Timedelta(minutes=15 * j)).strftime(
                    "%Y-%m-%dT%H:%M:%S"), "opening_price": 1.0, "high_price": 2.0, "low_price": 0.5,
                 "trade_price": 1.5, "candle_acc_trade_volume": 3.0, "unit": 15}
                for j in range(int(req["count"]))]  # 빗썸은 최신순으로 준다

    ex.publicGetV1CandlesMinutesUnit = minutes
    since = NOW - pd.Timedelta(days=5)
    df = fetch_ohlcv(ex, "BTC/KRW", "15m", int(since.timestamp() * 1000))
    assert len(df) == 5 * 96 and df.index[0] >= since and df.index.is_monotonic_increasing
    assert (df.index.to_series().diff().dropna() == pd.Timedelta(minutes=15)).all()  # 빈 구간 없음
    assert all(c["count"] == 200 and c["market"] == "KRW-BTC" for c in calls)
    assert "to" not in calls[0] and calls[1]["to"].endswith("Z")


def _cfg():
    return config_from_dict({"symbol": "BTC/KRW", "exchange": {"id": "bithumb", "market_type": "spot",
                                                                "sandbox": False},
                             "risk": {"max_leverage": 1}, "trend": {"atr_period": 5}})


def test_trend_on_bithumb_spot_buys_with_krw_and_sells_held_coins(tmp_path):
    ex = _bithumb()
    sent = []

    def orders(req, *a, **k):
        sent.append(dict(req))
        return {"order_id": f"C{len(sent)}"}

    ex.privatePostV2Orders = orders
    krw, btc = 10_000_000.0, 0.0
    ex.fetch_balance = lambda params={}: {"total": {"KRW": krw, "BTC": btc}, "free": {"KRW": krw, "BTC": btc}}

    prices = [p * 1_000_000 for p in CLOSES]  # 원화 가격대 (1억원 근처)
    feed = DailyFeed(_daily(prices, spread=1_000_000))
    cfg = _cfg()
    broker = CcxtBroker(ex, cfg)
    assert not broker.native_exits  # 빗썸은 거래소 손절 주문이 없어 봇이 직접 감시
    trader = live.TrendTrader(cfg, feed, broker, tmp_path / "t.json", Silent())
    trader.step()

    buy = sent[-1]
    ref = feed.last_price()
    assert buy["side"] == "bid" and buy["order_type"] == "price"  # 시장가 매수 = 쓸 원화 금액
    assert float(buy["price"]) <= krw * 0.995 + 1
    pos = trader.pos
    assert pos.entry == pytest.approx(ref)  # 원화 금액이 아니라 BTC 가격으로 기록
    assert pos.stop and pos.order_ids == {"entry": "C1"}  # 거래소 스탑 주문 없음

    btc = round(pos.qty * 0.999, 4)  # 매수 수수료가 코인으로 빠졌다고 가정
    feed.price = pos.stop * 0.99  # 비상 손절가 아래로 급락 → 봇이 시장가 매도
    trader.step()
    sell = sent[-1]
    assert sell["side"] == "ask" and sell["order_type"] == "market"
    assert float(sell["volume"]) == pytest.approx(btc)  # 실제 보유 수량만큼만 매도
    assert trader.pos is None


def test_spot_exposure_above_one_is_rejected():
    with pytest.raises(ValueError, match="현물"):
        config_from_dict({"symbol": "BTC/KRW", "exchange": {"id": "bithumb", "market_type": "spot"},
                          "trend": {"exposure": 1.5}})


def test_sandbox_on_exchange_without_testnet_gives_clear_error():
    from bot.data import make_exchange

    cfg = config_from_dict({"symbol": "BTC/KRW", "exchange": {"id": "bithumb", "market_type": "spot"},
                            "risk": {"max_leverage": 1}})
    with pytest.raises(ValueError, match="테스트넷이 없습니다"):
        make_exchange(cfg.exchange)
    make_exchange(_cfg().exchange)  # sandbox: false 면 정상


def test_bithumb_config_file_is_ready_to_use():
    from pathlib import Path

    from bot.config import load_config

    c = load_config(Path(__file__).resolve().parents[1] / "config.bithumb.yaml")
    assert (c.mode, c.symbol, c.exchange.id, c.exchange.market_type, c.exchange.sandbox) == \
        ("hybrid", "BTC/KRW", "bithumb", "spot", False)
    assert c.effective_max_leverage == 1 and c.costs.funding_apr == 0 and not c.live.enabled


def test_env_file_loader(tmp_path, monkeypatch):
    from bot.__main__ import load_env_file

    env = tmp_path / ".env"
    env.write_text("\ufeffEXCHANGE_API_KEY=abc\n# 주석\nEXCHANGE_API_SECRET='s3'\nTELEGRAM_CHAT_ID=\nBAD LINE\n",
                   encoding="utf-8")
    monkeypatch.delenv("EXCHANGE_API_KEY", raising=False)
    monkeypatch.delenv("EXCHANGE_API_SECRET", raising=False)
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "keep")
    loaded = load_env_file(env)
    import os
    assert os.environ["EXCHANGE_API_KEY"] == "abc" and os.environ["EXCHANGE_API_SECRET"] == "s3"
    assert os.environ["TELEGRAM_CHAT_ID"] == "keep"  # 이미 있는 값은 덮지 않음
    assert sorted(loaded) == ["EXCHANGE_API_KEY", "EXCHANGE_API_SECRET"]
