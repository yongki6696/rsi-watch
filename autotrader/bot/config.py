"""설정 로드.

YAML 파일의 각 섹션을 dataclass 기본값 위에 덮어쓴다.
오타가 난 키는 조용히 무시하지 않고 바로 오류를 낸다 (매매 설정은 실수가 곧 손실).
"""
from __future__ import annotations

from dataclasses import dataclass, field, fields
from pathlib import Path
from typing import Any

import yaml


@dataclass
class ExchangeParams:
    id: str = "binance"            # ccxt 거래소 id: binance, bybit, okx, upbit ...
    market_type: str = "future"    # future(롱/숏) | spot(롱만)
    sandbox: bool = True           # 테스트넷 사용 여부 (실거래 전 반드시 true로 검증)
    leverage: int = 3              # 선물 레버리지 (거래소에 설정; 실제 노출은 risk.max_leverage로 제한)
    api_key_env: str = "EXCHANGE_API_KEY"
    secret_env: str = "EXCHANGE_API_SECRET"
    password_env: str = "EXCHANGE_API_PASSWORD"  # OKX 등 passphrase가 필요한 거래소


@dataclass
class StrategyParams:
    # 지표
    atr_period: int = 14
    ema_fast: int = 50             # 상위 타임프레임(중기 방향) 빠른 EMA
    ema_slow: int = 200            # 상위 타임프레임 느린 EMA
    bias_mode: str = "strict"      # strict: 추세 방향만 / loose: 역추세 금지(중립 허용) / off
    # 핵심 가격대(지지·저항) 탐지
    pivot_window: int = 5          # 스윙 고점/저점 판정 좌우 봉 수
    level_lookback: int = 300      # 가격대 탐색 구간(봉)
    vp_bins: int = 60              # 매물대(볼륨 프로파일) 구간 수
    hvn_quantile: float = 0.8      # 이 분위수 이상 거래량이 몰린 가격대를 매물대로 인정
    zone_width_atr: float = 0.6    # 같은 가격대로 묶는 폭(ATR 배수)
    min_touches: int = 2           # 스윙 기반 가격대가 되려면 최소 터치 수(쌍바닥/쌍봉)
    target_min_strength: float = 3.0  # 목표가로 삼을 '핵심' 가격대 최소 강도 (터치 수 + 3 x 매물대 강도)
    # 셋업 1: 유동성 스윕(함정) 후 되돌림
    enable_sweep: bool = True
    sweep_min_atr: float = 0.1     # 가격대를 최소 이만큼 찌르고
    sweep_max_atr: float = 1.5     # 이보다 깊으면 함정이 아니라 진짜 이탈로 봄
    sweep_clean_bars: int = 3      # 직전 N봉 종가가 가격대 위(아래)에 있었어야 함
    reclaim_close_pos: float = 0.5 # 봉 내 종가 위치(0=저가,1=고가). 롱은 이 값 이상이어야 함
    volume_mult: float = 1.2       # 스윕/돌파 봉 거래량 >= 평균 x 배수 (0이면 끔)
    volume_sma: int = 20
    # 셋업 2: 돌파 후 리테스트(저항→지지 전환)
    enable_retest: bool = True
    retest_window: int = 12        # 돌파 후 이 봉 수 안에 첫 리테스트가 와야 함
    retest_tolerance_atr: float = 0.2
    # 청산 / 손익비
    stop_buffer_atr: float = 0.2   # 손절은 꼬리/가격대 바깥 + 버퍼
    min_rr: float = 1.5            # 손익비 이 미만이면 진입 안 함
    fallback_rr: float = 2.0       # 반대편 가격대가 없을 때 목표 손익비
    breakeven_at_r: float = 1.0    # +1R 도달 시 손절을 본절로 (0이면 끔)


@dataclass
class RiskParams:
    risk_per_trade: float = 0.01   # 1회 손실 한도 = 자산의 1%
    max_leverage: float = 3.0      # 포지션 명목가치 상한 = 자산 x 배수
    daily_loss_limit: float = 0.03 # 하루 실현손실이 자산의 3%를 넘으면 그날 매매 중지
    max_consecutive_losses: int = 3  # 연속 손실 N회면 그날 매매 중지


