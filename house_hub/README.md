# House Hub

A home dashboard web app for the iPad on the wall and for your phones (Android or
iPhone). There's no server to run: the app is a static website hosted free on
GitHub Pages, and your lists sync between devices through a free Firebase database.

The home screen has a clock, today's checklist progress and notifications at the top,
and big buttons along the bottom for the sub-apps:

| App | What it does |
|---|---|
| 📅 **Calendar** | Month view plus a day list. **Two-way Google Calendar sync**: Google events show here, and events added here go into Google. Events are tagged Jess / Graham / Both. |
| 🛒 **Groceries** | Shared shopping list. Adding something that's already there bumps it to ×2, ×3… (or use − / +). Tick an item and it's removed (with Undo). Items you buy often appear under *Buy again*. **Meals**: save a meal with its ingredients, then tap **+ Add to list** to put them all on the list. |
| ✅ **To-Do** | Tasks with an owner (Jess / Graham / Together) and an optional due date. |
| 📹 **Cameras** | Ring doorbell and LSC garage camera (see the camera section below). |
| 📋 **Daily Checklist** | Separate lists for Jess, Graham and Together. They reset every day and show the last 7 days. Tap **Edit list** to change the items. |

**Notifications** come from:
- notes you leave each other (**+ Leave a note**)
- what's on today and tomorrow
- **every open to-do**, overdue first, with a ✓ Done button
- unfinished checklists after 6pm
- how many items are on the shopping list

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

## Google Calendar sync (two-way)

What you get:
- Your Google calendars show in the hub, on every device.
- Events you add in the hub are created in Google, coloured by who they're for: Jess = pink, Graham = green, Both = blue.
- Tapping ✕ on a Google event in the hub deletes it from Google.

How it works: a small free **Cloudflare Worker** ([`house-hub.worker.js`](house-hub.worker.js))
talks to Google using a Google **service account**, which is a robot Google account you
share your calendars with. Nobody has to sign in on the iPad, and nothing expires.
Setup takes about 15 minutes, once.

### A. Create the Google service account
1. Go to <https://console.cloud.google.com>, then **Select a project → New project**. Name it `House Hub` and click **Create**.
2. Open **APIs & Services → Library**, search for **Google Calendar API**, and click **Enable**.
3. Open **APIs & Services → Credentials → Create credentials → Service account**. Name it `house-hub` and click **Done**. You can skip the roles.
4. Click the new service account, open the **Keys** tab, then **Add key → Create new key → JSON**. A `.json` file downloads. Keep it private.
5. Copy the service account's email, e.g. `house-hub@house-hub-12345.iam.gserviceaccount.com`.

### B. Share your calendar(s) with it
1. Open Google Calendar on a computer. Click ⚙️ **Settings**, then click the calendar under *Settings for my calendars*.
2. Under **Share with specific people or groups**, click **Add people**, paste the service account email, choose **Make changes to events**, and click **Send**.
3. Scroll down to **Integrate calendar** and copy the **Calendar ID**. For your main calendar this is your Gmail address.
4. Repeat for each calendar you want, e.g. Jess's calendar from Jess's account.

### C. Create the Cloudflare Worker
1. Sign up at <https://dash.cloudflare.com> (free). Go to **Workers & Pages → Create → Create Worker**, name it `house-hub`, and click **Deploy**.
2. Click **Edit code**, replace everything with the contents of [`house-hub.worker.js`](house-hub.worker.js), and click **Deploy**.
3. Go to the worker's **Settings → Variables and Secrets** and add:

   | Name | Type | Value |
   |---|---|---|
   | `HUB_TOKEN` | Secret | any long random password you make up |
   | `GOOGLE_SERVICE_ACCOUNT` | Secret | the **entire contents** of the downloaded `.json` file |
   | `GOOGLE_CALENDAR_IDS` | Text | calendar IDs separated by commas, e.g. `you@gmail.com,jess@gmail.com`. New events go to the first one unless you pick another. |

4. Copy the worker's address, e.g. `https://house-hub.yourname.workers.dev`.

### D. Connect House Hub
Open ⚙️ **Settings → Google Calendar sync**, paste the worker URL and the `HUB_TOKEN`,
and tap **Save & test**. It should say *Connected: …* and list your calendars. This
setting is shared, so you only do it once and every device picks it up.

The same worker also lets the hub read **iCloud / Outlook** calendar feeds. Add them
under *Other calendars (.ics feeds)* using the calendar's public/secret iCal link.

## Cameras (Ring doorbell + LSC garage camera)

**Why you need a small box at home:** Ring has no public video stream, and the LSC camera
only streams on your home network. Something at home has to collect the video and hand
it to the app. That's [go2rtc](https://github.com/AlexxIT/go2rtc): free, small, and it
runs on a Raspberry Pi, a NAS, an always-on PC/Mac, or as a Home Assistant add-on.

