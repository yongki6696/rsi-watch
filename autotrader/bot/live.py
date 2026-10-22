"""실시간 루프 (모의/실거래 공용).

구성 요소 (poll_seconds 마다 각각 step() 실행)
  TrendTrader    : mode hybrid — 일봉 추세추종 자동매매 (실제 주문)
  SignalAlerter  : mode hybrid — 채널 방식 신호를 텔레그램으로 알림만 (주문 없음)
  LiveTrader     : mode smc    — 채널 방식 자동매매
상태(포지션, 마지막 처리 봉 등)는 JSON 파일에 저장돼 재시작해도 이어진다.
"""
from __future__ import annotations

import csv
import json
import logging
import os
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Callable

import pandas as pd

from .config import Config, NotifyParams
from .data import drop_unclosed, fetch_ohlcv, to_frame
from .risk import RiskManager
from .strategy import Features, Signal, generate_signal, prepare_features, trail_stop
from .timeframes import timeframe_seconds
from .trade import Exit, Position, entry_valid, is_closed, plan_exits, trade_record
from .trend import EMERGENCY, decide, next_stop, reason_text, trend_levels

MIN_BARS = 200

log = logging.getLogger(__name__)


class Notifier:
    """텔레그램 알림 (환경변수에 토큰/채팅 ID가 있을 때만). 로그는 항상 남긴다."""

    def __init__(self, p: NotifyParams):
        self.token = os.environ.get(p.telegram_token_env)
        self.chat = os.environ.get(p.telegram_chat_env)

    def send(self, text: str) -> None:
        log.info(text)
        if not (self.token and self.chat):
            return
        data = urllib.parse.urlencode({"chat_id": self.chat, "text": text}).encode()
        try:
            urllib.request.urlopen(f"https://api.telegram.org/bot{self.token}/sendMessage", data, timeout=10)
        except Exception as e:
            log.warning("텔레그램 전송 실패: %s", e)


class CcxtFeed:
    """최근 봉을 캐시해 두고 새 봉만 이어 받는다."""

    def __init__(self, ex, symbol: str, timeframe: str):
        self.ex, self.symbol, self.timeframe = ex, symbol, timeframe
        self.tf_ms = timeframe_seconds(timeframe) * 1000
        self.df: pd.DataFrame | None = None

    def recent(self, n: int) -> pd.DataFrame:
        now = self.ex.milliseconds()
        if self.df is None or self.df.empty:
            self.df = fetch_ohlcv(self.ex, self.symbol, self.timeframe, now - (n + 1) * self.tf_ms)
        else:
            since = int(self.df.index[-1].timestamp() * 1000) - self.tf_ms
            rows = self.ex.fetch_ohlcv(self.symbol, self.timeframe, since=since)
            if rows:
                fresh = to_frame(rows)
                self.df = pd.concat([self.df[~self.df.index.isin(fresh.index)], fresh]).sort_index()
        self.df = self.df.iloc[-n:]
        return self.df

    def last_price(self) -> float:
        return float(self.ex.fetch_ticker(self.symbol)["last"])

    def now_ms(self) -> int:
        return int(self.ex.milliseconds())


