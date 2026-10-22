"""포지션과 청산 판정. 백테스트와 실시간 매매가 같은 규칙을 쓰도록 한 곳에 둔다.

관리 방식 (채널: "부분 익절 후 잔여 물량은 본절 로스 걸고 보유")
  - tp1 에서 tp1_qty 만큼 지정가 익절 → 손절을 진입가(본절)로
  - 남은 물량은 손절(본절 → 스윙 트레일링) 또는 tp2 까지 보유
"""
from __future__ import annotations

import copy
from dataclasses import asdict, dataclass, field

from .config import CostParams


@dataclass
class Position:
    side: str            # long | short
    qty: float           # 남은 수량 (BTC)
    entry: float
    stop: float
    initial_stop: float
    tp1: float
    tp1_qty: float
    tp2: float           # 0 이면 없음
    opened_at: str
    setup: str = ""
    initial_qty: float = 0.0
    tp1_done: bool = False
    realized: float = 0.0   # 지금까지 확정된 순손익 (수수료 포함)
    order_ids: dict = field(default_factory=dict)

    def __post_init__(self):
        if not self.initial_qty:
            self.initial_qty = self.qty

    @property
    def is_long(self) -> bool:
        return self.side == "long"

    @property
    def risk_amount(self) -> float:
        return abs(self.entry - self.initial_stop) * self.initial_qty

    def gross(self, price: float, qty: float) -> float:
        d = price - self.entry
        return qty * (d if self.is_long else -d)

    def stop_reason(self) -> str:
        if self.stop == self.initial_stop:
            return "stop"
        if self.stop == self.entry:
            return "breakeven"
        return "trail"

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "Position":
        return cls(**d)


@dataclass
class Exit:
    price: float     # 계획 체결가 (슬리피지 전)
    qty: float
    reason: str      # tp1 | tp2 | stop | breakeven | trail | end | manual
    maker: bool      # 지정가 익절이면 True (메이커 수수료, 슬리피지 없음)


def new_position(side, qty, entry, stop, tp1, tp2, tp1_fraction, opened_at, setup, entry_fee) -> Position:
    pos = Position(side, qty, entry, stop, stop, tp1, qty * tp1_fraction, tp2, opened_at, setup)
    pos.realized = -entry_fee
    return pos


def plan_exits(pos: Position, o: float, h: float, l: float) -> list[Exit]:
    """한 봉(OHLC) 동안 일어날 청산을 순서대로 계획한다. pos 는 바꾸지 않는다.

    보수적 가정: 같은 봉에서 손절과 익절이 모두 닿으면 손절 먼저,
    1차 익절 뒤 같은 봉에서 본절까지 되돌렸으면 본절 청산.
    """
    p = copy.deepcopy(pos)
    out: list[Exit] = []
    long = p.is_long

    def beyond(price, level, favorable):  # favorable: 익절 방향으로 넘었는지
        return (price >= level) if (long == favorable) else (price <= level)

    def take(price, qty, reason, maker):
        out.append(Exit(price, qty, reason, maker))
        p.qty -= qty
        if reason == "tp1":
            p.tp1_done = True
            if (p.stop < p.entry) if long else (p.stop > p.entry):
                p.stop = p.entry

    # 1) 시가 갭
    if beyond(o, p.stop, False):
        take(o, p.qty, p.stop_reason(), False)
        return out
    if not p.tp1_done and p.tp1_qty > 0 and beyond(o, p.tp1, True):
        take(o, min(p.tp1_qty, p.qty), "tp1", True)
    if p.qty > 1e-12 and p.tp2 and beyond(o, p.tp2, True):
        take(o, p.qty, "tp2", True)
        return out
    # 2) 봉 안에서 손절 먼저
    if p.qty > 1e-12 and beyond(l if long else h, p.stop, False):
        take(p.stop, p.qty, p.stop_reason(), False)
        return out
    # 3) 1차 익절
    if p.qty > 1e-12 and not p.tp1_done and p.tp1_qty > 0 and beyond(h if long else l, p.tp1, True):
        take(p.tp1, min(p.tp1_qty, p.qty), "tp1", True)
        if p.qty > 1e-12 and beyond(l if long else h, p.stop, False):
            take(p.stop, p.qty, p.stop_reason(), False)
            return out
    # 4) 최종 목표
    if p.qty > 1e-12 and p.tp2 and beyond(h if long else l, p.tp2, True):
        take(p.tp2, p.qty, "tp2", True)
    return out


def apply_exit(pos: Position, ex: Exit, fill_price: float, fee_rate: float) -> float:
    """실제 체결가로 청산을 반영하고 이번 체결의 순손익을 돌려준다."""
    qty = min(ex.qty, pos.qty)
    pnl = pos.gross(fill_price, qty) - fill_price * qty * fee_rate
    pos.qty -= qty
    pos.realized += pnl
    if pos.qty < 1e-12:
        pos.qty = 0.0
    if ex.reason == "tp1":
        pos.tp1_done = True
        if (pos.stop < pos.entry) if pos.is_long else (pos.stop > pos.entry):
            pos.stop = pos.entry
    return pnl


def exit_fill(ex: Exit, side: str, costs: CostParams) -> tuple[float, float]:
    """백테스트/모의매매 체결가와 수수료율. 지정가 익절은 그대로, 시장가 손절은 슬리피지."""
    if ex.maker:
        return ex.price, costs.maker_fee_rate
    return slipped(ex.price, side, False, costs.slippage), costs.fee_rate


def is_closed(pos: Position) -> bool:
    return pos.qty <= 1e-12


def trade_record(pos: Position, last: Exit, exit_price: float, closed_at: str) -> dict:
    return {
        "opened_at": pos.opened_at,
        "closed_at": closed_at,
        "side": pos.side,
        "setup": pos.setup,
        "entry": pos.entry,
        "exit": exit_price,
        "qty": pos.initial_qty,
        "initial_stop": pos.initial_stop,
        "tp1": pos.tp1,
        "tp1_done": pos.tp1_done,
        "reason": last.reason,
        "pnl": pos.realized,
        "r": pos.realized / pos.risk_amount if pos.risk_amount > 0 else 0.0,
    }


def entry_valid(side: str, price: float, stop: float, tp1: float) -> bool:
    """현재 가격이 아직 손절과 1차 목표 사이에 있는지 (이미 지나쳤으면 진입 안 함)."""
    return stop < price < tp1 if side == "long" else tp1 < price < stop


def slipped(price: float, side: str, opening: bool, slippage: float) -> float:
    """시장가 체결의 불리한 미끄러짐. 롱 진입/숏 청산은 위로, 롱 청산/숏 진입은 아래로."""
    buying = (side == "long") == opening
    return price * (1 + slippage) if buying else price * (1 - slippage)
