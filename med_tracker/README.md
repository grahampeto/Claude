# Pill Tracker

A single-file web app (`index.html`) for tracking chronic medication. It needs no server and no install.

- **Overview**: the date your next order is due, how many pills you have loose and in the dispenser, and how many days each medication lasts.
- **Fill dispenser**: one button. It takes each weekly dose × your fill period (default 2 weeks) out of your loose stock. Monthly medications (e.g. 1 on the 21st) go in only on the fill that covers their day.
- **Got pills from pharmacy**: type how many of each you actually received, since amounts can vary with pharmacy stock.
- **Weekly doses**: change pills per week after a checkup, or untick "Taking" to pause one. Paused medications keep their count but are left out of fills and order alerts.
- **History**: every pickup, fill and dose change, with Undo, plus backup export and import.

## Use it
Online (private to you, saves to your Claude account): https://claude.ai/artifact/2VCXcG8F4FktqAB31ftaBp

Open `index.html` in any browser. On a phone, host it (for example with GitHub Pages), then use "Add to Home Screen".

Your data is saved in that browser's local storage on that one device. Export a backup from time to time.
