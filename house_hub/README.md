# House Hub

A home dashboard for an old iPad on the wall. The home screen has a clock, today's
checklist progress and notifications at the top, and big buttons along the bottom for
the sub-apps:

| App | What it does |
|---|---|
| 📅 **Calendar** | Month view plus a day list. Pulls in Google/iCloud/Outlook calendars (as .ics feeds) and lets you add household events tagged Jess / Graham / Both. |
| 🛒 **Groceries** | Shared shopping list. Tick items off, then tap **Clear ticked**. Items you buy often appear as one-tap chips. |
| ✅ **To-Do** | Tasks with an owner (Jess / Graham / Together) and an optional due date. Overdue tasks show up on the home screen. |
| 📹 **Cameras** | Ring doorbell and LSC garage camera. Streams only run while this screen is open. |
| 📋 **Daily Checklist** | Separate lists for Jess, Graham and Together. They reset every day and show the last 7 days. Tap **Edit list** to change the items. |

**Notifications** on the home screen come from: notes you leave for each other
(**+ Leave a note**), what's on today and tomorrow, overdue tasks or tasks due soon,
unfinished checklists after 6pm, and how many items are on the shopping list.

Other things built for a wall iPad:
- After 3 minutes without a touch it goes back to the home screen, which also stops the camera streams.
- From 23:00 to 06:00 the screen dims. A tap wakes it.
- It works offline. Changes are kept on the iPad and sync when the server is back.
- Data is shared, so you can also open the hub on your phones (`http://<server>:8080`) and add groceries from the shop.

## How it fits together

```
 iPad (Safari, full screen) ──►  House Hub server (node server.js, port 8080)
 phones (optional)              ├─ stores lists in data/state.json
                                ├─ fetches calendar .ics feeds
                                └─ camera URLs ──► go2rtc (port 1984) ──► Ring / LSC camera
```

The iPad only shows the web page. The server has to run on a machine that's always on,
such as a Raspberry Pi, a NAS, a home server or a PC that stays on. It needs Node.js 14
or newer and has **no dependencies**.

The front end is written in plain ES5 with flexbox, so it runs on iPads stuck on old iOS
(it's designed for iOS 9.3+ and has been checked against an ES5 parser).

## Setup

```bash
cd house_hub
cp config.example.json config.json   # then edit it
npm start                            # or: node server.js
```

### On the iPad
1. Open Safari and go to `http://<server-ip>:8080`.
2. Tap Share, then **Add to Home Screen**. Open it from the new icon to get full screen without the Safari toolbars.
3. Go to Settings, then Display & Brightness, then **Auto-Lock: Never**, and leave it plugged in.
4. Optional: turn on **Guided Access** (Settings, then Accessibility) to lock the iPad to the hub.

### Calendars
In `config.json`, add each calendar's secret iCal address under `calendars`:
- **Google**: Calendar settings, then *Integrate calendar*, then **Secret address in iCal format**
- **iCloud**: Calendar app, then share the calendar, then **Public Calendar**, then copy the `webcal://` link
- **Outlook**: Settings, then Calendar, then Shared calendars, then **Publish**, then the ICS link

Feeds refresh every 10 minutes. The feeds are read-only, so events you add in the hub
are stored in the hub.

### Cameras (Ring doorbell + LSC garage camera)
Neither camera gives you a stream a browser can play directly, so use
[go2rtc](https://github.com/AlexxIT/go2rtc). It's a small free program that converts
camera streams. Run it on the same machine as the hub. There is a starter config in
`go2rtc.example.yaml`.

- **Ring**: go2rtc has a built-in Ring source. In the go2rtc web UI (`:1984`), click **Add**, then **Ring**, then log in. Copy the generated `ring:` line into `go2rtc.yaml`. A battery doorbell drains faster while it streams, so the hub only streams while the Cameras screen is open.
- **LSC Smart Connect (Action)**: many models can do RTSP/ONVIF (e.g. `rtsp://admin:PASSWORD@<ip>:554/stream1`). Some only stream through the Tuya cloud. Those need custom firmware (OpenIPC / thingino) or a Tuya integration in Home Assistant.

Then set each camera in `config.json`:

| `type` | Use for | Example `url` |
|---|---|---|
| `mjpeg` | **Best for old iPads**: live video in a plain image | `http://<server>:1984/api/stream.mjpeg?src=garage` |
| `hls` | Native iOS video (lower bandwidth) | `http://<server>:1984/api/stream.m3u8?src=garage` |
| `snapshot` | A still image refreshed every `refreshSeconds` (the server fetches it for you) | `http://<server>:1984/api/frame.jpeg?src=ring_doorbell` |
| `iframe` | Embed any web page | anything |

If you already use Home Assistant, you can use its camera proxy URLs instead.

### Run it on boot (Raspberry Pi / Linux)
```ini
# /etc/systemd/system/house-hub.service
[Unit]
Description=House Hub
After=network-online.target

[Service]
WorkingDirectory=/home/pi/house_hub
ExecStart=/usr/bin/node server.js
Restart=always
User=pi

[Install]
WantedBy=multi-user.target
```
```bash
sudo systemctl enable --now house-hub
```

## Data & API
Everything is saved in `data/state.json` (back it up if you care about it). The API is
small: `GET /api/state`, `PUT /api/state/{events|groceries|todos|checklists|notes}`,
`GET /api/calendar`, `GET /api/config`. There is **no login**, so keep the server on your
home network and don't port-forward it to the internet.

## Tests
```bash
npm test        # calendar (.ics) parser tests
```
