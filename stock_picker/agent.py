"""Claude agent that runs the screen, digs into the finalists, and picks a top 3."""

from __future__ import annotations

import json
import math

import anthropic
from anthropic import beta_tool

from .data import MarketData
from .screen import ScreenCriteria, screen

MODEL = "claude-opus-5-5"

SYSTEM = """You are an equity research analyst focused on US mid-cap growth stocks.

Workflow:
1. Call screen_stocks to get mid-cap names with strong revenue growth and price momentum.
   If fewer than 5 names pass, loosen the criteria once and re-screen.
2. Call stock_detail on the strongest 5-8 candidates to understand the business.
3. If web search is available, check each finalist for recent news (earnings, guidance,
   deals) that confirms or undermines the momentum.
4. Pick your top 3. Favor durable growth drivers and clean trends over the single highest
   score; skip names where momentum looks event-driven or already reversing (RSI > 80,
   sharp 1-month drop).

Final answer format, and nothing else after it:
TOP 3
1. TICKER (Company) - <one-line thesis, max ~30 words, naming the growth driver and the momentum evidence>
2. ...
3. ...
Key risk across the picks: <one line>

Use only numbers that came from the tools or search results. This is research, not
personalized investment advice."""


def _clean(value):
    if isinstance(value, float):
        return None if math.isnan(value) else round(value, 4)
    return value


def build_tools(data: MarketData):
    @beta_tool
    def screen_stocks(min_market_cap_billions: float = 2.0,
                      max_market_cap_billions: float = 20.0,
                      min_revenue_growth_pct: float = 15.0,
                      min_return_6m_pct: float = 10.0,
                      max_pct_off_52w_high: float = 20.0,
                      limit: int = 15) -> str:
        """Screen the universe for mid-cap growth stocks with strong momentum.

        Filters on market cap, YoY revenue growth, 6-month return, distance from the
        52-week high and an uptrend (price > 50DMA > 200DMA), then ranks by a composite
        of 12-1M, 6M and 3M momentum, revenue growth and proximity to the high.

        Args:
            min_market_cap_billions: Lower market-cap bound in USD billions.
            max_market_cap_billions: Upper market-cap bound in USD billions.
            min_revenue_growth_pct: Minimum YoY revenue growth, in percent.
            min_return_6m_pct: Minimum 6-month price return, in percent.
            max_pct_off_52w_high: Maximum drawdown from the 52-week high, in percent.
            limit: Maximum number of names to return.
        """
        criteria = ScreenCriteria(
            min_market_cap=min_market_cap_billions * 1e9,
            max_market_cap=max_market_cap_billions * 1e9,
            min_revenue_growth=min_revenue_growth_pct / 100,
            min_return_6m=min_return_6m_pct / 100,
            max_off_high=max_pct_off_52w_high / 100,
        )
        result = screen(data.closes, data.fundamentals, criteria).head(limit)
        cols = ["name", "sector", "market_cap", "revenue_growth", "earnings_growth",
                "ret_1m", "ret_3m", "ret_6m", "ret_12_1", "off_high", "rsi14", "score"]
        rows = [{"ticker": t, **{c: _clean(r.get(c)) for c in cols}}
                for t, r in result.iterrows()]
        return json.dumps({"universe_size": len(data.fundamentals), "passed": len(rows),
                           "results": rows})

    @beta_tool
    def stock_detail(ticker: str) -> str:
        """Business description and valuation/quality fields for one ticker.

        Args:
            ticker: Ticker symbol, e.g. "FIX".
        """
        info = data.details.get(ticker.upper())
        if not info:
            return json.dumps({"error": f"no data for {ticker}"})
        keys = ["longName", "sector", "industry", "longBusinessSummary", "marketCap",
                "revenueGrowth", "earningsGrowth", "grossMargins", "operatingMargins",
                "forwardPE", "pegRatio", "targetMeanPrice", "currentPrice",
                "recommendationKey", "numberOfAnalystOpinions"]
        out = {k: info.get(k) for k in keys}
        if out["longBusinessSummary"]:
            out["longBusinessSummary"] = out["longBusinessSummary"][:800]
        return json.dumps(out)

    return [screen_stocks, stock_detail]


def run_agent(data: MarketData, web_search: bool = True, verbose: bool = False) -> str:
    client = anthropic.Anthropic()
    tools: list = build_tools(data)
    if web_search:
        tools.append({"type": "web_search_20260209", "name": "web_search", "max_uses": 10})

    messages = [{"role": "user", "content":
                 "Screen mid-cap growth names with strong momentum and give me your top 3 "
                 "with a one-line thesis for each."}]
    # The Python tool runner ends on pause_turn (long server-side web search turns),
    # so mirror the history and restart it from the paused turn when that happens.
    for _ in range(5):
        runner = client.beta.messages.tool_runner(
            model=MODEL,
            max_tokens=16000,
            system=SYSTEM,
            thinking={"type": "adaptive"},
            output_config={"effort": "high"},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            tools=tools,
            messages=messages,
        )
        last = None
        for message in runner:
            last = message
            messages.append({"role": "assistant", "content": message.content})
            tool_response = runner.generate_tool_call_response()
            if tool_response is not None:
                messages.append(tool_response)
                if verbose:
                    for block in message.content:
                        if block.type == "tool_use":
                            print(f"  -> {block.name}({json.dumps(block.input)})")
        if last is None or last.stop_reason != "pause_turn":
            break

    if last is None:
        raise RuntimeError("agent returned no response")
    if last.stop_reason == "refusal":
        raise RuntimeError(f"model declined the request: {last.stop_details}")
    return "".join(b.text for b in last.content if b.type == "text").strip()
