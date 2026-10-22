"""포지션과 청산 판정. 백테스트와 모의매매가 같은 규칙을 쓰도록 한 곳에 둔다."""
from __future__ import annotations

from dataclasses import asdict, dataclass, field


@dataclass
class Position:
    side: str            # long | short
    qty: float           # 기초자산 수량 (BTC)
    entry: float
    stop: float
    target: float
    initial_stop: float
    opened_at: str       # ISO 시각
    setup: str = ""
    entry_fee: float = 0.0
    order_ids: dict = field(default_factory=dict)

    @property
    def is_long(self) -> bool:
        return self.side == "long"

    @property
    def risk_per_unit(self) -> float:
        return abs(self.entry - self.initial_stop)

    def gross_pnl(self, price: float) -> float:
        d = price - self.entry
        return self.qty * (d if self.is_long else -d)

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "Position":
        return cls(**d)


def check_exit(pos: Position, o: float, h: float, l: float) -> tuple[float, str] | None:
    """한 봉(OHLC) 동안 손절/익절 체결 여부. 같은 봉에서 둘 다 닿으면 보수적으로 손절 우선."""
    if pos.is_long:
        if o <= pos.stop:
            return o, "stop"
        if o >= pos.target:
            return o, "target"
        if l <= pos.stop:
            return pos.stop, "stop"
        if h >= pos.target:
            return pos.target, "target"
    else:
        if o >= pos.stop:
            return o, "stop"
        if o <= pos.target:
            return o, "target"
        if h >= pos.stop:
            return pos.stop, "stop"
        if l <= pos.target:
            return pos.target, "target"
    return None


def check_price_exit(pos: Position, price: float) -> str | None:
    """실시간 가격 한 점으로 손절/익절 판정 (소프트웨어 청산용)."""
    if pos.is_long:
        if price <= pos.stop:
            return "stop"
        if price >= pos.target:
            return "target"
    else:
        if price >= pos.stop:
            return "stop"
        if price <= pos.target:
            return "target"
    return None


def breakeven_price(pos: Position, h: float, l: float, at_r: float) -> float | None:
    """+at_r R 도달 시 손절을 진입가로 올릴 가격. 이미 옮겼거나 해당 없으면 None."""
    if at_r <= 0:
        return None
    r = pos.risk_per_unit
    if pos.is_long and pos.stop < pos.entry and h >= pos.entry + at_r * r:
        return pos.entry
    if not pos.is_long and pos.stop > pos.entry and l <= pos.entry - at_r * r:
        return pos.entry
    return None


def entry_valid(side: str, price: float, stop: float, target: float, min_rr: float) -> bool:
    """현재 가격 기준으로도 손절·목표 사이에 있고 손익비가 유지되는지."""
    if side == "long":
        if not stop < price < target:
            return False
        return (target - price) / (price - stop) >= min_rr
    if not target < price < stop:
        return False
    return (price - target) / (stop - price) >= min_rr


def close_trade(pos: Position, price: float, reason: str, closed_at: str, fee_rate: float) -> dict:
    """청산 기록. 진입·청산 수수료를 뺀 순손익과 R 배수를 계산한다."""
    if reason == "stop" and pos.stop == pos.entry:
        reason = "breakeven"
    exit_fee = price * pos.qty * fee_rate
    net = pos.gross_pnl(price) - pos.entry_fee - exit_fee
    risk_amt = pos.risk_per_unit * pos.qty
    return {
        "opened_at": pos.opened_at,
        "closed_at": closed_at,
        "side": pos.side,
        "setup": pos.setup,
        "entry": pos.entry,
        "exit": price,
        "qty": pos.qty,
        "initial_stop": pos.initial_stop,
        "target": pos.target,
        "reason": reason,
        "pnl": net,
        "r": net / risk_amt if risk_amt > 0 else 0.0,
        "exit_fee": exit_fee,
    }


def slipped(price: float, side: str, opening: bool, slippage: float) -> float:
    """시장가 체결의 불리한 미끄러짐. 롱 진입/숏 청산은 위로, 롱 청산/숏 진입은 아래로."""
    buying = (side == "long") == opening
    return price * (1 + slippage) if buying else price * (1 - slippage)
