"""명령줄 진입점.

  python -m bot demo                                   # 합성 데이터로 설치 확인
  python -m bot fetch    -c config.yaml --since 2023-01-01
  python -m bot backtest -c config.yaml --csv data/BTC_USDT_USDT_1h.csv
  python -m bot run      -c config.yaml                # 모의매매 (기본)
  python -m bot run      -c config.yaml --live         # 실거래 (config 의 live.enabled: true 도 필요)
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
from dataclasses import replace
from pathlib import Path

from .backtest import format_stats, run_backtest
from .config import load_config
from .data import fetch_ohlcv, load_csv, make_exchange, parse_date_ms, save_csv, synthetic_ohlcv


def _setup_logging(log_file: str | None) -> None:
    handlers: list[logging.Handler] = [logging.StreamHandler(sys.stdout)]
    if log_file:
        handlers.append(logging.FileHandler(log_file, encoding="utf-8"))
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", handlers=handlers)


def _default_csv(cfg) -> Path:
    name = cfg.symbol.replace("/", "_").replace(":", "_")
    return Path("data") / f"{cfg.exchange.id}_{name}_{cfg.timeframe}.csv"


def _save_results(result, out: str) -> None:
    d = Path(out)
    d.mkdir(parents=True, exist_ok=True)
    result.trades.to_csv(d / "trades.csv", index=False)
    result.equity.to_csv(d / "equity.csv")
    print(f"\n거래 내역: {d / 'trades.csv'}\n자산 곡선: {d / 'equity.csv'}")


def cmd_demo(args) -> None:
    cfg = load_config(args.config)
    df = synthetic_ohlcv(args.bars, seed=args.seed, timeframe=cfg.timeframe)
    result = run_backtest(df, cfg)
    print("※ 합성(가짜) 시세로 돌린 결과입니다. 프로그램 동작 확인용이며 전략 성능과 무관합니다.\n")
    print(format_stats(result.stats))
    if args.out:
        _save_results(result, args.out)


def cmd_fetch(args) -> None:
    cfg = load_config(args.config)
    ex = make_exchange(replace(cfg.exchange, sandbox=False, demo=False))
    until = parse_date_ms(args.until) if args.until else None
    df = fetch_ohlcv(ex, cfg.symbol, cfg.timeframe, parse_date_ms(args.since), until)
    out = Path(args.out) if args.out else _default_csv(cfg)
    save_csv(df, out)
    print(f"{len(df)}개 봉 저장: {out}")


def cmd_backtest(args) -> None:
    cfg = load_config(args.config)
    path = Path(args.csv) if args.csv else _default_csv(cfg)
    if not path.exists():
        sys.exit(f"{path} 가 없습니다. 먼저 `python -m bot fetch -c 설정파일 --since 2023-01-01` 로 받으세요.")
    df = load_csv(path)
    if args.start:
        df = df[df.index >= args.start]
    if args.end:
        df = df[df.index < args.end]
    result = run_backtest(df, cfg)
    print(format_stats(result.stats))
    _save_results(result, args.out)


def cmd_run(args) -> None:
    from .broker import CcxtBroker, PaperBroker
    from .live import CcxtFeed, LiveTrader, run_forever

    cfg = load_config(args.config)
    _setup_logging(cfg.live.log_file)
    if args.live:
        if not cfg.live.enabled:
            sys.exit("실거래하려면 설정 파일에 live.enabled: true 도 넣어야 합니다 (이중 안전장치).")
        ex = make_exchange(cfg.exchange, with_keys=True)
        broker = CcxtBroker(ex, cfg)
        state_file = cfg.live.state_file
        logging.warning("⚠️ 실거래 모드 (%s, sandbox=%s, demo=%s)", cfg.exchange.id, cfg.exchange.sandbox,
                        cfg.exchange.demo)
    else:
        # 모의매매는 실제(메인넷) 공개 시세를 쓰고 주문은 가상으로 체결
        ex = make_exchange(replace(cfg.exchange, sandbox=False, demo=False))
        state_path = Path(cfg.live.state_file)
        state_file = str(state_path.with_name("paper-" + state_path.name))
        saved = json.loads(Path(state_file).read_text(encoding="utf-8")) if Path(state_file).exists() else {}
        broker = PaperBroker(cfg, saved.get("broker"))
    trader = LiveTrader(cfg, CcxtFeed(ex, cfg.symbol, cfg.timeframe), broker, state_file)
    if args.once:
        trader.step()
        return
    run_forever(trader, cfg.live.poll_seconds)


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="python -m bot", description="차슐랭 방식(유동성 훼손·구조 전환) BTC 자동매매 봇")
    sub = ap.add_subparsers(dest="cmd", required=True)

    d = sub.add_parser("demo", help="합성 데이터로 백테스트 (설치 확인용)")
    d.add_argument("-c", "--config")
    d.add_argument("--bars", type=int, default=6000)
    d.add_argument("--seed", type=int, default=7)
    d.add_argument("--out")
    d.set_defaults(func=cmd_demo)

    f = sub.add_parser("fetch", help="거래소에서 과거 봉 데이터 받기")
    f.add_argument("-c", "--config")
    f.add_argument("--since", required=True, help="예: 2023-01-01")
    f.add_argument("--until")
    f.add_argument("--out")
    f.set_defaults(func=cmd_fetch)

    b = sub.add_parser("backtest", help="CSV 데이터로 백테스트")
    b.add_argument("-c", "--config")
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
    args.func(args)


if __name__ == "__main__":
    main()
