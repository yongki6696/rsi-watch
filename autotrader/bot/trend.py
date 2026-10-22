"""추세추종(돈치안 돌파) — 일봉 기준 자동매매 규칙과 백테스트.

  진입 : 일봉 종가가 직전 20일 최고가를 넘으면 롱 (allow_short 면 직전 20일 최저가 아래에서 숏)
  청산 : 롱은 종가가 직전 10일 최저가 아래로, 숏은 직전 10일 최고가 위로 마감하면 시장가 청산
  비상 손절: 거래소에 '10일 최저가 - ATR x disaster_stop_atr' 스탑 주문을 걸어 두고 매일 유리한 쪽으로만 옮김
            (봇이 꺼져도 폭락에 대비. 평소 청산은 위의 종가 규칙)
  크기 : 명목가치 = 자산 x exposure (기본 1배 = 현물로 BTC 를 산 것과 같은 노출)
  비용 : 진입·청산 시장가 수수료 + 슬리피지, 롱 보유 중 펀딩비(funding_apr, 연율)

판단은 일봉이 마감된 직후 그때까지의 데이터로만 하고, 체결은 다음 봉 시가(= 마감 직후 가격)로 본다.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from .config import Config, TrendParams
from .indicators import atr
from .trade import Exit, Position, apply_exit, new_position, plan_exits, slipped, trade_record


@dataclass
class TrendLevels:
    index: pd.DatetimeIndex
    open: np.ndarray
    high: np.ndarray
    low: np.ndarray
    close: np.ndarray
    entry_hi: np.ndarray   # 직전 N일 최고가 (오늘 제외)
    entry_lo: np.ndarray
    exit_hi: np.ndarray    # 직전 M일 최고가 (오늘 제외)
    exit_lo: np.ndarray
    stop_lo: np.ndarray    # 오늘 포함 M일 최저가 - ATR x k : 다음 날을 위한 비상 손절 (롱)
    stop_hi: np.ndarray    # 숏용


def trend_levels(df: pd.DataFrame, p: TrendParams) -> TrendLevels:
    h, l = df["high"], df["low"]
    a = atr(df, p.atr_period)
    k = p.disaster_stop_atr
    return TrendLevels(
        index=df.index,
        open=df["open"].to_numpy(float), high=h.to_numpy(float), low=l.to_numpy(float),
        close=df["close"].to_numpy(float),
        entry_hi=h.rolling(p.entry_days).max().shift(1).to_numpy(float),
        entry_lo=l.rolling(p.entry_days).min().shift(1).to_numpy(float),
        exit_hi=h.rolling(p.exit_days).max().shift(1).to_numpy(float),
        exit_lo=l.rolling(p.exit_days).min().shift(1).to_numpy(float),
        stop_lo=(l.rolling(p.exit_days).min() - k * a).to_numpy(float) if k > 0 else np.full(len(df), np.nan),
        stop_hi=(h.rolling(p.exit_days).max() + k * a).to_numpy(float) if k > 0 else np.full(len(df), np.nan),
    )


def decide(lv: TrendLevels, i: int, side: str | None, p: TrendParams) -> str | None:
    """i 번째 일봉 마감 기준 행동: 'long' / 'short' 진입, 'exit' 청산, 없으면 None."""
    c = lv.close[i]
    if side == "long":
        return "exit" if c < lv.exit_lo[i] else None
    if side == "short":
        return "exit" if c > lv.exit_hi[i] else None
    if c > lv.entry_hi[i]:
        return "long"
    if p.allow_short and c < lv.entry_lo[i]:
        return "short"
    return None


def next_stop(lv: TrendLevels, i: int, side: str, current: float | None) -> float | None:
    """i 봉 마감 뒤 비상 손절 가격. 유리한 쪽으로만 움직인다."""
    new = lv.stop_lo[i] if side == "long" else lv.stop_hi[i]
    if not np.isfinite(new):
        return current
    if current is None:
        return new
    return max(current, new) if side == "long" else min(current, new)


def reason_text(lv: TrendLevels, i: int, action: str, p: TrendParams) -> str:
    c = lv.close[i]
    if action == "long":
        return f"일봉 종가 {c:,.0f} > 직전 {p.entry_days}일 최고가 {lv.entry_hi[i]:,.0f} (상승 돌파)"
    if action == "short":
        return f"일봉 종가 {c:,.0f} < 직전 {p.entry_days}일 최저가 {lv.entry_lo[i]:,.0f} (하락 이탈)"
    return (f"일봉 종가 {c:,.0f} 가 직전 {p.exit_days}일 "
            f"{'최저가' if c < lv.exit_lo[i] else '최고가'} 를 반대로 깸 (추세 종료)")


EMERGENCY = "emergency_stop"  # 거래소 비상 손절 체결


def _position(side: str, qty: float, price: float, stop: float, t: pd.Timestamp, fee: float) -> Position:
    return new_position(side, qty, price, stop, 0.0, 0.0, 0.0, t.isoformat(), "trend", fee)


@dataclass
class TrendResult:
    trades: pd.DataFrame
    equity: pd.Series
    stats: dict


def run_trend_backtest(df: pd.DataFrame, cfg: Config) -> TrendResult:
    p, c = cfg.trend, cfg.costs
    lv = trend_levels(df, p)
    daily_funding = c.funding_apr / 365
    equity = cfg.initial_equity
    pos: Position | None = None
    pending: str | None = None
    trades: list[dict] = []
    curve = np.empty(len(df))
    funding_paid = 0.0

    def close_all(price: float, reason: str, t: pd.Timestamp):
        nonlocal equity, pos
        ex = Exit(price, pos.qty, reason, False)
        fill = slipped(price, pos.side, False, c.slippage)
        equity += apply_exit(pos, ex, fill, c.fee_rate)
        trades.append(trade_record(pos, ex, fill, t.isoformat()))
        pos = None

    for i, t in enumerate(lv.index):
        o, h, l = lv.open[i], lv.high[i], lv.low[i]
        if pending == "exit" and pos is not None:
            close_all(o, "signal", t)
        elif pending in ("long", "short") and pos is None:
            fill = slipped(o, pending, True, c.slippage)
            qty = equity * p.exposure / fill
            stop = next_stop(lv, i - 1, pending, None)
            pos = _position(pending, qty, fill, stop if stop is not None else 0.0, t, fill * qty * c.fee_rate)
            equity += pos.realized
        pending = None

        if pos is not None and pos.stop:  # 장중 비상 손절
            for ex in plan_exits(pos, o, h, l):
                fill = slipped(ex.price, pos.side, False, c.slippage)
                equity += apply_exit(pos, ex, fill, c.fee_rate)
                trades.append(trade_record(pos, Exit(fill, ex.qty, EMERGENCY, False), fill, t.isoformat()))
                pos = None
                break

        if pos is not None and pos.is_long and daily_funding:
            cost = pos.qty * lv.close[i] * daily_funding
            pos.realized -= cost
            equity -= cost
            funding_paid += cost

        pending = decide(lv, i, pos.side if pos else None, p)
        if pos is not None and pending is None:
            new = next_stop(lv, i, pos.side, pos.stop or None)
            if new is not None:
                pos.stop = new

        curve[i] = equity + (pos.gross(lv.close[i], pos.qty) if pos else 0.0)

    if pos is not None:
        close_all(lv.close[-1], "end", lv.index[-1])
        curve[-1] = equity

    tr = pd.DataFrame(trades)
    eq = pd.Series(curve, index=lv.index, name="equity")
    return TrendResult(tr, eq, trend_stats(tr, eq, df, cfg, funding_paid))


def trend_stats(trades: pd.DataFrame, equity: pd.Series, df: pd.DataFrame, cfg: Config, funding: float) -> dict:
    start = cfg.initial_equity
    final = float(equity.iloc[-1])
    years = max((df.index[-1] - df.index[0]).days / 365.25, 1e-9)
    bh = df["close"].iloc[-1] / df["close"].iloc[0]
    bh_curve = df["close"] / df["close"].cummax()
    in_market = 0.0
    if len(trades):
        held = (pd.to_datetime(trades["closed_at"]) - pd.to_datetime(trades["opened_at"])).dt.days.sum()
        in_market = held / max((df.index[-1] - df.index[0]).days, 1)
    stats = {
        "기간": f"{df.index[0]:%Y-%m-%d} ~ {df.index[-1]:%Y-%m-%d}",
        "시작 자산": start,
        "최종 자산": final,
        "총 수익률": final / start - 1,
        "연환산 수익률": (final / start) ** (1 / years) - 1,
        "최대 낙폭(MDD)": float((equity / equity.cummax() - 1).min()),
        "보유(Buy&Hold) 수익률": float(bh - 1),
        "보유 MDD": float((bh_curve - 1).min()),
        "거래 수": len(trades),
        "포지션 보유 비중": in_market,
        "낸 펀딩비": funding,
    }
    if len(trades):
        stats.update({
            "승률": float((trades["pnl"] > 0).mean()),
            "평균 이익 거래": float(trades.loc[trades["pnl"] > 0, "pnl"].mean() if (trades["pnl"] > 0).any() else 0),
            "평균 손실 거래": float(trades.loc[trades["pnl"] <= 0, "pnl"].mean() if (trades["pnl"] <= 0).any() else 0),
            "청산 이유": ", ".join(f"{k} {v}" for k, v in trades["reason"].value_counts().items()),
        })
    return stats
