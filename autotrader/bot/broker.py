"""주문 실행.

PaperBroker : 실제 주문 없이 가상 잔고로 체결 (기본값)
CcxtBroker  : ccxt 로 거래소에 실제 주문.
              선물은 진입과 동시에 거래소에 손절(스탑 마켓)·1차 익절(지정가)·최종 목표(지정가)를
              reduceOnly 로 걸어 둔다. 봇이 꺼져도 손절은 거래소에서 실행된다.
              현물(업비트 등)은 거래소 손절 주문이 없어 봇이 현재가를 보고 시장가로 청산한다.
"""
from __future__ import annotations

import logging

import pandas as pd

from .config import Config
from .strategy import Signal
from .trade import Exit, Position, apply_exit, exit_fill, new_position, slipped

log = logging.getLogger(__name__)

TRIGGER = {"trigger": True}  # 조건부(스탑) 주문 조회·취소 시 필요 (바이낸스 선물은 algo 주문으로 처리됨)


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
        return new_position(sig.side, qty, fill, sig.stop, sig.tp1, sig.tp2, self.cfg.strategy.tp1_fraction,
                            t.isoformat(), f"{sig.setup}/{sig.trigger}", fee)

    def execute(self, pos: Position, ex: Exit, t: pd.Timestamp) -> float:
        price, fee = exit_fill(ex, pos.side, self.cfg.costs)
        self.cash += apply_exit(pos, ex, price, fee)
        return price

    def update_stop(self, pos: Position, new_stop: float) -> None:
        pos.stop = new_stop

    def sync(self, pos: Position, price: float, t: pd.Timestamp) -> list[tuple[Exit, float]]:
        return []

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

    def _position_qty(self) -> float:
        """거래소의 현재 포지션 크기 (기초자산 단위)."""
        if not self.contract:
            bal = self.ex.fetch_balance()
            return float((bal.get("total") or {}).get(self.base) or 0.0)
        positions = self.ex.fetch_positions([self.symbol])
        contracts = sum(abs(float(p.get("contracts") or 0)) for p in positions if p.get("symbol") == self.symbol)
        return contracts * self.contract_size

    def startup_check(self, pos: Position | None) -> None:
        """봇 상태와 거래소 포지션이 어긋나면 시작하지 않는다."""
        if pos is None and self.contract and self._position_qty() > 0:
            raise RuntimeError("거래소에 봇이 모르는 포지션이 있습니다. 직접 정리한 뒤 다시 시작하세요.")

    # ── 수량/가격 ──
    def _amount(self, qty: float) -> float:
        return float(self.ex.amount_to_precision(self.symbol, qty / self.contract_size))

    def _price(self, price: float) -> float:
        return float(self.ex.price_to_precision(self.symbol, price))

    def _check_min(self, amount: float, price: float) -> None:
        limits = self.market.get("limits") or {}
        min_amt = (limits.get("amount") or {}).get("min") or 0
        min_cost = (limits.get("cost") or {}).get("min") or 0
        if amount <= 0 or amount < min_amt or amount * self.contract_size * price < min_cost:
            raise OrderTooSmall(f"주문 수량 {amount} 이 거래소 최소 주문 기준보다 작습니다")

    # ── 주문 ──
    def _market(self, side: str, amount: float, price: float, reduce_only: bool) -> dict:
        params = {"reduceOnly": True} if (reduce_only and self.contract) else {}
        px = None
        if not self.contract and side == "buy" and self.ex.options.get("createMarketBuyOrderRequiresPrice"):
            px = price  # 업비트 등: 시장가 매수는 총액(수량 x 가격)으로 주문
        return self.ex.create_order(self.symbol, "market", side, amount, px, params)

    def _stop_order(self, pos: Position, stop: float) -> str:
        opp = "sell" if pos.is_long else "buy"
        params = {"stopLossPrice": self._price(stop), "reduceOnly": True}
        return str(self.ex.create_order(self.symbol, "market", opp, self._amount(pos.qty), None, params)["id"])

    def _limit_exit(self, pos: Position, qty: float, price: float) -> str:
        opp = "sell" if pos.is_long else "buy"
        order = self.ex.create_order(self.symbol, "limit", opp, self._amount(qty), self._price(price),
                                     {"reduceOnly": True})
        return str(order["id"])

    def _cancel(self, pos: Position, *keys: str) -> None:
        for k in keys:
            oid = pos.order_ids.pop(k, None)
            if oid:
                try:
                    self.ex.cancel_order(oid, self.symbol, TRIGGER if k == "sl" else {})
                except Exception as e:  # 이미 체결/취소된 주문
                    log.info("주문 %s(%s) 취소 생략: %s", k, oid, e)

    def _status(self, pos: Position, key: str) -> dict | None:
        oid = pos.order_ids.get(key)
        if not oid:
            return None
        try:
            return self.ex.fetch_order(oid, self.symbol, TRIGGER if key == "sl" else {})
        except Exception as e:
            log.info("주문 %s(%s) 조회 실패: %s", key, oid, e)
            return None

    # ── 실행 ──
    def open(self, sig: Signal, qty: float, price: float, t: pd.Timestamp) -> Position:
        amount = self._amount(qty)
        self._check_min(amount, price)
        frac = self.cfg.strategy.tp1_fraction
        if self.native_exits and 0 < frac < 1:  # 1차 익절 주문도 최소 기준을 넘어야 진입
            self._check_min(self._amount(qty * frac), sig.tp1)
        order = self._market("buy" if sig.side == "long" else "sell", amount, price, reduce_only=False)
        fill = float(order.get("average") or order.get("price") or price)
        qty_filled = float(order.get("filled") or amount) * self.contract_size
        pos = new_position(sig.side, qty_filled, fill, sig.stop, sig.tp1, sig.tp2,
                           self.cfg.strategy.tp1_fraction, t.isoformat(), f"{sig.setup}/{sig.trigger}",
                           fill * qty_filled * self.cfg.costs.fee_rate)
        pos.order_ids["entry"] = str(order.get("id"))
        if self.native_exits:
            try:
                pos.order_ids["sl"] = self._stop_order(pos, pos.stop)
                if pos.tp1_qty > 0 and self._amount(pos.tp1_qty) > 0:
                    pos.order_ids["tp1"] = self._limit_exit(pos, pos.tp1_qty, pos.tp1)
                if pos.tp2:
                    pos.order_ids["tp2"] = self._limit_exit(pos, pos.qty - pos.tp1_qty, pos.tp2)
            except Exception:
                log.exception("손절/익절 주문 실패 → 안전을 위해 즉시 시장가 청산")
                self._cancel(pos, "sl", "tp1", "tp2")
                self._market("sell" if pos.is_long else "buy", self._amount(pos.qty), price, reduce_only=True)
                raise
        return pos

    def execute(self, pos: Position, ex: Exit, t: pd.Timestamp) -> float:
        """시장가로 일부/전부 청산 (소프트웨어 청산, 수동 종료)."""
        closing_all = ex.qty >= pos.qty - 1e-12
        if closing_all:
            self._cancel(pos, "sl", "tp1", "tp2")
        amount = self._amount(min(ex.qty, pos.qty))
        if not self.contract:  # 현물 매수 수수료가 코인으로 빠졌을 수 있어 실제 보유량으로 자름
            free = float((self.ex.fetch_balance().get("free") or {}).get(self.base) or 0.0)
            amount = float(self.ex.amount_to_precision(self.symbol, min(amount, free)))
        order = self._market("sell" if pos.is_long else "buy", amount, ex.price, reduce_only=True)
        fill = float(order.get("average") or order.get("price") or ex.price)
        apply_exit(pos, Exit(ex.price, pos.qty if closing_all else ex.qty, ex.reason, False), fill,
                   self.cfg.costs.fee_rate)
        return fill

    def update_stop(self, pos: Position, new_stop: float) -> None:
        if self.native_exits and pos.qty > 0:
            old = pos.order_ids.get("sl")
            pos.order_ids["sl"] = self._stop_order(pos, new_stop)  # 새 손절 먼저 걸고
            if old:
                try:
                    self.ex.cancel_order(old, self.symbol, TRIGGER)  # 기존 손절 취소
                except Exception as e:
                    log.info("기존 손절 주문 취소 생략: %s", e)
        pos.stop = new_stop

    def sync(self, pos: Position, price: float, t: pd.Timestamp) -> list[tuple[Exit, float]]:
        """거래소에서 체결된 익절/손절을 포지션에 반영한다. 반영한 (청산, 체결가) 목록을 돌려준다."""
        if not self.native_exits:
            return []
        fills: list[tuple[Exit, float]] = []
        remaining = self._position_qty()
        fee_m, fee_t = self.cfg.costs.maker_fee_rate, self.cfg.costs.fee_rate

        if not pos.tp1_done and "tp1" in pos.order_ids:
            o = self._status(pos, "tp1")
            done = (o or {}).get("status") == "closed" or 1e-9 < remaining <= pos.qty - pos.tp1_qty + 1e-9
            if done:
                px = float((o or {}).get("average") or pos.tp1)
                ex = Exit(pos.tp1, min(pos.tp1_qty, pos.qty), "tp1", True)
                apply_exit(pos, ex, px, fee_m)
                pos.order_ids.pop("tp1", None)
                fills.append((ex, px))
                if remaining > 1e-9:
                    self.update_stop(pos, pos.stop)  # 남은 수량 기준 본절 손절로 다시 건다

        if remaining <= 1e-9 and pos.qty > 0:
            reason, px, maker = pos.stop_reason(), pos.stop, False
            o = self._status(pos, "sl")
            if (o or {}).get("status") == "closed":
                px = float(o.get("average") or pos.stop)
            else:
                o2 = self._status(pos, "tp2")
                if (o2 or {}).get("status") == "closed":
                    reason, px, maker = "tp2", float(o2.get("average") or pos.tp2), True
                elif not o:  # 조회가 안 되면 현재가에 더 가까운 쪽으로 추정
                    px = price
            ex = Exit(px, pos.qty, reason, maker)
            apply_exit(pos, ex, px, fee_m if maker else fee_t)
            self._cancel(pos, "sl", "tp1", "tp2")
            fills.append((ex, px))
        return fills

    def state(self) -> dict:
        return {}
