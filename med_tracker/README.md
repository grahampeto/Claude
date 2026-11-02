# Pill Tracker

A single-file web app (`index.html`) for tracking chronic medication. It needs no server and no install.

- **Overview**: enter your next doctor's appointment (where you order). The tracker flags what to ask for there, and anything that runs out before the appointment plus 4 days for delivery. Pills on hand are grouped as Taking now, Paused and Stopped.
- **Fill dispenser**: one button. It takes each weekly dose × your fill period (default 2 weeks) out of your loose stock. Monthly medications (e.g. 1 on the 21st) go in only on the fill that covers their day.
- **Got pills from pharmacy**: type how many of each you actually received, since amounts can vary with pharmacy stock.
- **Weekly doses**: change pills per week after a checkup, or set one to Paused (may come back) or Stopped. Both keep their count but are left out of fills and order alerts.
- **History**: every pickup, fill and dose change, with Undo, plus backup export and import.

## Use it
Online (private to you, saves to your Claude account): https://claude.ai/artifact/2VCXcG8F4FktqAB31ftaBp

Open `index.html` in any browser. On a phone, host it (for example with GitHub Pages), then use "Add to Home Screen".

Your data is saved in that browser's local storage on that one device. Export a backup from time to time.
