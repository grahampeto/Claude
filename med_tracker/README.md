# Pill Tracker

A single-file web app (`index.html`) for tracking chronic medication. It needs no server and no install.

- **📦 Got pills from pharmacy**: adds each pickup to your loose stock at home. Each medication's usual pack size is filled in for you.
- **🗓️ Filled my dispenser**: moves a week's worth (pills/day × 7) from loose stock into the dispenser.
- **Order banner**: works out when each medication runs out, counting loose pills plus what is left in the dispenser.
  - Red **Order now**: you are inside your safety margin (default 7 days before running out).
  - Amber **Order this month**: the medication will reach its order-by date before your next monthly order (default 30 days), so put it on this order.
- Also warns when there aren't enough loose pills for the next full dispenser fill.
- Keeps a history with **Undo**, plus JSON **export/import** for backups.

## Use it
Online (private to you, saves to your Claude account): https://claude.ai/artifact/2VCXcG8F4FktqAB31ftaBp

Open `index.html` in any browser. On a phone, host it (for example with GitHub Pages), then use "Add to Home Screen".

Your data is saved in that browser's local storage on that one device. Export a backup from time to time.
