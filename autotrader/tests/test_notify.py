import pandas as pd
import pytest

from bot import live
from bot.broker import PaperBroker
from bot.config import NotifyParams
from test_trend import CLOSES, DailyFeed, _cfg, _daily


class FakeTelegram(live.Notifier):
    def __init__(self, updates=None, chat="42"):
        self.token, self.chat = "t", chat
        self.sent, self.queue, self.asked = [], list(updates or []), []
        self.http_get = None

    def updates(self, offset):
        self.asked.append(offset)
        out = [u for u in self.queue if u["update_id"] >= offset]
        self.queue = []
        return out

    def send(self, text):
        self.sent.append(text)


def _msg(uid, text, chat=42):
    return {"update_id": uid, "message": {"chat": {"id": chat}, "text": text}}


def test_status_command_replies_only_to_my_chat_and_remembers_offset(tmp_path):
    tg = FakeTelegram([_msg(10, "/status"), _msg(11, "/status", chat=999), _msg(12, "/help")])
    cmd = live.TelegramCommands(tg, lambda: "REPORT", tmp_path / "tg.json")
    cmd.step()
    assert tg.sent[0] == "REPORT" and "/status" in tg.sent[1] and len(tg.sent) == 2  # 999 번 채팅은 무시
    again = live.TelegramCommands(tg, lambda: "REPORT", tmp_path / "tg.json")
    again.step()
    assert tg.asked[-1] == 13  # 처리한 메시지는 다시 받지 않음


def test_commands_do_nothing_without_telegram(tmp_path, monkeypatch):
    monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)
    n = live.Notifier(NotifyParams(), http_get=lambda url: pytest.fail("호출되면 안 됨"))
    live.TelegramCommands(n, lambda: "x", tmp_path / "tg.json").step()


def test_notifier_builds_get_updates_url():
    urls = []
    n = live.Notifier(NotifyParams(), http_get=lambda url: urls.append(url) or {"result": [{"update_id": 1}]})
    n.token, n.chat = "TOKEN", "42"
    assert n.updates(7) == [{"update_id": 1}]
    assert urls[0].startswith("https://api.telegram.org/botTOKEN/getUpdates?") and "offset=7" in urls[0]


def test_daily_summary_and_report_while_waiting_and_holding(tmp_path):
    cfg = _cfg()
    feed = DailyFeed(_daily(CLOSES))
    feed.i = 30  # 29번째 일봉까지 마감 (아직 돌파 전)
    tg = FakeTelegram()
    trader = live.TrendTrader(cfg, feed, PaperBroker(cfg), tmp_path / "t.json", tg)
    trader.step()
    assert trader.pos is None and tg.sent and tg.sent[-1].startswith("📅")
    assert "진입 기준" in tg.sent[-1] and "모의매매" in tg.sent[-1]
    rep = "\n".join(trader.report(100.0))
    assert "현금 대기" in rep and "다음 진입" in rep and "평가 자산 10,000" in rep

    feed.i = 31  # 돌파 일봉 마감 → 진입 (요약 대신 진입 알림)
    trader.step()
    assert trader.pos is not None and "진입" in tg.sent[-1] and not tg.sent[-1].startswith("📅")
    price = trader.pos.entry * 1.1
    rep = "\n".join(trader.report(price))
    assert "롱 보유" in rep and "+10.0%" in rep and "청산 기준" in rep
    eq = trader.equity_estimate(price)
    assert eq == pytest.approx(cfg.initial_equity + trader.pos.qty * trader.pos.entry * 0.1, rel=1e-3)


def test_alerter_remembers_last_alert(tmp_path, monkeypatch):
    from bot.config import config_from_dict
    from bot.data import synthetic_ohlcv
    from bot.strategy import Signal

    df = synthetic_ohlcv(400, seed=2, timeframe="15m")

    class Feed:
        i = 300

        def recent(self, n):
            return df.iloc[: self.i + 1]

        def now_ms(self):
            return int((df.index[self.i] + pd.Timedelta(seconds=30)).timestamp() * 1000)

    monkeypatch.setattr(live, "generate_signal", lambda f, i, p, allow_short=True: Signal(
        "long", "sweep", "choch", 100.0, 99.0, 101.5, 0.0, 99.5, f.index[i], "r"))
    a = live.SignalAlerter(config_from_dict({}), Feed(), tmp_path / "a.json", FakeTelegram())
    a.step()
    assert "롱 후보 (sweep/choch)" in a.last_alert
    assert "롱 후보" in live.SignalAlerter(config_from_dict({}), Feed(), tmp_path / "a.json",
                                         FakeTelegram()).last_alert
