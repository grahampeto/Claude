import json

import numpy as np
import pandas as pd
import pytest

from stock_picker.agent import build_tools
from stock_picker.data import MarketData
from stock_picker.screen import ScreenCriteria, momentum_metrics, rsi, screen

DAYS = 300


def _path(start, end, noise=0.0, seed=0):
    rng = np.random.default_rng(seed)
    base = np.geomspace(start, end, DAYS)
    return base * (1 + rng.normal(0, noise, DAYS))


@pytest.fixture
def data():
    idx = pd.bdate_range("2025-01-01", periods=DAYS)
    closes = pd.DataFrame({
        "WIN": _path(10, 30),     # strong steady uptrend
        "OK": _path(10, 15),      # moderate uptrend
        "DOWN": _path(30, 10),    # downtrend
        "BIG": _path(10, 30),     # great chart but large cap
        "SLOW": _path(10, 30),    # great chart, weak growth
    }, index=idx)
    fundamentals = pd.DataFrame({
        "name": ["Win Co", "Ok Co", "Down Co", "Big Co", "Slow Co"],
        "market_cap": [5e9, 8e9, 6e9, 200e9, 4e9],
        "revenue_growth": [0.40, 0.20, 0.30, 0.50, 0.03],
        "avg_volume": [1e6] * 5,
    }, index=closes.columns)
    return MarketData(closes=closes, fundamentals=fundamentals,
                      details={"WIN": {"longName": "Win Co", "marketCap": 5e9}})


def test_momentum_metrics_returns(data):
    m = momentum_metrics(data.closes)
    assert m.loc["WIN", "ret_12m"] > 0.5
    assert m.loc["DOWN", "ret_12m"] < 0
    assert m.loc["WIN", "uptrend"] and not m.loc["DOWN", "uptrend"]
    assert m.loc["WIN", "off_high"] == pytest.approx(0, abs=1e-9)


def test_short_history_is_skipped(data):
    assert momentum_metrics(data.closes.tail(100)).empty


def test_screen_filters_and_ranks(data):
    result = screen(data.closes, data.fundamentals)
    assert list(result.index) == ["WIN", "OK"]  # DOWN, BIG, SLOW all filtered
    assert result["score"].is_monotonic_decreasing


def test_criteria_loosening(data):
    loose = ScreenCriteria(max_market_cap=500e9, min_revenue_growth=0.0)
    assert set(screen(data.closes, data.fundamentals, loose).index) == {"WIN", "OK", "BIG", "SLOW"}


def test_rsi_bounds():
    assert rsi(pd.Series(np.arange(1, 50, dtype=float))) == pytest.approx(100)
    assert 0 <= rsi(pd.Series(_path(10, 12, noise=0.02))) <= 100


def test_agent_tools_offline(data):
    screen_stocks, stock_detail = build_tools(data)
    out = json.loads(screen_stocks.call({"limit": 5}))
    assert out["passed"] == 2 and out["results"][0]["ticker"] == "WIN"
    assert json.loads(stock_detail.call({"ticker": "win"}))["longName"] == "Win Co"
    assert "error" in json.loads(stock_detail.call({"ticker": "NOPE"}))
    assert screen_stocks.to_dict()["name"] == "screen_stocks"
