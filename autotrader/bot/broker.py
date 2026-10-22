"""주문 실행.

PaperBroker : 실제 주문 없이 가상 잔고로 체결 (기본값)
CcxtBroker  : ccxt 로 거래소에 실제 주문. 선물은 거래소에 손절/익절(reduceOnly) 주문을 함께 건다.
"""
from __future__ import annotations

import logging

import pandas as pd

from .config import Config
from .strategy import Signal
from .trade import Position, close_trade, slipped

log = logging.getLogger(__name__)


class PaperBroker:
    label = "모의매매"
    native_exits = False

    def __init__(self, cfg: Config, state: dict | None = None):
        self.cfg = cfg
        self.cash = float((state or {}).get("cash", cfg.initial_equity))

    def equity(self) -> float:
        return self.cash

    def open(self, sig: Signal, qty: float, price: float, t: pd.Timestamp) -> Position:
        fill = slipped(price, sig.side, True, self.cfg.costs.slippage)
        fee = fill * qty * self.cfg.costs.fee_rate
        self.cash -= fee
        return Position(sig.side, qty, fill, sig.stop, sig.target, sig.stop, t.isoformat(), sig.setup,
                        entry_fee=fee)

    def close(self, pos: Position, price: float, reason: str, t: pd.Timestamp) -> dict:
        if reason != "target":
            price = slipped(price, pos.side, False, self.cfg.costs.slippage)
        tr = close_trade(pos, price, reason, t.isoformat(), self.cfg.costs.fee_rate)
        self.cash += pos.gross_pnl(price) - tr["exit_fee"]
        return tr

    def update_stop(self, pos: Position, new_stop: float) -> None:
        pos.stop = new_stop

    def sync(self, pos: Position, price: float, t: pd.Timestamp) -> dict | None:
        return None

    def startup_check(self, pos: Position | None) -> None:
        pass

    def state(self) -> dict:
        return {"cash": self.cash}


class OrderTooSmall(Exception):
    pass


