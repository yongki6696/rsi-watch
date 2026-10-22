"""실시간 매매 루프 (모의/실거래 공용).

poll_seconds 마다:
  1) 보유 포지션 관리 - 거래소에서 체결된 익절/손절 반영, 또는 현재가로 직접 판정(현물/모의)
  2) 새 봉이 마감됐으면 - 남은 물량 손절 트레일링, 포지션이 없으면 신호 계산 후 진입
상태(포지션, 마지막 처리 봉, 일일 손실 등)는 JSON 파일에 저장돼 재시작해도 이어진다.
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
from .strategy import Features, generate_signal, prepare_features, trail_stop
from .timeframes import timeframe_seconds
from .trade import Position, entry_valid, is_closed, plan_exits, trade_record

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


class LiveTrader:
    def __init__(self, cfg: Config, feed, broker, state_path: str | Path,
                 notifier: Notifier | None = None):
        self.cfg = cfg
        self.feed = feed
        self.broker = broker
        self.notifier = notifier or Notifier(cfg.notify)
        self.state_path = Path(state_path)
        self.trades_path = self.state_path.with_suffix(".trades.csv")
        st = self._load()
        self.last_bar: str | None = st.get("last_bar")
        self.pos: Position | None = Position.from_dict(st["position"]) if st.get("position") else None
        self.risk = RiskManager(cfg.risk, cfg.timezone, cfg.effective_max_leverage, st.get("risk"))
        self.tf = pd.Timedelta(seconds=timeframe_seconds(cfg.timeframe))
        broker.startup_check(self.pos)

    # ── 상태 저장 ──
    def _load(self) -> dict:
        if self.state_path.exists():
            return json.loads(self.state_path.read_text(encoding="utf-8"))
        return {}

    def _save(self) -> None:
        st = {
            "last_bar": self.last_bar,
            "position": self.pos.to_dict() if self.pos else None,
            "risk": self.risk.to_dict(),
            "broker": self.broker.state(),
        }
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

    # ── 한 번의 판단 ──
    def step(self) -> None:
        now = pd.Timestamp(self.feed.now_ms(), unit="ms", tz="UTC")
        df = drop_unclosed(self.feed.recent(self.cfg.live.history_bars), self.cfg.timeframe,
                           int(now.timestamp() * 1000))
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
        if feats is not None and pos.tp1_done and self.cfg.strategy.runner == "trail":
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


def run_forever(trader: LiveTrader, poll_seconds: int, sleep: Callable[[float], None] = time.sleep) -> None:
    trader.notifier.send(f"▶️ 봇 시작: {trader.cfg.symbol} {trader.cfg.timeframe} "
                         f"({trader.broker.label})")
    errors = 0
    while True:
        try:
            trader.step()
            errors = 0
        except KeyboardInterrupt:
            raise
        except Exception as e:
            errors += 1
            log.exception("루프 오류")
            if errors in (1, 10, 100):
                trader.notifier.send(f"⚠️ 오류 {errors}회 연속: {e}")
        sleep(poll_seconds)
