# House Hub

A home dashboard web app for the iPad on the wall and for your phones (Android or
iPhone). There's no server to run: the app is a static website hosted free on
GitHub Pages, and your lists sync between devices through a free Firebase database.

The home screen has the clock, live weather and everyone's to-dos at the top, notifications below,
and big buttons along the bottom for the sub-apps:

| App | What it does |
|---|---|
| 📅 **Calendar** | Month view plus a day list. **Two-way Google Calendar sync**: Google events show here, and events added here go into Google. Events are tagged Jess / Graham / Both. |
| 🛒 **Groceries** | Shared shopping list. Adding something that's already there bumps it to ×2, ×3… (or use − / +). Tick an item and it's removed (with Undo). Items you buy often appear under *Buy again*. **Meals**: save a meal with its ingredients, then tap **+ Add to list** to put them all on the list. |
| ✅ **To-Do** | Tasks with an owner (Jess / Graham / Together), an optional due date, and a switch for whether they show on the home screen or only in the list. |
| 📹 **Cameras** | Live LSC garage camera and Ring doorbell snapshots, both through the cloud, so nothing extra runs at home. Doorbell presses show on the home screen. |

**Home screen (tablet layout):**
- **Header:** clock and date, the live weather in the middle (tap it for a 14-day forecast), and ⚙️ for Settings.
- **Today's agenda:** everything in today's calendar (finished events are dimmed), plus doorbell-ring, low-battery and bin-day alerts. Tap the panel to open the calendar.
- **To-dos:** a colour-coded column each for **Jess** and **Graham** (to-dos marked for the home screen). Tick to finish, tap to edit, *+ Add to-do*. Tap a name for the full list, including Together, list-only and done items.
- **Pinned family notes:** notes for everyone. *+ Note* to pin one, ✕ to unpin.
- **Quick utilities:** the **grocery list** (swipe to scroll, tick to remove, add items inline; tap its heading for the full Groceries screen) and **📷 Cameras**, which opens the doorbell (live) and garage camera side by side.

There's no dock: Calendar, Groceries, Cameras and Settings are all reached from the panels and ⚙️.

On phones the panels stack and the page scrolls.


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

## The House Hub worker (set up once, about 5 minutes)

Some features need a little bit of "server": Google Calendar sync and the cameras. Instead
of a box at home, they run in a free **Cloudflare Worker**
([`house-hub.worker.js`](house-hub.worker.js)), which is a small piece of code Cloudflare
runs for you in the cloud. Each feature is optional, so set up only the ones you want.

1. Sign up at <https://dash.cloudflare.com> (free). Go to **Workers & Pages → Create → Create Worker**, name it `house-hub`, and click **Deploy**.
2. Click **Edit code**, replace everything with the contents of [`house-hub.worker.js`](house-hub.worker.js), and click **Deploy**. Do this again whenever the file changes.
3. Go to **Settings → Variables and Secrets** and add `HUB_TOKEN` as a **Secret**: any long random password you make up.
4. In House Hub, open ⚙️ **Settings → House Hub worker**, paste the worker's address (e.g. `https://house-hub.yourname.workers.dev`) and the `HUB_TOKEN`, and tap **Save & test**. This setting is shared, so every device picks it up.

The worker also lets the hub read **iCloud / Outlook** calendar feeds. Add them under
*Other calendars (.ics feeds)*.

## Google Calendar sync (two-way)

What you get:
- Your Google calendars show in the hub, on every device.
- Events you add in the hub are created in Google, coloured by who they're for: Jess = pink, Graham = green, Both = blue.
- Tapping ✕ on a Google event in the hub deletes it from Google.

The worker talks to Google through a **service account**, which is a robot Google account
you share your calendars with. Nobody signs in on the iPad, and nothing expires.

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

### C. Give the worker the details
In the worker's **Settings → Variables and Secrets**, add:

| Name | Type | Value |
|---|---|---|
| `GOOGLE_SERVICE_ACCOUNT` | Secret | the **entire contents** of the downloaded `.json` file |
| `GOOGLE_CALENDAR_IDS` | Text | calendar IDs separated by commas, e.g. `you@gmail.com,jess@gmail.com`. New events go to the first one unless you pick another. |

Then open ⚙️ Settings in the hub and tap **Save & test**. It should list your calendars.

## Bin collection reminders (Mijn Afvalwijzer)

After you paste the latest worker code into Cloudflare, go to ⚙️ **Settings → Bin collection**, enter your
postcode and house number (with any letter in *Suffix*), and tap **Save & test**. You then get:
- bin days in the calendar, coloured by bin type
- **"🗑️ Bin day tomorrow: GFT – put it out tonight"** on the home screen from 12:00 the day before
- **"Bin collection today"** until 12:00 on the day

The worker reads the same schedule the Mijn Afvalwijzer app shows, using the same
unofficial address Home Assistant's afvalwijzer integration uses, and refreshes it twice a
day. If Mijn Afvalwijzer changes it, the Settings status line will show an error.
The reminders appear in the hub; they aren't phone push notifications.

## Cameras, with no box at home

