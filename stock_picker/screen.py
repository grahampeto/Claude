"""Momentum + growth screen. Pure pandas, no network, so it is unit-testable."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

# Approximate trading-day lookbacks
D1M, D3M, D6M, D12M = 21, 63, 126, 252


@dataclass(frozen=True)
class ScreenCriteria:
    min_market_cap: float = 2e9
    max_market_cap: float = 20e9
    min_revenue_growth: float = 0.15   # YoY, as a fraction
    min_return_6m: float = 0.10
    max_off_high: float = 0.20         # within 20% of the 52-week high
    require_uptrend: bool = True       # price > 50DMA > 200DMA
    min_avg_volume: float = 300_000


# Composite score weights (applied to cross-sectional percentile ranks)
WEIGHTS = {
    "ret_12_1": 0.30,       # classic 12-month-minus-1-month momentum
    "ret_6m": 0.20,
    "ret_3m": 0.15,
    "revenue_growth": 0.25,
    "off_high": 0.10,       # closer to the high ranks better
}


def rsi(series: pd.Series, window: int = 14) -> float:
    delta = series.diff().dropna()
    gain = delta.clip(lower=0).ewm(alpha=1 / window, adjust=False).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1 / window, adjust=False).mean()
    rs = gain.iloc[-1] / loss.iloc[-1] if loss.iloc[-1] else np.inf
    return float(100 - 100 / (1 + rs))


def momentum_metrics(closes: pd.DataFrame) -> pd.DataFrame:
    """Per-ticker momentum stats from a (dates x tickers) close-price frame."""
    rows = {}
    for ticker in closes.columns:
        s = closes[ticker].dropna()
        if len(s) < D12M + 1:
            continue  # need a full year of history for 12-1 momentum
        last = s.iloc[-1]
        rows[ticker] = {
            "price": last,
            "ret_1m": last / s.iloc[-1 - D1M] - 1,
            "ret_3m": last / s.iloc[-1 - D3M] - 1,
            "ret_6m": last / s.iloc[-1 - D6M] - 1,
            "ret_12m": last / s.iloc[-1 - D12M] - 1,
            "ret_12_1": s.iloc[-1 - D1M] / s.iloc[-1 - D12M] - 1,
            "off_high": 1 - last / s.iloc[-D12M:].max(),
            "dma50": s.iloc[-50:].mean(),
            "dma200": s.iloc[-200:].mean(),
            "rsi14": rsi(s),
        }
    df = pd.DataFrame.from_dict(rows, orient="index")
    if not df.empty:
        df["uptrend"] = (df["price"] > df["dma50"]) & (df["dma50"] > df["dma200"])
    return df


def screen(closes: pd.DataFrame, fundamentals: pd.DataFrame,
           criteria: ScreenCriteria = ScreenCriteria()) -> pd.DataFrame:
    """Return names passing every filter, best composite score first."""
    df = momentum_metrics(closes).join(fundamentals, how="inner")
    if df.empty:
        return df
    for col in ("market_cap", "revenue_growth", "avg_volume"):
        df[col] = pd.to_numeric(df[col], errors="coerce")

    c = criteria
    mask = (
        df["market_cap"].between(c.min_market_cap, c.max_market_cap)
        & (df["revenue_growth"] >= c.min_revenue_growth)
        & (df["ret_6m"] >= c.min_return_6m)
        & (df["off_high"] <= c.max_off_high)
        & (df["avg_volume"].fillna(np.inf) >= c.min_avg_volume)
    )
    if c.require_uptrend:
        mask &= df["uptrend"]
    passed = df[mask].copy()
    if passed.empty:
        return passed

    ranks = pd.DataFrame({
        k: (-passed[k] if k == "off_high" else passed[k]).rank(pct=True) for k in WEIGHTS
    })
    passed["score"] = sum(ranks[k] * w for k, w in WEIGHTS.items()).round(3)
    return passed.sort_values("score", ascending=False)


def template_thesis(row: pd.Series) -> str:
    """Rule-based one-liner used when the LLM agent is not run."""
    return (f"{row.get('name') or row.name}: revenue +{row['revenue_growth']:.0%} YoY with "
            f"{row['ret_12_1']:+.0%} 12-1M momentum, {row['off_high']:.0%} off its 52w high "
            f"and above a rising 50/200DMA — growth and tape are confirming each other.")