@dataclass
class CostParams:
    fee_rate: float = 0.0005       # 편도 수수료
    slippage: float = 0.0002       # 시장가 체결 미끄러짐


@dataclass
class LiveParams:
    enabled: bool = False          # 실거래 이중 안전장치: 이 값과 --live 플래그가 모두 있어야 실주문
    poll_seconds: int = 30
    history_bars: int = 1500       # 매 판단마다 불러올 봉 수 (4h x 1500 = 250일: 일봉 EMA200 워밍업 포함)
    exits: str = "auto"            # auto | exchange(거래소 스탑/익절 주문) | software(봇이 직접 감시)
    state_file: str = "state.json"
    log_file: str = "trader.log"


@dataclass
class NotifyParams:
    telegram_token_env: str = "TELEGRAM_BOT_TOKEN"
    telegram_chat_env: str = "TELEGRAM_CHAT_ID"


@dataclass
class Config:
    symbol: str = "BTC/USDT:USDT"  # ccxt 심볼. 현물: BTC/USDT, 업비트: BTC/KRW
    timeframe: str = "4h"          # 진입 판단 타임프레임(단기). 1h 는 수수료 비중이 커서 백테스트 결과가 더 나빴음
    bias_timeframe: str = "1d"     # 방향 판단 타임프레임(중기)
    timezone: str = "Asia/Seoul"   # 일일 손실 한도 리셋 기준
    initial_equity: float = 10_000.0  # 백테스트/모의매매 시작 자산
    exchange: ExchangeParams = field(default_factory=ExchangeParams)
    strategy: StrategyParams = field(default_factory=StrategyParams)
    risk: RiskParams = field(default_factory=RiskParams)
    costs: CostParams = field(default_factory=CostParams)
    live: LiveParams = field(default_factory=LiveParams)
    notify: NotifyParams = field(default_factory=NotifyParams)

    @property
    def allow_short(self) -> bool:
        return self.exchange.market_type == "future"

    @property
    def effective_max_leverage(self) -> float:
        if self.exchange.market_type == "spot":
            return min(self.risk.max_leverage, 1.0)
        return self.risk.max_leverage


def _build(cls, data: dict[str, Any], where: str):
    known = {f.name for f in fields(cls)}
    unknown = set(data) - known
    if unknown:
        raise ValueError(f"[{where}] 알 수 없는 설정 키: {sorted(unknown)}")
    return cls(**data)


def config_from_dict(data: dict[str, Any]) -> Config:
    data = dict(data or {})
    sections = {
        "exchange": ExchangeParams,
        "strategy": StrategyParams,
        "risk": RiskParams,
        "costs": CostParams,
        "live": LiveParams,
        "notify": NotifyParams,
    }
    built = {name: _build(cls, data.pop(name, None) or {}, name) for name, cls in sections.items()}
    cfg = _build(Config, data, "root")
    for name, value in built.items():
        setattr(cfg, name, value)
    validate(cfg)
    return cfg


def load_config(path: str | Path | None) -> Config:
    if path is None:
        return config_from_dict({})
    with open(path, encoding="utf-8") as f:
        return config_from_dict(yaml.safe_load(f) or {})


def validate(cfg: Config) -> None:
    from .timeframes import timeframe_seconds

    if cfg.exchange.market_type not in ("spot", "future"):
        raise ValueError("exchange.market_type 은 spot 또는 future 여야 합니다")
    if cfg.strategy.bias_mode not in ("strict", "loose", "off"):
        raise ValueError("strategy.bias_mode 은 strict / loose / off 중 하나여야 합니다")
    if cfg.live.exits not in ("auto", "exchange", "software"):
        raise ValueError("live.exits 은 auto / exchange / software 중 하나여야 합니다")
    if timeframe_seconds(cfg.bias_timeframe) < timeframe_seconds(cfg.timeframe):
        raise ValueError("bias_timeframe 은 timeframe 보다 같거나 길어야 합니다")
    if not 0 < cfg.risk.risk_per_trade <= 0.05:
        raise ValueError("risk.risk_per_trade 는 0 초과 0.05(5%) 이하로 두세요")
    if cfg.strategy.min_rr <= 0 or cfg.strategy.fallback_rr <= 0:
        raise ValueError("min_rr / fallback_rr 은 양수여야 합니다")
