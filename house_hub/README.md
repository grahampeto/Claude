# House Hub

A home dashboard web app for the iPad on the wall and for your phones (Android or
iPhone). There's no server to run: the app is a static website hosted free on
GitHub Pages, and your lists sync between devices through a free Firebase database.

The home screen has a clock, today's checklist progress and notifications at the top,
and big buttons along the bottom for the sub-apps:

| App | What it does |
|---|---|
| 📅 **Calendar** | Month view plus a day list. Add household events tagged Jess / Graham / Both, and optionally show Google/iCloud/Outlook calendars. |
| 🛒 **Groceries** | Shared shopping list. Tick items off, then tap **Clear ticked**. Items you buy often appear as one-tap chips. |
| ✅ **To-Do** | Tasks with an owner (Jess / Graham / Together) and an optional due date. |
| 📹 **Cameras** | Ring doorbell and LSC garage camera (see the camera section below). |
| 📋 **Daily Checklist** | Separate lists for Jess, Graham and Together. They reset every day and show the last 7 days. Tap **Edit list** to change the items. |

**Notifications** come from: notes you leave each other (**+ Leave a note**), what's on
today and tomorrow, overdue tasks or tasks due soon, unfinished checklists after 6pm,
and how many items are on the shopping list.

**Wall display mode** is on by default on tablets and off on phones. You can change it
for each device in ⚙️ Settings. With it on, the app goes back to the home screen after
3 idle minutes and dims between 23:00 and 06:00.

## How it fits together

```
GitHub Pages (the app: HTML/JS/CSS)
        │ loads
        ▼
 iPad ◄──────► Firebase Realtime Database ◄──────► Android phones
       live sync    (free "Spark" plan)      live sync
```

- Every device keeps its own copy in browser storage, so the app works with no signal and syncs once it's back online.
- Without Firebase the app still works, but each device keeps its own separate data.
- The code is written in plain ES5 (checked with an ES5 parser), so it also runs on iPads stuck on old iOS (iOS 9.3+).

## Setup (about 10 minutes, all free)

