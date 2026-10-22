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
    sandbox: bool = True           # 테스트넷 사용 (실거래 전 반드시 true로 검증)
    demo: bool = False             # 바이낸스 '데모 트레이딩' 계정 사용 (sandbox 대신)
    leverage: int = 3              # 선물 레버리지 (거래소에 설정; 실제 노출은 risk.max_leverage로 제한)
    api_key_env: str = "EXCHANGE_API_KEY"
    secret_env: str = "EXCHANGE_API_SECRET"
    password_env: str = "EXCHANGE_API_PASSWORD"  # OKX 등 passphrase가 필요한 거래소


@dataclass
class StrategyParams:
    atr_period: int = 14
    # 유동성: 스윙 고점 뒤 = 바이사이드(숏 손절 물량), 스윙 저점 뒤 = 셀사이드(롱 손절 물량)
    liq_pivot_window: int = 5      # 유동성 봉(1h) 단기 고점/저점 = 내부 유동성. 좌우 N봉
    ext_pivot_window: int = 3      # 구조 봉(4h) 고점/저점 = 외부 유동성 + 가격 구조. 좌우 N봉
    entry_pivot_window: int = 2    # 진입 봉 내부 구조(스윙) 판정. 좌우 N봉
    # 셋업
    enable_sweep: bool = True      # 유동성 훼손(스윕) 후 진입
    sweep_levels: str = "all"      # all: 내부+외부 유동성 / external: 4h 외부 유동성만
    enable_ob: bool = True         # 오더블록(서플라이/디맨드 존) 터치 후 진입
    enable_pinbar: bool = True     # 트리거 ①: 훼손한 봉이 핀바로 안쪽 마감
    enable_choch: bool = True      # 트리거 ②: 훼손 후 내부 구조 전환(직전 스윙 이탈 마감)
    arm_bars: int = 12             # 훼손/터치 후 이 봉 수 안에 전환이 나와야 함
    sweep_max_atr: float = 1.5     # 레벨을 이보다 더 뚫으면(유동성 봉 ATR 기준) 함정이 아니라 돌파로 봄
    pinbar_wick: float = 0.5       # 핀바: 반대쪽 꼬리가 봉 길이의 50% 이상
    ob_impulse_atr: float = 1.5    # 구조 봉 몸통이 ATR x 배수 이상 + 직전 스윙 돌파 = 임펄스
    ob_max_age: int = 180          # 오더블록 유효 기간(구조 봉 수, 4h x 180 = 30일)
    bias_mode: str = "off"         # off: 양방향(채널 방식) / structure: 4h 구조 방향으로만
    # 손절 / 익절
    stop_buffer_atr: float = 0.1   # 손절 = 훼손 꼬리 끝 + 버퍼
    min_stop_atr: float = 0.8      # 손절폭이 이보다 좁으면 수수료 비중이 커서 패스 (실데이터 검증으로 정함)
    max_stop_atr: float = 3.0      # 손절폭이 이보다 넓으면 패스
    tp1_r: float = 1.5             # 1차 부분 익절 위치 (R 배수)
    tp1_fraction: float = 0.5      # 1차 익절 비중. 이후 손절을 본절로
    runner: str = "trail"          # 남은 물량: trail(유동성 봉 스윙 따라 손절 이동) / hold(본절 유지)
    tp2_r: float = 0.0             # 남은 물량 최종 목표 (R 배수, 0 이면 없음)


@dataclass
class RiskParams:
    risk_per_trade: float = 0.01   # 1회 손실 한도 = 자산의 1%
    max_leverage: float = 3.0      # 포지션 명목가치 상한 = 자산 x 배수
    daily_loss_limit: float = 0.03 # 하루 실현손실이 자산의 3%를 넘으면 그날 매매 중지
    max_consecutive_losses: int = 3  # 연속 손실 N회면 그날 매매 중지


@dataclass
class CostParams:
    fee_rate: float = 0.0005       # 시장가(테이커) 수수료: 진입, 손절
    maker_fee_rate: float = 0.0002 # 지정가(메이커) 수수료: 익절 주문
    slippage: float = 0.0002       # 시장가 체결 미끄러짐


@dataclass
class LiveParams:
    enabled: bool = False          # 실거래 이중 안전장치: 이 값과 --live 플래그가 모두 있어야 실주문
    poll_seconds: int = 30
    history_bars: int = 6000       # 매 판단마다 쓰는 봉 수 (15m x 6000 = 약 62일치 유동성/구조)
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
    timeframe: str = "15m"         # 진입(트리거) 봉: 내부 구조 전환·핀바 확인
    liquidity_timeframe: str = "1h"  # 내부 유동성(단기 고점/저점) 봉
    structure_timeframe: str = "4h"  # 가격 구조·외부 유동성·오더블록 봉
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
    strat = dict(data.get("strategy") or {})
    if strat.get("bias_mode") is False:  # YAML 에서 따옴표 없는 off 는 False 로 읽힌다
        strat["bias_mode"] = "off"
        data["strategy"] = strat
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
    p = cfg.strategy
    if p.bias_mode not in ("off", "structure"):
        raise ValueError("strategy.bias_mode 은 off / structure 중 하나여야 합니다")
    if p.sweep_levels not in ("all", "external"):
        raise ValueError("strategy.sweep_levels 는 all / external 중 하나여야 합니다")
    if p.runner not in ("trail", "hold"):
        raise ValueError("strategy.runner 는 trail / hold 중 하나여야 합니다")
    if not 0 <= p.tp1_fraction <= 1 or p.tp1_r <= 0:
        raise ValueError("tp1_fraction 은 0~1, tp1_r 은 양수여야 합니다")
    if cfg.live.exits not in ("auto", "exchange", "software"):
        raise ValueError("live.exits 은 auto / exchange / software 중 하나여야 합니다")
    tf, lq, st = (timeframe_seconds(x) for x in (cfg.timeframe, cfg.liquidity_timeframe, cfg.structure_timeframe))
    if not tf <= lq <= st:
        raise ValueError("timeframe <= liquidity_timeframe <= structure_timeframe 순서여야 합니다")
    if not 0 < cfg.risk.risk_per_trade <= 0.05:
        raise ValueError("risk.risk_per_trade 는 0 초과 0.05(5%) 이하로 두세요")
    if cfg.exchange.sandbox and cfg.exchange.demo:
        raise ValueError("exchange.sandbox 와 exchange.demo 는 동시에 켤 수 없습니다")
