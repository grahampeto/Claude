# Mid-cap growth stock picker

An agent that screens US mid-cap growth stocks for strong momentum and returns a top 3
with a one-line thesis each.

**How it works**

1. **Data** (`stock_picker/data.py`) – ~14 months of daily prices plus fundamentals from
   Yahoo Finance (`yfinance`) for a seed universe (`stock_picker/universe.py`).
2. **Screen** (`stock_picker/screen.py`) – deterministic filters:
   - market cap $2B–$20B
   - revenue growth ≥ 15% YoY
   - 6-month return ≥ 10%, within 20% of the 52-week high
   - uptrend: price > 50DMA > 200DMA; avg volume ≥ 300k

   Survivors are ranked by a weighted percentile score: 12-1M momentum (30%),
   revenue growth (25%), 6M (20%), 3M (15%), proximity to high (10%).
3. **Agent** (`stock_picker/agent.py`) – Claude (`claude-opus-5-5`, via the SDK tool
   runner) calls the screen as a tool, loosens it if too few names pass, pulls
   business detail on finalists, checks recent news with web search, and writes the
   top 3. Server-side refusal fallbacks (`fallbacks: "default"`) are enabled.

## Usage

```bash
pip install -r requirements.txt
export ANTHROPIC_API_KEY=...            # only needed for the agent mode

python -m stock_picker                   # full agent: screen + research + top 3
python -m stock_picker --no-web -v       # agent without web search, show tool calls
python -m stock_picker --no-llm          # rule-based top 3, no API key needed
python -m stock_picker --tickers-file my_universe.txt
pytest                                   # offline tests on synthetic prices
```

Not investment advice. Yahoo fundamentals can be stale or missing for some tickers.
