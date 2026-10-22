"""봉 단위 백테스트.

순서 (각 진입 봉 i):
  1) 대기 중인 신호가 있으면 진입
     - market: i 봉 시가에 시장가 (테이커 수수료 + 슬리피지)
     - limit : 신호 봉 종가에 지정가. 가격이 그 값을 '뚫고' 지나가야 체결로 본다(대기열 고려).
               체결된 봉에서는 익절은 보지 않고 손절만 본다 (체결 전후 순서를 모르므로 보수적으로)
  2) 보유 포지션의 손절/1차 익절/최종 목표를 i 봉 고가·저가로 판정 (보수적 순서, trade.plan_exits)
  3) 1차 익절 뒤 남은 물량은 확정된 유동성 봉 스윙을 따라 손절 이동 (runner: trail)
  4) i 봉 마감 후 신호 계산 → 다음 봉에 진입 예약
실시간 매매(live.py)와 같은 strategy / trade / risk 코드를 쓴다.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .config import Config
from .risk import RiskManager
from .strategy import Signal, generate_signal, prepare_features, trail_stop
from .trade import (Exit, Position, apply_exit, entry_valid, exit_fill, is_closed, new_position,
                    plan_exits, slipped, trade_record)


@dataclass
class BacktestResult:
    trades: pd.DataFrame
    equity: pd.Series
    stats: dict


def open_from_signal(sig: Signal, price: float, equity: float, risk: RiskManager, cfg: Config,
                     t: pd.Timestamp, fee_rate: float | None = None) -> Position | None:
    """신호를 실제 진입가로 다시 검증하고 수량을 정해 포지션을 만든다."""
    if not entry_valid(sig.side, price, sig.stop, sig.tp1):
        return None
    qty = risk.size(equity, price, sig.stop)
    if qty <= 0:
        return None
    return new_position(sig.side, qty, price, sig.stop, sig.tp1, sig.tp2, cfg.strategy.tp1_fraction,
                        t.isoformat(), f"{sig.setup}/{sig.trigger}",
                        price * qty * (cfg.costs.fee_rate if fee_rate is None else fee_rate))


def limit_fill(sig: Signal, o: float, h: float, l: float) -> float | None:
    """지정가(신호 봉 종가) 진입이 이 봉에서 체결되면 체결가, 아니면 None."""
    lim = sig.ref_price
    if sig.side == "long":
        return min(o, lim) if l < lim else None
    return max(o, lim) if h > lim else None


def limit_expired(sig: Signal, h: float, l: float) -> bool:
    """체결 전에 1차 목표나 손절에 먼저 닿았으면 기회가 지나간 것."""
    if sig.side == "long":
        return h >= sig.tp1 or l <= sig.stop
    return l <= sig.tp1 or h >= sig.stop


def run_backtest(df: pd.DataFrame, cfg: Config) -> BacktestResult:
    f = prepare_features(df, cfg)
    p, c = cfg.strategy, cfg.costs
    risk = RiskManager(cfg.risk, cfg.timezone, cfg.effective_max_leverage)
    equity = cfg.initial_equity
    pos: Position | None = None
    pending: Signal | None = None
    pending_until = -1
    trades: list[dict] = []
    curve = np.empty(len(df))
    limit = p.entry_mode == "limit"

    for i, t in enumerate(f.index):
        risk.roll_day(t, equity)
        o, h, l = f.open[i], f.high[i], f.low[i]
        bar = (o, h, l)

        if pending is not None:
            if not limit:
                pos = open_from_signal(pending, slipped(o, pending.side, True, c.slippage), equity, risk, cfg, t)
                pending = None
            elif (fill := limit_fill(pending, o, h, l)) is not None:
                pos = open_from_signal(pending, fill, equity, risk, cfg, t, c.maker_fee_rate)
                pending = None
                if pos:  # 체결 봉: 손절만 판정
                    bar = (fill, fill, l) if pos.is_long else (fill, h, fill)
            elif i >= pending_until or limit_expired(pending, h, l):
                pending = None
            if pos:
                equity += pos.realized  # 진입 수수료

        if pos is not None:
            last: Exit | None = None
            for ex in plan_exits(pos, *bar):
                price, fee = exit_fill(ex, pos.side, c)
                equity += apply_exit(pos, ex, price, fee)
                last = ex
            if is_closed(pos):
                trades.append(trade_record(pos, last, price, t.isoformat()))
                risk.on_trade_closed(pos.realized)
                pos = None
            elif pos.tp1_done:
                new = trail_stop(f, i, pos.side, pos.stop, p)
                if new is not None:
                    pos.stop = new

        if pos is None and pending is None and risk.can_trade():
            pending = generate_signal(f, i, p, cfg.allow_short)
            pending_until = i + p.limit_wait_bars

        curve[i] = equity + (pos.gross(f.close[i], pos.qty) if pos else 0.0)

    if pos is not None:
        ex = Exit(f.close[-1], pos.qty, "end", False)
        equity += apply_exit(pos, ex, ex.price, c.fee_rate)
        trades.append(trade_record(pos, ex, ex.price, f.index[-1].isoformat()))
        curve[-1] = equity

    trades_df = pd.DataFrame(trades)
    equity_s = pd.Series(curve, index=f.index, name="equity")
    return BacktestResult(trades_df, equity_s, compute_stats(trades_df, equity_s, df, cfg))


def compute_stats(trades: pd.DataFrame, equity: pd.Series, df: pd.DataFrame, cfg: Config) -> dict:
    start = cfg.initial_equity
    final = float(equity.iloc[-1]) if len(equity) else start
    peak = equity.cummax()
    mdd = float(((equity - peak) / peak).min()) if len(equity) else 0.0
    stats = {
        "기간": f"{df.index[0]:%Y-%m-%d} ~ {df.index[-1]:%Y-%m-%d}" if len(df) else "-",
        "봉 수": len(df),
        "시작 자산": start,
        "최종 자산": final,
        "총 수익률": final / start - 1,
        "보유(Buy&Hold) 수익률": float(df["close"].iloc[-1] / df["close"].iloc[0] - 1) if len(df) else 0.0,
        "최대 낙폭(MDD)": mdd,
        "거래 수": len(trades),
    }
    if len(trades):
        wins = trades[trades["pnl"] > 0]
        losses = trades[trades["pnl"] <= 0]
        gl = -losses["pnl"].sum()
        streak = best = 0
        for pnl in trades["pnl"]:
            streak = streak + 1 if pnl <= 0 else 0
            best = max(best, streak)
        stats.update({
            "승률": len(wins) / len(trades),
            "1차 익절 도달률": float(trades["tp1_done"].mean()),
            "손익비(Profit Factor)": float(wins["pnl"].sum() / gl) if gl > 0 else float("inf"),
            "평균 R": float(trades["r"].mean()),
            "롱/숏": f"{(trades['side'] == 'long').sum()} / {(trades['side'] == 'short').sum()}",
            "셋업별 거래": ", ".join(f"{k} {v}" for k, v in trades["setup"].value_counts().items()),
            "최대 연속 손실": best,
        })
    return stats


def format_stats(stats: dict) -> str:
    pct = {"총 수익률", "보유(Buy&Hold) 수익률", "최대 낙폭(MDD)"}
    rate = {"승률", "1차 익절 도달률"}
    money = {"시작 자산", "최종 자산"}
    lines = []
    for k, v in stats.items():
        if k in pct:
            v = f"{v * 100:+.2f}%"
        elif k in rate:
            v = f"{v * 100:.1f}%"
        elif k in money:
            v = f"{v:,.2f}"
        elif isinstance(v, float):
            v = f"{v:.2f}"
        lines.append(f"  {k:<20} {v}")
    return "\n".join(lines)
