"""자금 관리: 1회 손실 한도 기반 수량 계산, 일일 손실 한도, 연속 손실 휴식."""
from __future__ import annotations

from dataclasses import asdict, dataclass
from zoneinfo import ZoneInfo

import pandas as pd

from .config import RiskParams


@dataclass
class RiskState:
    day: str = ""
    day_start_equity: float = 0.0
    day_pnl: float = 0.0
    loss_streak: int = 0
    blocked: bool = False


class RiskManager:
    def __init__(self, params: RiskParams, timezone: str, max_leverage: float, state: dict | None = None):
        self.p = params
        self.tz = ZoneInfo(timezone)
        self.max_leverage = max_leverage
        self.s = RiskState(**state) if state else RiskState()

    def day_of(self, t: pd.Timestamp) -> str:
        return t.tz_convert(self.tz).date().isoformat()

    def roll_day(self, t: pd.Timestamp, equity: float) -> None:
        day = self.day_of(t)
        if day != self.s.day:
            self.s.day = day
            self.s.day_start_equity = equity
            self.s.day_pnl = 0.0
            self.s.blocked = False

    def can_trade(self) -> bool:
        if self.s.blocked:
            return False
        limit = self.p.daily_loss_limit * self.s.day_start_equity
        return not (limit > 0 and self.s.day_pnl <= -limit)

    def on_trade_closed(self, pnl: float) -> None:
        self.s.day_pnl += pnl
        self.s.loss_streak = self.s.loss_streak + 1 if pnl < 0 else 0
        if self.p.max_consecutive_losses > 0 and self.s.loss_streak >= self.p.max_consecutive_losses:
            self.s.blocked = True
            self.s.loss_streak = 0

    def size(self, equity: float, entry: float, stop: float) -> float:
        """손절 시 손실이 자산 x risk_per_trade 가 되는 수량. 레버리지 상한으로 자른다."""
        per_unit = abs(entry - stop)
        if equity <= 0 or per_unit <= 0 or entry <= 0:
            return 0.0
        qty = equity * self.p.risk_per_trade / per_unit
        cap = equity * self.max_leverage / entry
        return min(qty, cap)

    def to_dict(self) -> dict:
        return asdict(self.s)
