"""Market data access. Yahoo Finance via yfinance is the default provider."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field

import pandas as pd

INFO_FIELDS = {
    "longName": "name",
    "sector": "sector",
    "industry": "industry",
    "marketCap": "market_cap",
    "revenueGrowth": "revenue_growth",
    "earningsGrowth": "earnings_growth",
    "grossMargins": "gross_margin",
    "forwardPE": "forward_pe",
    "averageDailyVolume3Month": "avg_volume",
}


@dataclass
class MarketData:
    """Daily closes (one column per ticker) plus per-ticker fundamentals."""

    closes: pd.DataFrame
    fundamentals: pd.DataFrame  # indexed by ticker, columns from INFO_FIELDS values
    details: dict[str, dict] = field(default_factory=dict)  # raw info for drill-down


def fetch_market_data(tickers: list[str], period: str = "14mo") -> MarketData:
    import yfinance as yf

    tickers = sorted(set(tickers))
    prices = yf.download(tickers, period=period, interval="1d", auto_adjust=True,
                         progress=False, group_by="column", threads=True)
    if isinstance(prices.columns, pd.MultiIndex):
        closes = prices["Close"]
    else:  # single ticker comes back flat
        closes = prices[["Close"]].rename(columns={"Close": tickers[0]})

    def info(t: str) -> tuple[str, dict]:
        try:
            return t, yf.Ticker(t).info or {}
        except Exception:  # one bad ticker shouldn't sink the screen
            return t, {}

    with ThreadPoolExecutor(max_workers=8) as pool:
        details = dict(pool.map(info, tickers))

    fundamentals = pd.DataFrame(
        {t: {dst: d.get(src) for src, dst in INFO_FIELDS.items()} for t, d in details.items()}
    ).T
    return MarketData(closes=closes.dropna(axis=1, how="all"), fundamentals=fundamentals,
                      details=details)
