"""ccxt 타임프레임 문자열('15m', '1h', '4h', '1d', '1w') 변환."""
from __future__ import annotations

import re

_UNITS = {"m": 60, "h": 3600, "d": 86400, "w": 604800}


def timeframe_seconds(tf: str) -> int:
    m = re.fullmatch(r"(\d+)([mhdw])", tf.strip())
    if not m:
        raise ValueError(f"지원하지 않는 타임프레임: {tf!r} (예: 15m, 1h, 4h, 1d)")
    return int(m.group(1)) * _UNITS[m.group(2)]