class Stateful:
    """JSON 상태 파일과 거래 기록 CSV."""

    state_path: Path
    trades_path: Path

    def _init_state(self, state_path: str | Path) -> dict:
        self.state_path = Path(state_path)
        self.trades_path = self.state_path.with_suffix(".trades.csv")
        return self._load()

    def _load(self) -> dict:
        if self.state_path.exists():
            return json.loads(self.state_path.read_text(encoding="utf-8"))
        return {}

    def _write(self, st: dict) -> None:
        tmp = self.state_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(st, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(self.state_path)

    def _record(self, tr: dict) -> None:
        new = not self.trades_path.exists()
        with open(self.trades_path, "a", newline="", encoding="utf-8") as fh:
            w = csv.DictWriter(fh, fieldnames=list(tr))
            if new:
                w.writeheader()
            w.writerow(tr)


def closed_bars(feed, n: int, timeframe: str) -> tuple[pd.DataFrame, pd.Timestamp]:
    now = pd.Timestamp(feed.now_ms(), unit="ms", tz="UTC")
    return drop_unclosed(feed.recent(n), timeframe, int(now.timestamp() * 1000)), now


class LiveTrader(Stateful):
    """mode smc: 채널 방식 자동매매."""

    def __init__(self, cfg: Config, feed, broker, state_path: str | Path,
                 notifier: Notifier | None = None):
        self.cfg = cfg
        self.feed = feed
        self.broker = broker
        self.notifier = notifier or Notifier(cfg.notify)
        st = self._init_state(state_path)
        self.last_bar: str | None = st.get("last_bar")
        self.pos: Position | None = Position.from_dict(st["position"]) if st.get("position") else None
        self.risk = RiskManager(cfg.risk, cfg.timezone, cfg.effective_max_leverage, st.get("risk"))
        self.tf = pd.Timedelta(seconds=timeframe_seconds(cfg.timeframe))
        if cfg.strategy.entry_mode != "market":
            raise ValueError("실시간 매매는 아직 지정가 진입(entry_mode: limit)을 지원하지 않습니다. "
                             "백테스트와 결과가 달라지므로 market 으로 두세요")
        broker.startup_check(self.pos)

    def _save(self) -> None:
        self._write({
            "last_bar": self.last_bar,
            "position": self.pos.to_dict() if self.pos else None,
            "risk": self.risk.to_dict(),
            "broker": self.broker.state(),
        })

    # ── 한 번의 판단 ──
    def step(self) -> None:
        df, now = closed_bars(self.feed, self.cfg.live.history_bars, self.cfg.timeframe)
        if len(df) < MIN_BARS:
            log.warning("봉 데이터가 부족합니다 (%d개)", len(df))
            return
        price = self.feed.last_price()
        if self.risk.day_of(now) != self.risk.s.day:
            self.risk.roll_day(now, self.broker.equity())

        bar_t = df.index[-1]
        new_bar = self.last_bar is None or bar_t > pd.Timestamp(self.last_bar)
        feats = prepare_features(df, self.cfg) if new_bar else None

        if self.pos is not None:
            self._manage(price, feats, now)

        if new_bar:
            self.last_bar = bar_t.isoformat()
            age = now - (bar_t + self.tf)
            if self.pos is None and not self.risk.can_trade():
                log.info("오늘은 손실 한도/연속 손실로 신규 진입을 쉽니다")
            elif self.pos is None and age > self.tf / 2:
                log.info("마감된 지 오래된 봉(%s)이라 진입 판단을 건너뜁니다", bar_t)
            elif self.pos is None:
                sig = generate_signal(feats, len(df) - 1, self.cfg.strategy, self.cfg.allow_short)
                if sig:
                    self._enter(sig, price, now)
                else:
                    log.info("%s 봉 마감: 신호 없음 (종가 %.2f)", bar_t, df["close"].iloc[-1])
        self._save()

    def _manage(self, price: float, feats: Features | None, now: pd.Timestamp) -> None:
        pos = self.pos
        if self.broker.native_exits:
            fills = self.broker.sync(pos, price, now)
        else:
            fills = [(ex, self.broker.execute(pos, ex, now)) for ex in plan_exits(pos, price, price, price)]
        for ex, px in fills:
            if ex.reason == "tp1" and not is_closed(pos):
                self.notifier.send(f"💰 1차 익절 {ex.qty:.6f} @ {px:,.2f} → 남은 물량 손절 본절({pos.stop:,.2f})")
        if is_closed(pos):
            ex, px = fills[-1]
            self._closed(trade_record(pos, ex, px, now.isoformat()))
            return
        if feats is not None and pos.tp1_done:
            new = trail_stop(feats, len(feats.index) - 1, pos.side, pos.stop, self.cfg.strategy)
            if new is not None:
                self.broker.update_stop(pos, new)
                self.notifier.send(f"🔒 손절 이동(트레일링): {pos.side} → {new:,.2f}")

    def _enter(self, sig, price: float, now: pd.Timestamp) -> None:
        if not entry_valid(sig.side, price, sig.stop, sig.tp1):
            log.info("신호(%s %s) 발생했지만 현재가 %.2f 가 이미 손절/1차 목표를 지나쳐 패스", sig.side, sig.setup, price)
            return
        qty = self.risk.size(self.broker.equity(), price, sig.stop)
        try:
            self.pos = self.broker.open(sig, qty, price, now)
        except Exception as e:
            self.notifier.send(f"⚠️ 진입 실패 ({sig.side} {sig.setup}): {e}")
            return
        p = self.pos
        self._save()
        self.notifier.send(
            f"{'🟢 롱' if p.is_long else '🔴 숏'} 진입 [{sig.setup}/{sig.trigger}] {self.cfg.symbol}\n"
            f"진입 {p.entry:,.2f} / 손절 {p.stop:,.2f} / 1차 익절 {p.tp1:,.2f} ({p.tp1_qty:.6f})"
            f"{f' / 최종 {p.tp2:,.2f}' if p.tp2 else ''}\n"
            f"수량 {p.qty:.6f}\n근거: {sig.reason}"
        )

    def _closed(self, tr: dict) -> None:
        self.risk.on_trade_closed(tr["pnl"])
        self._record(tr)
        self.pos = None
        self._save()
        icon = "✅" if tr["pnl"] > 0 else "❌"
        self.notifier.send(
            f"{icon} 청산 [{tr['reason']}] {tr['side']} {tr['entry']:,.2f} → {tr['exit']:,.2f} "
            f"손익 {tr['pnl']:+,.2f} ({tr['r']:+.2f}R)"
        )


class TrendTrader(Stateful):
    """mode hybrid: 일봉 추세추종 자동매매 (trend.py 규칙). 실제 주문은 이것만 낸다."""

    label = "추세추종"

    def __init__(self, cfg: Config, feed, broker, state_path: str | Path, notifier: Notifier | None = None):
        self.cfg, self.p = cfg, cfg.trend
        self.feed, self.broker = feed, broker
        self.notifier = notifier or Notifier(cfg.notify)
        st = self._init_state(state_path)
        self.last_bar: str | None = st.get("last_bar")
        self.pos: Position | None = Position.from_dict(st["position"]) if st.get("position") else None
        self.pending_exit: str | None = st.get("pending_exit")  # 청산 주문이 실패했으면 다음 확인 때 재시도
        self.tf = pd.Timedelta(seconds=timeframe_seconds(self.p.timeframe))
        self.history = max(self.p.entry_days, self.p.exit_days, self.p.atr_period) * 3 + 10
        broker.startup_check(self.pos)

    def _save(self) -> None:
        self._write({"last_bar": self.last_bar, "position": self.pos.to_dict() if self.pos else None,
                     "pending_exit": self.pending_exit, "broker": self.broker.state()})

    def status_text(self) -> str:
        if self.pos is None:
            return "추세추종 봇: 현금 대기 (돌파 기다리는 중)"
        stop = f", 비상 손절 {self.pos.stop:,.0f}" if self.pos.stop else ""
        return f"추세추종 봇: {'롱' if self.pos.is_long else '숏'} 보유 중 (진입 {self.pos.entry:,.0f}{stop})"

    def step(self) -> None:
        df, now = closed_bars(self.feed, self.history, self.p.timeframe)
        if len(df) < max(self.p.entry_days, self.p.atr_period) + 2:
            log.warning("[추세추종] 일봉 데이터가 부족합니다 (%d개)", len(df))
            return
        price = self.feed.last_price()
        if self.pos is not None:
            self._sync(price, now)
        if self.pos is not None and self.pending_exit:
            self._exit(price, now, self.pending_exit)

        bar_t = df.index[-1]
        if self.last_bar is not None and bar_t <= pd.Timestamp(self.last_bar):
            self._save()
            return
        self.last_bar = bar_t.isoformat()
        if now - (bar_t + self.tf) > pd.Timedelta(hours=self.p.max_delay_hours):
            log.info("[추세추종] 일봉(%s) 마감 후 %.0f시간이 지나 오늘 판단은 건너뜁니다", bar_t.date(),
                     self.p.max_delay_hours)
            self._save()
            return

        lv = trend_levels(df, self.p)
        i = len(df) - 1
        action = decide(lv, i, self.pos.side if self.pos else None, self.p)
        if action == "exit":
            self._exit(price, now, reason_text(lv, i, action, self.p))
        elif action in ("long", "short"):
            self._enter(action, lv, i, price, now)
        elif self.pos is not None:
            new = next_stop(lv, i, self.pos.side, self.pos.stop or None)
            if new is not None and new != self.pos.stop:
                self.broker.update_stop(self.pos, new)
                log.info("[추세추종] 비상 손절 이동 → %.2f", new)
        else:
            log.info("[추세추종] %s 일봉 마감: 종가 %.0f, 진입 기준(직전 %d일 최고가) %.0f",
                     bar_t.date(), lv.close[i], self.p.entry_days, lv.entry_hi[i])
        self._save()

    def _sync(self, price: float, now: pd.Timestamp) -> None:
        pos = self.pos
        if self.broker.native_exits:
            fills = self.broker.sync(pos, price, now)
        else:
            fills = [(ex, self.broker.execute(pos, ex, now))
                     for ex in (plan_exits(pos, price, price, price) if pos.stop else [])]
        if is_closed(pos):
            px = fills[-1][1]
            self._closed(trade_record(pos, Exit(px, 0.0, EMERGENCY, False), px, now.isoformat()),
                         "⛔ 거래소 비상 손절 체결")

    def _enter(self, side: str, lv, i: int, price: float, now: pd.Timestamp) -> None:
        stop = next_stop(lv, i, side, None) or 0.0
        if stop and not (stop < price if side == "long" else stop > price):
            log.info("[추세추종] 현재가 %.0f 가 이미 비상 손절가 %.0f 를 넘어 진입하지 않음", price, stop)
            return
        qty = self.broker.equity() * self.p.exposure / price
        reason = reason_text(lv, i, side, self.p)
        sig = Signal(side, "trend", "breakout", price, stop, 0.0, 0.0, lv.entry_hi[i], lv.index[i], reason)
        try:
            self.pos = self.broker.open(sig, qty, price, now, tp1_fraction=0.0)
        except Exception as e:
            self.notifier.send(f"⚠️ [추세추종] 진입 실패: {e}")
            return
        self._save()
        p = self.pos
        self.notifier.send(
            f"{'🟢 롱' if p.is_long else '🔴 숏'} 진입 [추세추종] {self.cfg.symbol}\n"
            f"진입 {p.entry:,.2f} / 수량 {p.qty:.6f} (명목가치 = 자산 x {self.p.exposure:g})\n"
            f"비상 손절 {p.stop:,.2f} (거래소 주문)\n근거: {reason}"
        )

    def _exit(self, price: float, now: pd.Timestamp, reason: str) -> None:
        pos = self.pos
        try:
            px = self.broker.execute(pos, Exit(price, pos.qty, "signal", False), now)
        except Exception as e:
            if not self.pending_exit:
                self.notifier.send(f"⚠️ [추세추종] 청산 실패, 다음 확인 때 다시 시도합니다: {e}")
            self.pending_exit = reason
            self._save()
            return
        self.pending_exit = None
        self._closed(trade_record(pos, Exit(px, 0.0, "signal", False), px, now.isoformat()), f"🏁 {reason}")

    def _closed(self, tr: dict, why: str) -> None:
        self._record(tr)
        self.pos = None
        self._save()
        self.notifier.send(f"{'✅' if tr['pnl'] > 0 else '❌'} 청산 [추세추종] {why}\n"
                           f"{tr['entry']:,.2f} → {tr['exit']:,.2f}, 손익 {tr['pnl']:+,.2f}")


class SignalAlerter(Stateful):
    """mode hybrid: 채널 방식 신호를 알림으로만 보낸다 (주문 없음)."""

    label = "채널 신호 알림"

    def __init__(self, cfg: Config, feed, state_path: str | Path, notifier: Notifier | None = None,
                 status: Callable[[], str] | None = None):
        self.cfg, self.feed = cfg, feed
        self.notifier = notifier or Notifier(cfg.notify)
        self.status = status
        st = self._init_state(state_path)
        self.last_bar: str | None = st.get("last_bar")
        self.tf = pd.Timedelta(seconds=timeframe_seconds(cfg.timeframe))

    def step(self) -> None:
        df, now = closed_bars(self.feed, self.cfg.live.history_bars, self.cfg.timeframe)
        if len(df) < MIN_BARS:
            log.warning("[알림] 봉 데이터가 부족합니다 (%d개)", len(df))
            return
        bar_t = df.index[-1]
        if self.last_bar is not None and bar_t <= pd.Timestamp(self.last_bar):
            return
        self.last_bar = bar_t.isoformat()
        self._write({"last_bar": self.last_bar})
        if now - (bar_t + self.tf) > self.tf / 2:
            return
        sig = generate_signal(prepare_features(df, self.cfg), len(df) - 1, self.cfg.strategy, allow_short=True)
        if sig is None:
            return
        r = abs(sig.ref_price - sig.stop)
        lines = [
            f"📣 채널 방식 신호 (자동 주문 아님) {self.cfg.symbol} {self.cfg.timeframe}",
            f"{'🟢 롱' if sig.side == 'long' else '🔴 숏'} 후보 [{sig.setup}/{sig.trigger}]",
            f"기준가 {sig.ref_price:,.2f} / 손절 {sig.stop:,.2f} / 1차 익절 {sig.tp1:,.2f} "
            f"({abs(sig.tp1 - sig.ref_price) / r:.1f}R)" if r else "",
            f"근거: {sig.reason}",
        ]
        if self.status:
            lines.append(self.status())
        self.notifier.send("\n".join(x for x in lines if x))


def run_forever(components: list, poll_seconds: int, notifier: Notifier, start_text: str,
                sleep: Callable[[float], None] = time.sleep) -> None:
    notifier.send(start_text)
    errors = {id(c): 0 for c in components}
    while True:
        for c in components:
            try:
                c.step()
                errors[id(c)] = 0
            except KeyboardInterrupt:
                raise
            except Exception as e:
                errors[id(c)] += 1
                n = errors[id(c)]
                log.exception("루프 오류 (%s)", getattr(c, "label", type(c).__name__))
                if n in (1, 10, 100):
                    notifier.send(f"⚠️ {getattr(c, 'label', type(c).__name__)} 오류 {n}회 연속: {e}")
        sleep(poll_seconds)