class CcxtBroker:
    label = "실거래"

    def __init__(self, ex, cfg: Config):
        self.ex = ex
        self.cfg = cfg
        self.symbol = cfg.symbol
        ex.load_markets()
        self.market = ex.market(cfg.symbol)
        self.contract = bool(self.market.get("contract"))
        if cfg.allow_short != self.contract:
            raise ValueError(f"market_type={cfg.exchange.market_type} 인데 심볼 {cfg.symbol} 은 "
                             f"{'선물' if self.contract else '현물'} 입니다. 심볼 형식을 확인하세요 "
                             f"(선물 예: BTC/USDT:USDT, 현물 예: BTC/USDT, BTC/KRW)")
        mode = cfg.live.exits
        if mode == "exchange" and not self.contract:
            raise ValueError("현물은 거래소 손절 주문 방식을 지원하지 않습니다. live.exits: software 를 쓰세요")
        self.native_exits = mode == "exchange" or (mode == "auto" and self.contract)
        self.quote = self.market.get("settle") or self.market["quote"]
        self.base = self.market["base"]
        self.contract_size = float(self.market.get("contractSize") or 1) if self.contract else 1.0
        if self.contract and cfg.exchange.leverage:
            try:
                ex.set_leverage(cfg.exchange.leverage, self.symbol)
            except Exception as e:  # 거래소마다 지원/권한이 달라 실패해도 진행
                log.warning("레버리지 설정 실패(무시하고 진행): %s", e)

    # ── 조회 ──
    def equity(self) -> float:
        bal = self.ex.fetch_balance()
        return float((bal.get("total") or {}).get(self.quote) or 0.0)

    def _exchange_position_amount(self) -> float:
        if not self.contract:
            bal = self.ex.fetch_balance()
            return float((bal.get("total") or {}).get(self.base) or 0.0)
        positions = self.ex.fetch_positions([self.symbol])
        return sum(abs(float(p.get("contracts") or 0)) for p in positions if p.get("symbol") == self.symbol)

    def startup_check(self, pos: Position | None) -> None:
        """봇 상태와 거래소 포지션이 어긋나면 시작하지 않는다."""
        if pos is None and self.contract and self._exchange_position_amount() > 0:
            raise RuntimeError("거래소에 봇이 모르는 포지션이 있습니다. 직접 정리한 뒤 다시 시작하세요.")

    # ── 수량 ──
    def _amount(self, qty: float, price: float) -> float:
        amount = float(self.ex.amount_to_precision(self.symbol, qty / self.contract_size))
        limits = self.market.get("limits") or {}
        min_amt = (limits.get("amount") or {}).get("min") or 0
        min_cost = (limits.get("cost") or {}).get("min") or 0
        if amount <= 0 or amount < min_amt or amount * self.contract_size * price < min_cost:
            raise OrderTooSmall(f"주문 수량 {qty:.8f} 이 거래소 최소 주문 기준보다 작습니다")
        return amount

    def _market(self, side: str, amount: float, price: float, reduce_only: bool) -> dict:
        params = {"reduceOnly": True} if (reduce_only and self.contract) else {}
        px = None
        if not self.contract and side == "buy" and self.ex.options.get("createMarketBuyOrderRequiresPrice"):
            px = price  # 업비트 등: 시장가 매수는 총액(수량 x 가격)으로 주문
        return self.ex.create_order(self.symbol, "market", side, amount, px, params)

    def _trigger(self, pos: Position, amount: float, key: str, trigger: float) -> str:
        opp = "sell" if pos.is_long else "buy"
        params = {key: float(self.ex.price_to_precision(self.symbol, trigger)), "reduceOnly": True}
        order = self.ex.create_order(self.symbol, "market", opp, amount, None, params)
        return str(order["id"])

    def _cancel(self, pos: Position, *keys: str) -> None:
        for k in keys:
            oid = pos.order_ids.pop(k, None)
            if oid:
                try:
                    self.ex.cancel_order(oid, self.symbol)
                except Exception as e:  # 이미 체결/취소된 주문
                    log.info("주문 %s(%s) 취소 생략: %s", k, oid, e)

    # ── 실행 ──
    def open(self, sig: Signal, qty: float, price: float, t: pd.Timestamp) -> Position:
        amount = self._amount(qty, price)
        side = "buy" if sig.side == "long" else "sell"
        order = self._market(side, amount, price, reduce_only=False)
        fill = float(order.get("average") or order.get("price") or price)
        filled = float(order.get("filled") or amount)
        qty_filled = filled * self.contract_size
        pos = Position(sig.side, qty_filled, fill, sig.stop, sig.target, sig.stop, t.isoformat(), sig.setup,
                       entry_fee=fill * qty_filled * self.cfg.costs.fee_rate,
                       order_ids={"entry": str(order.get("id"))})
        if self.native_exits:
            try:
                pos.order_ids["sl"] = self._trigger(pos, filled, "stopLossPrice", sig.stop)
                pos.order_ids["tp"] = self._trigger(pos, filled, "takeProfitPrice", sig.target)
            except Exception:
                log.exception("손절/익절 주문 실패 → 안전을 위해 즉시 시장가 청산")
                self._cancel(pos, "sl", "tp")
                self._market("sell" if pos.is_long else "buy", filled, price, reduce_only=True)
                raise
        return pos

    def close(self, pos: Position, price: float, reason: str, t: pd.Timestamp) -> dict:
        self._cancel(pos, "sl", "tp")
        amount = float(self.ex.amount_to_precision(self.symbol, pos.qty / self.contract_size))
        if not self.contract:  # 현물 매수 수수료가 코인으로 빠졌을 수 있어 실제 보유량으로 자름
            free = float((self.ex.fetch_balance().get("free") or {}).get(self.base) or 0.0)
            amount = float(self.ex.amount_to_precision(self.symbol, min(amount, free)))
        order = self._market("sell" if pos.is_long else "buy", amount, price, reduce_only=True)
        fill = float(order.get("average") or order.get("price") or price)
        return close_trade(pos, fill, reason, t.isoformat(), self.cfg.costs.fee_rate)

    def update_stop(self, pos: Position, new_stop: float) -> None:
        if self.native_exits:
            amount = float(self.ex.amount_to_precision(self.symbol, pos.qty / self.contract_size))
            old = pos.order_ids.get("sl")
            pos.order_ids["sl"] = self._trigger(pos, amount, "stopLossPrice", new_stop)  # 새 손절 먼저
            if old:
                try:
                    self.ex.cancel_order(old, self.symbol)
                except Exception as e:
                    log.info("기존 손절 주문 취소 생략: %s", e)
        pos.stop = new_stop

    def sync(self, pos: Position, price: float, t: pd.Timestamp) -> dict | None:
        """거래소 손절/익절로 포지션이 이미 닫혔는지 확인하고, 닫혔으면 청산 기록을 만든다."""
        if not self.native_exits or self._exchange_position_amount() > 0:
            return None
        reason, fill = None, None
        for key, rsn in (("tp", "target"), ("sl", "stop")):
            oid = pos.order_ids.get(key)
            if not oid:
                continue
            try:
                o = self.ex.fetch_order(oid, self.symbol)
            except Exception as e:
                log.info("주문 %s 조회 실패: %s", oid, e)
                continue
            if o.get("status") == "closed":
                reason = rsn
                fill = float(o.get("average") or (pos.target if rsn == "target" else pos.stop))
                break
        if reason is None:  # 조회가 안 되면 현재가에 더 가까운 쪽으로 추정
            reason = "target" if abs(price - pos.target) < abs(price - pos.stop) else "stop"
            fill = pos.target if reason == "target" else pos.stop
        self._cancel(pos, "sl", "tp")
        return close_trade(pos, fill, reason, t.isoformat(), self.cfg.costs.fee_rate)

    def state(self) -> dict:
        return {}
