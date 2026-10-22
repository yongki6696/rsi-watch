"""봉 단위 백테스트.

순서 (각 봉 i):
  1) 직전 봉에서 나온 신호가 있으면 i 봉 시가에 진입
  2) 보유 포지션의 손절/익절을 i 봉 고가·저가로 판정 (둘 다 닿으면 손절 우선)
  3) i 봉 마감 후 신호 계산 → 다음 봉에 진입 예약
실시간 매매(live.py)와 같은 strategy / trade / risk 코드를 쓴다.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .config import Config
from .risk import RiskManager
from .strategy import Signal, generate_signal, prepare_features
from .trade import Position, breakeven_price, check_exit, close_trade, entry_valid, slipped


@dataclass
class BacktestResult:
    trades: pd.DataFrame
    equity: pd.Series
    stats: dict


def open_from_signal(sig: Signal, price: float, equity: float, risk: RiskManager, cfg: Config,
                     t: pd.Timestamp) -> Position | None:
    """신호를 실제 진입가로 다시 검증하고 수량을 정해 포지션을 만든다 (price 는 슬리피지 반영 체결가)."""
    if not entry_valid(sig.side, price, sig.stop, sig.target, cfg.strategy.min_rr):
        return None
    qty = risk.size(equity, price, sig.stop)
    if qty <= 0:
        return None
    return Position(sig.side, qty, price, sig.stop, sig.target, sig.stop, t.isoformat(), sig.setup,
                    entry_fee=price * qty * cfg.costs.fee_rate)


def run_backtest(df: pd.DataFrame, cfg: Config) -> BacktestResult:
    f = prepare_features(df, cfg)
    p, c = cfg.strategy, cfg.costs
    risk = RiskManager(cfg.risk, cfg.timezone, cfg.effective_max_leverage)
    equity = cfg.initial_equity
    pos: Position | None = None
    pending: Signal | None = None
    trades: list[dict] = []
    curve = np.empty(len(df))

    def settle(price: float, reason: str, t: pd.Timestamp):
        nonlocal equity, pos
        tr = close_trade(pos, price, reason, t.isoformat(), c.fee_rate)
        equity += pos.gross_pnl(price) - tr["exit_fee"]
        risk.on_trade_closed(tr["pnl"])
        trades.append(tr)
        pos = None

    for i, t in enumerate(f.index):
        risk.roll_day(t, equity)
        o, h, l = f.open[i], f.high[i], f.low[i]

        if pending is not None:
            fill = slipped(o, pending.side, True, c.slippage)
            pos = open_from_signal(pending, fill, equity, risk, cfg, t)
            if pos:
                equity -= pos.entry_fee
            pending = None

        if pos is not None:
            hit = check_exit(pos, o, h, l)
            if hit:
                price, reason = hit
                if reason == "stop":
                    price = slipped(price, pos.side, False, c.slippage)
                settle(price, reason, t)
            else:
                be = breakeven_price(pos, h, l, p.breakeven_at_r)
                if be is not None:
                    pos.stop = be

        if pos is None and risk.can_trade():
            pending = generate_signal(f, i, p, cfg.allow_short)

        curve[i] = equity + (pos.gross_pnl(f.close[i]) if pos else 0.0)

    if pos is not None:
        settle(f.close[-1], "end", f.index[-1])
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
            "손익비(Profit Factor)": float(wins["pnl"].sum() / gl) if gl > 0 else float("inf"),
            "평균 R": float(trades["r"].mean()),
            "롱/숏": f"{(trades['side'] == 'long').sum()} / {(trades['side'] == 'short').sum()}",
            "스윕/리테스트": f"{(trades['setup'] == 'sweep').sum()} / {(trades['setup'] == 'retest').sum()}",
            "최대 연속 손실": best,
        })
    return stats


def format_stats(stats: dict) -> str:
    pct = {"총 수익률", "보유(Buy&Hold) 수익률", "최대 낙폭(MDD)", "승률"}
    money = {"시작 자산", "최종 자산"}
    lines = []
    for k, v in stats.items():
        if k in pct:
            v = f"{v * 100:+.2f}%" if k != "승률" else f"{v * 100:.1f}%"
        elif k in money:
            v = f"{v:,.2f}"
        elif isinstance(v, float):
            v = f"{v:.2f}"
        lines.append(f"  {k:<20} {v}")
    return "\n".join(lines)
