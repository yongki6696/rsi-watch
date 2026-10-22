import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from bot.config import config_from_dict  # noqa: E402


def make_df(rows, start="2024-01-01", freq="1h"):
    """rows: (open, high, low, close[, volume]) 목록 → OHLCV DataFrame."""
    rows = [r if len(r) == 5 else (*r, 100.0) for r in rows]
    idx = pd.date_range(start, periods=len(rows), freq=freq, tz="UTC", name="ts")
    return pd.DataFrame(rows, columns=["open", "high", "low", "close", "volume"], index=idx).astype(float)


def range_market(n=120, low=100.0, high=110.0, period=20, seed=0):
    """low~high 박스권을 오가는 시세 (지지 low, 저항 high 가 여러 번 확인됨)."""
    rng = np.random.default_rng(seed)
    mid, amp = (low + high) / 2, (high - low) / 2
    rows = []
    prev = mid
    for i in range(n):
        c = mid + amp * 0.92 * np.sin(2 * np.pi * i / period) + rng.normal(0, 0.05)
        o = prev
        rows.append((o, max(o, c) + 0.3, min(o, c) - 0.3, c, 100.0))
        prev = c
    return rows


@pytest.fixture
def cfg():
    return config_from_dict({
        "timeframe": "1h",
        "bias_timeframe": "4h",
        "strategy": {"bias_mode": "off", "volume_mult": 0.0, "level_lookback": 200},
        "risk": {"max_consecutive_losses": 0, "daily_loss_limit": 1.0},
        "costs": {"fee_rate": 0.0, "slippage": 0.0},
    })
