"""명령줄 진입점.

  python -m bot demo                                   # 합성 데이터로 설치 확인
  python -m bot fetch    -c config.yaml --since 2019-01-01 --exchange binance --symbol BTC/USDT --timeframe 1d
  python -m bot backtest -c config.yaml --csv data/binance_BTC_USDT_1d.csv   # mode hybrid → 추세추종 백테스트
  python -m bot run      -c config.yaml                # 모의매매 (기본)
  python -m bot run      -c config.yaml --live         # 실거래 (config 의 live.enabled: true 도 필요)
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from dataclasses import replace
from pathlib import Path

from .backtest import format_stats, run_backtest
from .config import load_config
from .data import fetch_ohlcv, load_csv, make_exchange, parse_date_ms, save_csv, synthetic_ohlcv


def load_env_file(path: str | Path = ".env") -> list[str]:
    """KEY=VALUE 형식의 .env 파일을 환경변수로 읽는다 (이미 설정된 값은 덮지 않음). 읽은 키 이름 목록을 돌려준다."""
    p = Path(path)
    if not p.exists():
        return []
    loaded = []
    for line in p.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value
            loaded.append(key)
    return loaded


def _setup_logging(log_file: str | None) -> None:
    try:  # 윈도우 콘솔(cp949)은 이모지를 못 써서 로그가 깨지므로 그런 글자는 ? 로 바꿔 출력
        sys.stdout.reconfigure(errors="replace")
    except (AttributeError, ValueError):
        pass
    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stdout)]
    if log_file:
        handlers.append(logging.FileHandler(log_file, encoding="utf-8"))
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", handlers=handlers)


def _csv_name(exchange: str, symbol: str, timeframe: str) -> Path:
    name = symbol.replace("/", "_").replace(":", "_")
    return Path("data") / f"{exchange}_{name}_{timeframe}.csv"


def _save_results(result, out: str) -> None:
    d = Path(out)
    d.mkdir(parents=True, exist_ok=True)
    result.trades.to_csv(d / "trades.csv", index=False)
    result.equity.to_csv(d / "equity.csv")
    print(f"\n거래 내역: {d / 'trades.csv'}\n자산 곡선: {d / 'equity.csv'}")


def _strategy(cfg, override: str | None) -> str:
    return override or ("trend" if cfg.mode == "hybrid" else "smc")


def cmd_demo(args) -> None:
    from .trend import run_trend_backtest

    cfg = load_config(args.config)
    print("※ 합성(가짜) 시세로 돌린 결과입니다. 프로그램 동작 확인용이며 전략 성능과 무관합니다.\n")
    if _strategy(cfg, args.strategy) == "trend":
        result = run_trend_backtest(synthetic_ohlcv(args.bars, seed=args.seed, timeframe=cfg.trend.timeframe), cfg)
    else:
        result = run_backtest(synthetic_ohlcv(args.bars, seed=args.seed, timeframe=cfg.timeframe), cfg)
    print(format_stats(result.stats))
    if args.out:
        _save_results(result, args.out)


def cmd_fetch(args) -> None:
    cfg = load_config(args.config)
    ex_params = replace(cfg.exchange, sandbox=False, demo=False)
    if args.exchange:
        ex_params = replace(ex_params, id=args.exchange)
    symbol = args.symbol or cfg.symbol
    timeframe = args.timeframe or (cfg.trend.timeframe if cfg.mode == "hybrid" else cfg.timeframe)
    ex = make_exchange(ex_params)
    until = parse_date_ms(args.until) if args.until else None
    df = fetch_ohlcv(ex, symbol, timeframe, parse_date_ms(args.since), until)
    out = Path(args.out) if args.out else _csv_name(ex_params.id, symbol, timeframe)
    save_csv(df, out)
    print(f"{len(df)}개 봉 저장: {out}")


def cmd_backtest(args) -> None:
    from .trend import run_trend_backtest

    cfg = load_config(args.config)
    strategy = _strategy(cfg, args.strategy)
    timeframe = cfg.trend.timeframe if strategy == "trend" else cfg.timeframe
    path = Path(args.csv) if args.csv else _csv_name(cfg.exchange.id, cfg.symbol, timeframe)
    if not path.exists():
        sys.exit(f"{path} 가 없습니다. 먼저 `python -m bot fetch -c 설정파일 --since 2019-01-01 "
                 f"--timeframe {timeframe}` 로 받으세요.")
    df = load_csv(path)
    if args.start:
        df = df[df.index >= args.start]
    if args.end:
        df = df[df.index < args.end]
    result = run_trend_backtest(df, cfg) if strategy == "trend" else run_backtest(df, cfg)
    print(format_stats(result.stats))
    _save_results(result, args.out)


def cmd_run(args) -> None:
    import time

    import pandas as pd

    from .broker import CcxtBroker, PaperBroker
    from .live import (CcxtFeed, LiveTrader, Notifier, SignalAlerter, TelegramCommands, TrendTrader,
                       run_forever)

    cfg = load_config(args.config)
    _setup_logging(cfg.live.log_file)
    base = Path(cfg.live.state_file)
    if args.live:
        if not cfg.live.enabled:
            sys.exit("실거래하려면 설정 파일에 live.enabled: true 도 넣어야 합니다 (이중 안전장치).")
        ex = make_exchange(cfg.exchange, with_keys=True)
        logging.warning("⚠️ 실거래 모드 (%s, sandbox=%s, demo=%s)", cfg.exchange.id, cfg.exchange.sandbox,
                        cfg.exchange.demo)
    else:
        # 모의매매는 실제(메인넷) 공개 시세를 쓰고 주문은 가상으로 체결
        ex = make_exchange(replace(cfg.exchange, sandbox=False, demo=False))
        base = base.with_name("paper-" + base.name)

    def state(suffix: str) -> Path:
        return base.with_name(f"{base.stem}{suffix}{base.suffix}")

    def broker_for(path: Path):
        if args.live:
            return CcxtBroker(ex, cfg)
        saved = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        return PaperBroker(cfg, saved.get("broker"))

    notifier = Notifier(cfg.notify)
    started = time.time()
    alerter = None
    if cfg.mode == "hybrid":
        trend_state = state("-trend")
        trend = TrendTrader(cfg, CcxtFeed(ex, cfg.symbol, cfg.trend.timeframe), broker_for(trend_state),
                            trend_state, notifier)
        components = [trend]
        if cfg.alerts:
            alerter = SignalAlerter(cfg, CcxtFeed(ex, cfg.symbol, cfg.timeframe), state("-alerts"),
                                    notifier, trend.status_text)
            components.append(alerter)
        start = (f"▶️ 봇 시작 [{trend.broker.label}] {cfg.exchange.id} {cfg.symbol}\n"
                 f"- 추세추종 자동매매 ({cfg.trend.timeframe}, {cfg.trend.entry_days}일 돌파/{cfg.trend.exit_days}일 이탈)\n"
                 f"- 채널 방식 신호 알림 {'켜짐' if cfg.alerts else '꺼짐'} ({cfg.timeframe}, 주문 없음)\n"
                 f"{trend.status_text()}")
    else:
        trader = LiveTrader(cfg, CcxtFeed(ex, cfg.symbol, cfg.timeframe), broker_for(base), base, notifier)
        components = [trader]
        start = f"▶️ 봇 시작 [{trader.broker.label}] 채널 방식 자동매매 {cfg.symbol} {cfg.timeframe}"

    def report() -> str:
        """텔레그램 /status 답장."""
        main = components[0]
        price = main.feed.last_price()
        hours = int((time.time() - started) // 3600)
        lines = [f"📊 현재 상태 [{main.broker.label}] {cfg.exchange.id} {cfg.symbol} "
                 f"({pd.Timestamp.now(tz='Asia/Seoul'):%m/%d %H:%M})", f"현재가 {price:,.0f}"]
        if isinstance(main, TrendTrader):
            lines += main.report(price)
        else:
            lines.append(f"자산 {main.broker.equity():,.0f}")
            lines.append("포지션 없음" if main.pos is None else
                         f"{main.pos.side} 보유 (진입 {main.pos.entry:,.0f}, 손절 {main.pos.stop:,.0f})")
        if alerter is not None:
            lines.append(f"채널 신호 마지막 알림: {alerter.last_alert or '아직 없음'}")
        lines.append(f"가동 시간 {hours // 24}일 {hours % 24}시간")
        return "\n".join(lines)

    if cfg.notify.commands:
        components.append(TelegramCommands(notifier, report, state("-telegram")))
        if notifier.enabled:
            start += "\n(텔레그램에서 /status 를 보내면 현재 상태를 알려 드립니다)"
    if args.once:
        for c in components:
            c.step()
        return
    run_forever(components, cfg.live.poll_seconds, notifier, start)


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="python -m bot",
                                 description="BTC 자동매매 봇: 추세추종 자동매매 + 차슐랭 방식 신호 알림")
    sub = ap.add_subparsers(dest="cmd", required=True)

    d = sub.add_parser("demo", help="합성 데이터로 백테스트 (설치 확인용)")
    d.add_argument("-c", "--config")
    d.add_argument("--strategy", choices=["trend", "smc"])
    d.add_argument("--bars", type=int, default=3000)
    d.add_argument("--seed", type=int, default=7)
    d.add_argument("--out")
    d.set_defaults(func=cmd_demo)

    f = sub.add_parser("fetch", help="거래소에서 과거 봉 데이터 받기 (키 불필요)")
    f.add_argument("-c", "--config")
    f.add_argument("--since", required=True, help="예: 2019-01-01")
    f.add_argument("--until")
    f.add_argument("--exchange", help="설정과 다른 거래소에서 받기 (예: binance — 하이퍼리퀴드는 과거 데이터가 짧음)")
    f.add_argument("--symbol", help="예: BTC/USDT")
    f.add_argument("--timeframe", help="예: 1d, 15m (기본: mode hybrid 면 추세추종 봉)")
    f.add_argument("--out")
    f.set_defaults(func=cmd_fetch)

    b = sub.add_parser("backtest", help="CSV 데이터로 백테스트")
    b.add_argument("-c", "--config")
    b.add_argument("--strategy", choices=["trend", "smc"], help="기본: mode hybrid 면 trend, smc 면 smc")
    b.add_argument("--csv")
    b.add_argument("--start")
    b.add_argument("--end")
    b.add_argument("--out", default="results")
    b.set_defaults(func=cmd_backtest)

    r = sub.add_parser("run", help="실시간 실행 (기본: 모의매매)")
    r.add_argument("-c", "--config")
    r.add_argument("--live", action="store_true", help="실제 주문 (config live.enabled: true 필요)")
    r.add_argument("--once", action="store_true", help="한 번만 판단하고 종료 (cron 용)")
    r.set_defaults(func=cmd_run)

    args = ap.parse_args(argv)
    load_env_file()  # 현재 폴더의 .env (API 키, 텔레그램 토큰)
    args.func(args)


if __name__ == "__main__":
    main()
