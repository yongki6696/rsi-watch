import sys
from pathlib import Path

import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from bot.config import config_from_dict  # noqa: E402


def make_df(rows, start="2024-01-01", freq="1h"):
    """rows: (open, high, low, close[, volume]) 목록 → OHLCV DataFrame."""
    rows = [r if len(r) == 5 else (*r, 100.0) for r in rows]
    idx = pd.date_range(start, periods=len(rows), freq=freq, tz="UTC", name="ts")
    return pd.DataFrame(rows, columns=["open", "high", "low", "close", "volume"], index=idx).astype(float)


def mirror(rows, axis=300.0):
    """가격을 위아래로 뒤집는다 (숏 시나리오 → 롱 시나리오)."""
    return [(axis - o, axis - l, axis - h, axis - c) for o, h, l, c, *_ in rows]


def swing_high_prefix():
    """횡보 → 105.2 스윙 고점(1h 유동성) → 하락. 고점 뒤에 숏 손절 물량(바이사이드 유동성)."""
    rows = []
    c = 100.0
    for k in range(30):
        n = 100.5 if k % 2 == 0 else 100.0
        rows.append((c, max(c, n) + 0.2, min(c, n) - 0.2, n))
        c = n
    for n in (101, 102, 103, 104):
        rows.append((c, n + 0.1, c - 0.1, n))
        c = n
    rows.append((104.0, 105.2, 103.9, 105.0))  # 스윙 고점 105.2
    c = 105.0
    for n in (104.2, 103.4, 102.6, 101.8, 101.0):
        rows.append((c, c + 0.1, n - 0.1, n))
        c = n
    return rows


@pytest.fixture
def cfg():
    """1h 진입 = 1h 유동성, 4h 구조. 손절폭 제한은 넉넉히 (시나리오 검증용)."""
    return config_from_dict({
        "timeframe": "1h",
        "liquidity_timeframe": "1h",
        "structure_timeframe": "4h",
        "strategy": {"min_stop_atr": 0.1, "max_stop_atr": 50, "enable_ob": False},
        "risk": {"max_consecutive_losses": 0, "daily_loss_limit": 1.0},
        "costs": {"fee_rate": 0.0, "maker_fee_rate": 0.0, "slippage": 0.0},
    })