### Step 1: Install go2rtc on an always-on device
It can't run on the wall iPad: iOS doesn't let apps run background servers. Pick one of these:
- **Raspberry Pi / NAS / Linux with Docker:**
  ```bash
  mkdir -p ~/go2rtc && docker run -d --name go2rtc --network host --restart unless-stopped -v ~/go2rtc:/config alexxit/go2rtc
  ```
- **Home Assistant:** go to Settings → Add-ons → Add-on store → ⋮ → Repositories, add
  `https://github.com/AlexxIT/hassio-addons`, then install **go2rtc** and start it.
- **An old Android phone, left plugged in:** install **Termux** from F-Droid, download the
  `go2rtc_linux_arm64` build from the releases page into Termux, make it executable
  (`chmod +x`) and run it. Turn on Termux's wake lock and switch off battery optimisation for Termux so
  Android doesn't stop it.
- **Windows / Mac:** download go2rtc for your system from
  <https://github.com/AlexxIT/go2rtc/releases> and run it. It creates `go2rtc.yaml` next to itself.

Give the device a **fixed IP address** in your router (e.g. `192.168.1.10`), then open
`http://192.168.1.10:1984` in a browser. You should see the go2rtc page.

### Step 2: Add the Ring doorbell
1. In the go2rtc page, click **Add**, then open the **Ring** section.
2. Log in with your Ring email and password, and enter the 2-factor code Ring sends you.
3. go2rtc shows a line starting `ring:?device_id=…&refresh_token=…`. Copy it.
4. Click **Config** and add it under `streams:`, naming it `ring_doorbell` (see [`go2rtc.example.yaml`](go2rtc.example.yaml)). Save, then restart go2rtc.
5. Back on the main page, click **stream** next to `ring_doorbell` to check you get video.

Ring only streams while someone's watching. Battery doorbells drain faster while live,
so the hub only streams while the Cameras screen is open, and the wall iPad goes back to
the home screen after 3 idle minutes.

### Step 3: Add the LSC garage camera
LSC Smart Connect cameras (sold at Action) are Tuya-based, and it varies by model:
1. Find the camera's IP address in your router's device list and give it a fixed IP.
2. In go2rtc, click **Add** and look at the **ONVIF** section. If the camera is listed, click it and enter the camera password. go2rtc shows its `rtsp://…` address.
3. If it isn't listed, check the camera's settings in the LSC Smart Connect app for an **ONVIF / RTSP / NVR** option. Turn it on, set a password, and try step 2 again. Then try `rtsp://admin:PASSWORD@<camera-ip>:554/` in go2rtc.
4. Add it under `streams:` as `garage`, then save and restart.

If your model has no ONVIF/RTSP at all, it only streams through Tuya's cloud. You have two options:
- Use Home Assistant's **Tuya** integration. It shows the camera, and go2rtc can pull from Home Assistant.
- Flash open firmware such as [thingino](https://thingino.com) or [OpenIPC](https://openipc.org). This only works on supported chips and is a bit techy.

### Step 4: Add the cameras to House Hub
In ⚙️ **Settings → Cameras**, choose **go2rtc camera** and enter:
- **go2rtc address:** `http://192.168.1.10:1984`
- **Stream name:** `ring_doorbell` (then add another one for `garage`)

The app picks the best player for each device: go2rtc's own low-latency player on phones
and newer iPads, and plain HLS video on old iPads.

### Step 5: Open House Hub from the go2rtc box at home
The GitHub Pages copy is `https://`, and browsers block `http://` camera streams inside
an `https://` page. Old iPads are sometimes lenient, but phones aren't. The fix is to let
go2rtc serve House Hub over `http://` on your home network. It's the same app with the
same synced data.

1. Put the app files on the go2rtc box (in the Docker example, inside `~/go2rtc`):
   ```bash
   cd ~/go2rtc && git clone -b claude/nice-mayer-s8lx0u https://github.com/grahampeto/Claude.git house-hub
   ```
2. Add this to `go2rtc.yaml` and restart go2rtc:
   ```yaml
   api:
     listen: ":1984"
     static_dir: "/config/house-hub/house_hub/public"   # Docker path; elsewhere use the real folder path
   ```
   Do Step 2 (the Ring login) first: once `static_dir` is set, the address shows House
   Hub instead of go2rtc's own pages. Remove the line temporarily if you need those pages again.
3. On the wall iPad, open `http://192.168.1.10:1984/`, add it to the Home Screen, and use that icon.
4. In ⚙️ Settings, use **Got a setup link? Paste it here** with the link from another device. That connects it to your shared lists.
5. To update it later, run `cd ~/go2rtc/house-hub && git pull`.

Phones can use the same address while on your home Wi-Fi. Away from home, live cameras
need more setup (go2rtc over HTTPS through Tailscale or Home Assistant Cloud), so the
Ring app is usually simplest there.

## Development

```bash
cd house_hub
npm start      # serves public/ on http://localhost:3000
npm test       # calendar parser + worker tests
```

All the app code is in `public/`: `app.js` (the app), `ics.js` (the calendar feed
parser), `app.css`, `sw.js` (offline support) and `manifest.webmanifest`
(installable on Android).