### 1. Publish the app (GitHub Pages)
1. On GitHub, open the repo, then **Settings → Pages**. Under *Build and deployment*, set **Source: GitHub Actions**.
2. The deploy runs automatically on every push to this branch or `main`. To run it by hand, open the latest **Deploy House Hub to GitHub Pages** run under **Actions** and click **Re-run all jobs**. (GitHub only shows a *Run workflow* button once the workflow file is on the repo's default branch.)
3. Your app will be at **`https://grahampeto.github.io/Claude/`**.

If the run says the branch isn't allowed to deploy, go to **Settings → Environments →
github-pages** and add the branch under *Deployment branches*.

### 2. Create the shared database (Firebase)
1. Go to <https://console.firebase.google.com>, click **Create a project** (any name), and skip Google Analytics.
2. Open **Build → Realtime Database**, then **Create database**. Choose a location (e.g. Belgium `europe-west1`) and **Start in locked mode**.
3. Open the **Rules** tab, paste the rules below and click **Publish**:

   ```json
   {
     "rules": {
       ".read": false,
       ".write": false,
       "homes": {
         "$home": {
           ".read": "$home.length >= 16",
           ".write": "$home.length >= 16"
         }
       }
     }
   }
   ```
4. Copy the database URL shown at the top of the *Data* tab, e.g. `https://house-hub-1234-default-rtdb.europe-west1.firebasedatabase.app`.

**How private is it?** Your data sits under a random 24-character *household key*. Nobody
can list the keys, so only someone who has your key (or your setup link) can read or
change your lists. Treat the setup link like a password. This is fine for shopping lists
and chores. Don't store anything sensitive.

### 3. Connect the iPad
1. Open `https://grahampeto.github.io/Claude/` in Safari.
2. Tap ⚙️, paste the database URL, tap **New key**, then **Save & connect**. It should say *Connected*.
3. Tap Share, then **Add to Home Screen**, and open the hub from that icon (full screen).
4. Go to Settings, then Display & Brightness, set **Auto-Lock: Never**, and keep it plugged in. Optionally turn on **Guided Access** to lock it to the hub.

### 4. Connect the phones
1. On the iPad, go to ⚙️ and tap **Share setup link**. Send the link to each phone (WhatsApp, email…).
2. Open the link on the phone and tap **OK** to connect.
3. In Chrome on Android, tap ⋮ then **Add to Home screen** (or **Install app**). It then opens like a normal app.

## Calendars

Events you add in the hub are shared through Firebase and need nothing else.

To also show **Google / iCloud / Outlook** calendars, add each one in ⚙️ → Calendars
using its secret iCal address:
- **Google**: Calendar settings, then the calendar, then *Integrate calendar*, then **Secret address in iCal format**
- **iCloud**: Calendar app, then share the calendar, then **Public Calendar**, then copy the link
- **Outlook**: Settings, then Calendar, then Shared calendars, then **Publish**, then the ICS link

These providers don't let a web page read their feeds directly (the browser blocks it).
The fix is a tiny free **Cloudflare Worker** that passes the feed through. It runs on
Cloudflare, so there's still nothing to run at home:

1. Sign up at <https://dash.cloudflare.com> (free), go to **Workers & Pages**, then **Create**, then **Create Worker**, then **Deploy**.
2. Click **Edit code**, replace everything with [`cors-proxy.worker.js`](cors-proxy.worker.js), then **Deploy**.
3. In House Hub, open ⚙️ and set the **CORS proxy** to `https://<your-worker>.<you>.workers.dev/?url=`.

The worker only forwards Google, iCloud and Outlook calendar addresses, so nobody can
use it as an open proxy. Calendar settings are shared, so you only set this up once.

## Cameras (Ring doorbell + LSC garage camera)

To be upfront: **live camera video needs something running at home.** Ring has no public
stream, and the LSC camera streams on your local network, so no website can show them on
its own.

The usual tool is [go2rtc](https://github.com/AlexxIT/go2rtc). It's free and runs on a
Raspberry Pi, a NAS or a PC, or as a Home Assistant add-on. There's a starter config in
[`go2rtc.example.yaml`](go2rtc.example.yaml).
- **Ring**: go2rtc has built-in Ring support. In the go2rtc web UI (`:1984`) click **Add**, then **Ring**, then log in.
- **LSC Smart Connect (Action)**: many models offer RTSP/ONVIF (`rtsp://admin:PASSWORD@<ip>:554/stream1`). Cloud-only models need custom firmware (OpenIPC / thingino) or a Tuya integration in Home Assistant.

Then add each camera in ⚙️ → Cameras:

| Type | URL example |
|---|---|
| MJPEG (best for old iPads) | `http://192.168.1.10:1984/api/stream.mjpeg?src=garage` |
| HLS | `http://192.168.1.10:1984/api/stream.m3u8?src=garage` |
| Snapshot | `http://192.168.1.10:1984/api/frame.jpeg?src=ring_doorbell` |

**The catch with `http://`:** the app is served over `https://`. Newer browsers
(Chrome on Android, recent iOS) block `http://` camera addresses inside an `https://`
page. Older iPads usually allow them. To get cameras working everywhere, serve go2rtc
over HTTPS. go2rtc supports `tls_listen` with a certificate, and the Home Assistant
add-on with Nabu Casa or a reverse proxy gives you HTTPS out of the box. On the phones,
the Ring app is often simplest anyway.

Streams only run while the Cameras screen is open, which saves Wi-Fi and the Ring battery.

## Development

```bash
cd house_hub
npm start      # serves public/ on http://localhost:3000
npm test       # calendar parser + proxy tests
```

All the app code is in `public/`: `app.js` (the app), `ics.js` (the calendar feed
parser), `app.css`, `sw.js` (offline support) and `manifest.webmanifest`
(installable on Android).