| Camera | What you get in the hub | How |
|---|---|---|
| **LSC Outdoor Dual Band** (garage) | **Live video**, at home and away | The worker asks Tuya's official cloud API for a short-lived live stream. LSC cameras are Tuya devices. |
| **Ring doorbell** | **Live view** (video and optional sound), with the latest snapshot as an instant preview and fallback, a **"Someone rang the doorbell"** alert on the home screen, and a low-battery warning | Ring has no official API. The worker uses the same unofficial one Home Assistant uses. For live view it only swaps the WebRTC connection details; the video comes straight from Ring to your device. |

Streams only run while the Cameras screen is open.

### LSC garage camera (Tuya), about 20 minutes
1. **Move the camera to the Smart Life app.** Tuya's developer platform links to *Smart Life* or *Tuya Smart* accounts, not to the LSC app.
   - In **LSC Smart Connect**, remove the camera.
   - Install **Smart Life** (by Tuya) and create an account.
   - Reset the camera (hold its reset button until it beeps) and add it in Smart Life. Check the live view works there.
2. **Create a Tuya cloud project.** Sign up at <https://platform.tuya.com>, then go to **Cloud → Development → Create Cloud Project**:
   - **Development Method:** Smart Home
   - **Data Center:** **Central Europe** (this must match your Smart Life account's region; for the Netherlands it's Central Europe)
   - On the API services screen, make sure **IoT Video Live Stream** is included, as well as the defaults (IoT Core, Authorization). The video one is what gives live streams.
3. **Link your Smart Life account.** In the project, open **Devices → Link Tuya App Account → Add App Account**. Scan the QR code with Smart Life (**Me** tab → scan icon, top right). Your camera appears in the list: copy its **Device ID**.
4. **Give the worker the keys.** On the project's **Overview** tab, copy the **Access ID** and **Access Secret**, then add them to the worker:

   | Name | Type | Value |
   |---|---|---|
   | `TUYA_CLIENT_ID` | Text | Access ID |
   | `TUYA_CLIENT_SECRET` | Secret | Access Secret |
   | `TUYA_ENDPOINT` | Text | only if your data center isn't Central Europe, e.g. Western Europe = `https://openapi-weaz.tuyaeu.com` |

5. **Add it in the hub.** Go to ⚙️ **Settings → Cameras**, choose **LSC / Tuya camera**, enter a name and the Device ID, and tap **Add camera**.

Notes:
- Tuya's free developer plan has to be **renewed every few months** from the Tuya console. If the stream stops with a Tuya error, check that first.
- If the camera records in H.265, some older iPads can't play it, and the tile will say so.

### Ring doorbell, about 5 minutes
1. **Give the worker somewhere to keep the Ring login:**
   - In Cloudflare, go to **Storage & Databases → KV → Create** and name it `house-hub`.
   - Open the worker's **Settings → Bindings → Add → KV namespace**, set the variable name to `HUB_KV`, choose `house-hub`, and click **Deploy**.
2. **Log in from the hub.** Go to ⚙️ **Settings → Cameras**, choose **Ring doorbell**, and enter your Ring email and password. Then enter the code Ring texts or emails you, and tap **Add** next to your doorbell. Your password only goes to your own worker. The worker stores just the login token, and refreshes it automatically.
3. **In the Ring app,** turn on **Snapshot Capture** for the doorbell (Device → Settings). Otherwise battery doorbells only take a new picture when there's motion.

Notes:
- **Live view** starts when you tap **📷 Cameras** on the home screen (doorbell and garage side by side) or open the Cameras screen. It stops when you close it, or after a few idle minutes on the wall iPad, to save the doorbell battery. Tap 🔇 for sound. Tap a camera for full screen; there, **🎤 Talk** lets you speak through the doorbell. The first tap asks for microphone access and briefly reconnects, then the button toggles talk/mute, and closing full screen turns the microphone off. If Ring refuses, the tile shows the latest snapshot and says why. It needs iOS 15 or newer (WebRTC) and the latest worker code.
- **When someone rings the doorbell,** an open hub plays a ding-dong through its speakers and opens the doorbell camera full screen, already connected with the microphone, but with your mic and the doorbell audio muted. **📞 Answer** unmutes both and switches on the doorbell speaker; then use **Mute** and **Hang up**. **Dismiss**, or a minute with no answer, closes it. The hub checks for presses every 10 seconds while it's on screen, so allow about 10–15 seconds. You can turn this on or off per device in ⚙️ **Settings → Home screen**; it's on by default for the wall iPad. iPads only allow sound after someone has tapped the hub once since it was opened. Setting **Settings → Safari → Microphone → Allow** lets the microphone connect without asking each time.
- Ring lists the hub as **House Hub** under *Control Center → Authorized Client Devices*. You can remove it there at any time.
- Because this uses Ring's unofficial API, Ring could change or block it without warning. If it stops working, log in again from Settings.

### Alternative: go2rtc on a box at home
If you'd rather have live Ring video too, and don't mind a device at home that's always on (Raspberry Pi, NAS, PC or Home Assistant), see [`go2rtc.example.yaml`](go2rtc.example.yaml) and the camera type **go2rtc camera** in Settings. iPads can't run go2rtc themselves.

## Development

```bash
cd house_hub
npm start      # serves public/ on http://localhost:3000
npm test       # calendar parser + worker tests
```

All the app code is in `public/`: `app.js` (the app), `ics.js` (the calendar feed
parser), `app.css`, `sw.js` (offline support) and `manifest.webmanifest`
(installable on Android).
