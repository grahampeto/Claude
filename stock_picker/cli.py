"""Command line entry point: python -m stock_picker [--no-llm] [--tickers-file F]."""

from __future__ import annotations

import argparse
import sys

from .data import fetch_market_data
from .screen import ScreenCriteria, screen, template_thesis
from .universe import DEFAULT_UNIVERSE


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Mid-cap growth + momentum stock picker")
    p.add_argument("--tickers-file", help="newline-separated tickers (default: built-in list)")
    p.add_argument("--no-llm", action="store_true",
                   help="skip the Claude agent; print the rule-based top 3")
    p.add_argument("--no-web", action="store_true", help="disable the agent's web search")
    p.add_argument("--top", type=int, default=3)
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)

    tickers = DEFAULT_UNIVERSE
    if args.tickers_file:
        with open(args.tickers_file) as f:
            tickers = [line.strip().upper() for line in f if line.strip()]

    print(f"Fetching data for {len(set(tickers))} tickers...", file=sys.stderr)
    data = fetch_market_data(tickers)

    if args.no_llm:
        ranked = screen(data.closes, data.fundamentals, ScreenCriteria())
        if ranked.empty:
            print("No names passed the screen.")
            return 1
        print(ranked[["name", "market_cap", "revenue_growth", "ret_12_1", "ret_6m",
                      "off_high", "rsi14", "score"]].head(15).to_string())
        print(f"\nTOP {args.top}")
        for i, (_, row) in enumerate(ranked.head(args.top).iterrows(), 1):
            print(f"{i}. {row.name} - {template_thesis(row)}")
        return 0

    from .agent import run_agent
    print(run_agent(data, web_search=not args.no_web, verbose=args.verbose))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
