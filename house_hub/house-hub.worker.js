// House Hub helper – a free Cloudflare Worker. Everything that needs a
// "server" runs here in Cloudflare's cloud, so nothing has to stay on at home.
//
//  1. Calendar feed proxy:   GET /?url=<ics url>
//     Lets the browser read iCloud / Outlook / Google .ics feeds (they don't
//     send CORS headers). Only calendar hosts are allowed.
//
//  2. Google Calendar sync:  /google/...
//     Reads, creates and deletes events using a Google service account that
//     you share your calendars with. No sign-in on the iPad, nothing expires.
//
//  3. Tuya / LSC cameras:    /tuya/stream/<deviceId>
//     Asks Tuya's official cloud API for a short-lived live HLS stream link.
//
//  4. Ring doorbell:         /ring/...
//     Latest snapshot + recent dings/motion, via Ring's unofficial API
//     (the same one Home Assistant uses). Ring can change it at any time.
//
//  5. Bin collection:        /afval?postcode=1234AB&number=12
//     Your Mijn Afvalwijzer schedule (unofficial, as used by Home Assistant's
//     afvalwijzer integration). Needs no setup.
//
// Secrets / variables (Worker → Settings → Variables and Secrets):
//   HUB_TOKEN                  any long random string; also typed into House Hub Settings
//   GOOGLE_SERVICE_ACCOUNT     the whole service-account JSON key file (Secret)
//   GOOGLE_CALENDAR_IDS        comma-separated calendar IDs (first = default for new events)
//   TUYA_CLIENT_ID             Tuya IoT project Access ID
//   TUYA_CLIENT_SECRET         Tuya IoT project Access Secret (Secret)
//   TUYA_ENDPOINT              optional, default https://openapi.tuyaeu.com (Central Europe)
// Bindings (Worker → Settings → Bindings):
//   HUB_KV                     a KV namespace – stores the Ring login
// Each part is optional: only set up the ones you use.
// See house_hub/README.md for step-by-step setup.

const ICS_HOSTS = ['calendar.google.com', 'outlook.office365.com', 'outlook.live.com'];
const ICS_SUFFIXES = ['.icloud.com'];
const GCAL = 'https://www.googleapis.com/calendar/v3';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

// ---------------------------------------------------------------- ICS proxy
async function icsProxy(target) {
  let u;
  try { u = new URL(target.replace(/^webcal:/i, 'https:')); } catch (e) {
    return new Response('bad url', { status: 400, headers: CORS });
  }
  const ok = u.protocol === 'https:' &&
    (ICS_HOSTS.includes(u.hostname) || ICS_SUFFIXES.some((s) => u.hostname.endsWith(s)));
  if (!ok) return new Response('host not allowed', { status: 403, headers: CORS });
  const res = await fetch(u.toString(), { headers: { 'User-Agent': 'HouseHub/2.0' }, cf: { cacheTtl: 300 } });
  return new Response(res.body, {
    status: res.status,
    headers: { ...CORS, 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'max-age=300' },
  });
}

// ---------------------------------------------------------------- Google auth
function b64url(bytes) {
  let s = '';
  const arr = bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

let tokenCache = { token: null, exp: 0 };
let pendingToken = null;

// Several calendars are read in parallel; share one sign-in between them.
function googleToken(env) {
  if (tokenCache.token && Date.now() < tokenCache.exp - 60000) return Promise.resolve(tokenCache.token);
  if (!pendingToken) pendingToken = fetchToken(env).finally(() => { pendingToken = null; });
  return pendingToken;
}

function parseServiceAccount(env) {
  let sa;
  try { sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT); } catch (e) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT isn\u2019t valid JSON – paste the whole downloaded .json file, from { to }');
  }
  if (!sa.private_key || !sa.client_email) throw new Error('GOOGLE_SERVICE_ACCOUNT is missing private_key or client_email – is it the service-account key file?');
  return sa;
}

async function fetchToken(env) {
  const sa = parseServiceAccount(env);
  // Tolerate keys whose line breaks were pasted as literal "\n".
  const pem = sa.private_key.replace(/\\n/g, '\n').replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  let key;
  try {
    const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
    key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  } catch (e) {
    throw new Error('The private_key in GOOGLE_SERVICE_ACCOUNT is damaged – paste the whole .json file again without editing it');
  }
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  if (sa.private_key_id) header.kid = sa.private_key_id;
  const unsigned = b64url(JSON.stringify(header)) + '.' + b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/calendar',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }));
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') +
      '&assertion=' + unsigned + '.' + b64url(sig),
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = data.error_description || data.error || String(res.status);
    if (/signature/i.test(msg)) throw new Error('Google sign-in failed: ' + (await diagnoseKey(sa, unsigned, sig)));
    throw new Error('Google sign-in failed: ' + msg);
  }
  tokenCache = { token: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  return tokenCache.token;
}

// Google publishes each service account's public keys. Use them to explain
// an "Invalid JWT Signature" in plain words.
async function diagnoseKey(sa, unsigned, sig) {
  const id = sa.private_key_id || '';
  const short = id ? ' (key ' + id.slice(0, 8) + '…)' : '';
  try {
    const res = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/' + encodeURIComponent(sa.client_email));
    if (!res.ok) return 'Google doesn\u2019t know the service account ' + sa.client_email + ' – was it deleted?';
    const jwks = (await res.json()).keys || [];
    const jwk = jwks.find((k) => k.kid === id);
    if (!jwk) {
      return 'Google doesn\u2019t have this key' + short + '. It was deleted, or it was created in the last few minutes ' +
        '(wait 5 minutes and try again). Otherwise create a new JSON key and paste the whole file into GOOGLE_SERVICE_ACCOUNT.';
    }
    const pub = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', pub, sig, new TextEncoder().encode(unsigned));
    if (!ok) {
      return 'the private key in GOOGLE_SERVICE_ACCOUNT doesn\u2019t match key' + short +
        '. The pasted text was probably changed or mixed with another file – paste the whole .json file again.';
    }
    return 'the key' + short + ' checks out, but Google still refused it. New keys can take a few minutes to start working – try again shortly.';
  } catch (e) {
    return 'Invalid JWT Signature – usually a deleted or brand-new key (wait 5 minutes), or a damaged paste of the .json file.';
  }
}

async function gcal(env, path, init = {}) {
  const token = await googleToken(env);
  const res = await fetch(GCAL + path, {
    ...init,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error && data.error.message) || 'Google Calendar error ' + res.status);
  return data;
}

function calendarIds(env) {
  return (env.GOOGLE_CALENDAR_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
}

// Who (Jess / Graham / Both) is stored on the event and shown as its colour.
const WHO_COLOR = { jess: '4', graham: '2', both: '9' }; // Flamingo, Sage, Blueberry

function simplify(ev, cal) {
  const st = ev.start || {}, en = ev.end || {};
  const allDay = !!st.date;
  const priv = (ev.extendedProperties && ev.extendedProperties.private) || {};
  return {
    id: ev.id,
    calendarId: cal.id,
    calendar: cal.name,
    title: ev.summary || '(no title)',
    location: ev.location || '',
    allDay,
    // All-day dates are passed through as YYYY-MM-DD so the device can read them in local time.
    start: allDay ? st.date : st.dateTime,
    end: allDay ? en.date : en.dateTime,
    who: priv.houseHubWho || '',
    colorId: ev.colorId || '',
  };
}

async function listEvents(env, url) {
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const ids = calendarIds(env);
  const calendars = [];
  const events = [];
  const errors = [];
  await Promise.all(ids.map(async (id, i) => {
    try {
      const meta = await gcal(env, '/calendars/' + encodeURIComponent(id));
      const cal = { id, name: meta.summary || id, index: i };
      calendars.push(cal);
      let pageToken = '';
      do {
        const q = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime', maxResults: '2500', timeMin: from, timeMax: to });
        if (pageToken) q.set('pageToken', pageToken);
        const data = await gcal(env, '/calendars/' + encodeURIComponent(id) + '/events?' + q);
        (data.items || []).forEach((ev) => { if (ev.status !== 'cancelled') events.push(simplify(ev, cal)); });
        pageToken = data.nextPageToken || '';
      } while (pageToken);
    } catch (e) {
      errors.push(id + ': ' + e.message);
    }
  }));
  calendars.sort((a, b) => a.index - b.index);
  events.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return json({ calendars, events, errors });
}

async function createEvent(env, request) {
  const b = await request.json();
  const ids = calendarIds(env);
  const calId = b.calendarId && ids.includes(b.calendarId) ? b.calendarId : ids[0];
  if (!calId) return json({ error: 'GOOGLE_CALENDAR_IDS is not set' }, 500);
  if (!b.title || !b.start) return json({ error: 'title and start are required' }, 400);
  const body = {
    summary: b.title,
    description: 'Added from House Hub',
    extendedProperties: { private: { houseHubWho: b.who || '' } },
  };
  applyColorAndTimes(body, b);
  const ev = await gcal(env, '/calendars/' + encodeURIComponent(calId) + '/events', { method: 'POST', body: JSON.stringify(body) });
  return json(simplify(ev, { id: calId, name: '' }));
}

// Shared by create and edit. colorId: "1"–"11" picks a Google colour;
// empty means "auto" – the who-colour (Jess/Graham/Both) if there is one.
// When editing, the unused one of date/dateTime is cleared (null) so an
// event can switch between all-day and timed.
function applyColorAndTimes(body, b, isEdit) {
  const color = /^([1-9]|1[01])$/.test(String(b.colorId || '')) ? String(b.colorId) : WHO_COLOR[b.who];
  if (color) body.colorId = color;
  if (b.start) {
    if (b.allDay) {
      body.start = { date: b.start };
      body.end = { date: b.end || b.start };
      if (isEdit) { body.start.dateTime = null; body.end.dateTime = null; }
    } else {
      body.start = { dateTime: b.start };
      body.end = { dateTime: b.end || b.start };
      if (isEdit) { body.start.date = null; body.end.date = null; }
    }
  }
}

async function updateEvent(env, request, calId, eventId) {
  if (!calendarIds(env).includes(calId)) return json({ error: 'unknown calendar' }, 404);
  const b = await request.json();
  if (!b.title) return json({ error: 'title is required' }, 400);
  const body = { summary: b.title, extendedProperties: { private: { houseHubWho: b.who || '' } } };
  applyColorAndTimes(body, b, true);
  const ev = await gcal(env, '/calendars/' + encodeURIComponent(calId) + '/events/' + encodeURIComponent(eventId), { method: 'PATCH', body: JSON.stringify(body) });
  return json(simplify(ev, { id: calId, name: '' }));
}

async function deleteEvent(env, calId, eventId) {
  if (!calendarIds(env).includes(calId)) return json({ error: 'unknown calendar' }, 404);
  await gcal(env, '/calendars/' + encodeURIComponent(calId) + '/events/' + encodeURIComponent(eventId), { method: 'DELETE' });
  return json({ ok: true });
}

// ---------------------------------------------------------------- Tuya (LSC cameras)
// Signing follows Tuya's "cloud authorization" spec: HMAC-SHA256 over
// client_id [+ access_token] + t + nonce + stringToSign.
const enc = new TextEncoder();
function hex(buf) { return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join(''); }
async function sha256Hex(text) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(text))); }
async function hmacHex(key, text) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(text))).toUpperCase();
}

let tuyaToken = { token: null, exp: 0 };

async function tuyaRequest(env, method, path, body, useToken = true) {
  const base = (env.TUYA_ENDPOINT || 'https://openapi.tuyaeu.com').replace(/\/+$/, '');
  const bodyText = body ? JSON.stringify(body) : '';
  const t = String(Date.now());
  const stringToSign = [method, await sha256Hex(bodyText), '', path].join('\n');
  const token = useToken ? await tuyaAccessToken(env) : '';
  const sign = await hmacHex(env.TUYA_CLIENT_SECRET, env.TUYA_CLIENT_ID + token + t + stringToSign);
  const headers = { client_id: env.TUYA_CLIENT_ID, sign, t, sign_method: 'HMAC-SHA256', nonce: '' };
  if (token) headers.access_token = token;
  if (bodyText) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, body: bodyText || undefined });
  const data = await res.json();
  if (!data.success) {
    if (useToken && (data.code === 1010 || data.code === 1011)) tuyaToken = { token: null, exp: 0 }; // token expired/invalid
    throw new Error('Tuya: ' + (data.msg || 'error ' + data.code));
  }
  return data.result;
}

async function tuyaAccessToken(env) {
  if (tuyaToken.token && Date.now() < tuyaToken.exp - 60000) return tuyaToken.token;
  const r = await tuyaRequest(env, 'GET', '/v1.0/token?grant_type=1', null, false);
  tuyaToken = { token: r.access_token, exp: Date.now() + r.expire_time * 1000 };
  return tuyaToken.token;
}

async function tuyaStream(env, deviceId) {
  const r = await tuyaRequest(env, 'POST', '/v1.0/devices/' + encodeURIComponent(deviceId) + '/stream/actions/allocate', { type: 'hls' });
  return json({ url: r.url });
}

// ---------------------------------------------------------------- Ring
// Unofficial API (as used by ring-client-api / Home Assistant). The refresh
// token rotates on every use, so it is kept in KV.
const RING_OAUTH = 'https://oauth.ring.com/oauth/token';
const RING_API = 'https://api.ring.com/clients_api';
let ringAccess = { token: null, exp: 0 };

async function ringHardwareId(env) {
  let id = await env.HUB_KV.get('ring_hardware_id');
  if (!id) { id = crypto.randomUUID(); await env.HUB_KV.put('ring_hardware_id', id); }
  return id;
}

async function ringOAuth(env, body, code) {
  const res = await fetch(RING_OAUTH, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      '2fa-support': 'true',
      '2fa-code': code || '',
      hardware_id: await ringHardwareId(env),
      'User-Agent': 'android:com.ringapp',
    },
    body: JSON.stringify(Object.assign({ client_id: 'ring_official_android', scope: 'client' }, body)),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function ringLogin(env, request) {
  const b = await request.json();
  const r = await ringOAuth(env, { grant_type: 'password', username: b.email, password: b.password }, b.code);
  if (r.status === 412) {
    const where = r.data.tsv_state === 'totp' ? 'your authenticator app' : r.data.phone ? r.data.phone : 'your ' + (r.data.tsv_state || 'phone');
    return json({ needCode: true, message: 'Enter the code Ring sent to ' + where }, 200);
  }
  if (r.status !== 200 || !r.data.refresh_token) {
    return json({ error: r.data.error_description || r.data.error || 'Ring login failed (' + r.status + ')' }, 401);
  }
  await env.HUB_KV.put('ring_refresh_token', r.data.refresh_token);
  ringAccess = { token: r.data.access_token, exp: Date.now() + (r.data.expires_in || 3600) * 1000 };
  // Register this "device" with Ring (shows in Ring's Control Center as House Hub).
  await ringFetch(env, '/session', {
    method: 'POST',
    body: JSON.stringify({ device: { hardware_id: await ringHardwareId(env), metadata: { api_version: 11, device_model: 'House Hub' }, os: 'android' } }),
  }).catch(() => {});
  return json({ ok: true });
}

async function ringToken(env) {
  if (ringAccess.token && Date.now() < ringAccess.exp - 60000) return ringAccess.token;
  const refresh = await env.HUB_KV.get('ring_refresh_token');
  if (!refresh) throw new Error('Not logged in to Ring yet');
  const r = await ringOAuth(env, { grant_type: 'refresh_token', refresh_token: refresh });
  if (r.status !== 200 || !r.data.access_token) {
    throw new Error('Ring login expired – log in again in House Hub Settings');
  }
  if (r.data.refresh_token) await env.HUB_KV.put('ring_refresh_token', r.data.refresh_token);
  ringAccess = { token: r.data.access_token, exp: Date.now() + (r.data.expires_in || 3600) * 1000 };
  return ringAccess.token;
}

async function ringFetch(env, path, init = {}) {
  const url = /^https:/.test(path) ? path : RING_API + path;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: 'Bearer ' + (await ringToken(env)),
      hardware_id: await ringHardwareId(env),
      'User-Agent': 'android:com.ringapp',
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error('Ring ' + res.status);
  return res;
}

async function ringDevices(env) {
  const d = await (await ringFetch(env, '/ring_devices')).json();
  const list = [].concat(d.doorbots || [], d.authorized_doorbots || [], d.stickup_cams || []);
  const out = await Promise.all(list.map(async (x) => {
    let events = [];
    try {
      const h = await (await ringFetch(env, '/doorbots/' + x.id + '/history?limit=5')).json();
      events = (h || []).map((e) => ({ kind: e.kind, at: e.created_at }));
    } catch (e) { /* history is optional */ }
    return { id: String(x.id), name: x.description || 'Ring', battery: x.battery_life != null ? Number(x.battery_life) : null, events };
  }));
  return json({ devices: out });
}

async function ringSnapshot(env, id) {
  let res;
  try {
    res = await ringFetch(env, 'https://app-snaps.ring.com/snapshots/next/' + encodeURIComponent(id) + '?extras=force', { headers: { Accept: 'image/jpeg' } });
  } catch (e) {
    res = await ringFetch(env, '/snapshots/image/' + encodeURIComponent(id), { headers: { Accept: 'image/jpeg' } });
  }
  return new Response(res.body, { headers: { ...CORS, 'Content-Type': res.headers.get('Content-Type') || 'image/jpeg', 'Cache-Control': 'no-store' } });
}

// ---------------------------------------------------------------- Bin collection (Mijn Afvalwijzer)
// The public app key the Mijn Afvalwijzer website/app uses (also shipped in
// Home Assistant's afvalwijzer integration). Override with AFVALWIJZER_APIKEY.
const AFVAL_KEY = '5ef443e778f41c4f75c69459eea6e6ae0c2d92de729aa0fc61653815fbd6a8ca';
const AFVAL_PROVIDERS = ['mijnafvalwijzer.nl', 'afvalstoffendienstkalender.nl'];

async function afval(env, url) {
  const postcode = (url.searchParams.get('postcode') || '').replace(/\s+/g, '').toUpperCase();
  const number = (url.searchParams.get('number') || '').trim();
  const suffix = (url.searchParams.get('suffix') || '').trim();
  const provider = url.searchParams.get('provider') || AFVAL_PROVIDERS[0];
  if (!/^\d{4}[A-Z]{2}$/.test(postcode)) return json({ error: 'Postcode should look like 1234AB' }, 400);
  if (!/^\d{1,5}$/.test(number)) return json({ error: 'House number should be a number' }, 400);
  if (!/^[A-Za-z0-9-]{0,6}$/.test(suffix)) return json({ error: 'Bad house number suffix' }, 400);
  if (!AFVAL_PROVIDERS.includes(provider)) return json({ error: 'Unknown provider' }, 400);

  const today = new Date().toISOString().slice(0, 10);
  const q = new URLSearchParams({
    apikey: env.AFVALWIJZER_APIKEY || AFVAL_KEY, method: 'postcodecheck', postcode, street: '',
    huisnummer: number, toevoeging: suffix, app_name: 'afvalwijzer', platform: 'web', afvaldata: today, langs: 'nl',
  });
  const res = await fetch('https://api.' + provider + '/webservices/appsinput/?' + q, {
    headers: { 'User-Agent': 'HouseHub/2.0' },
    cf: { cacheTtl: 6 * 3600, cacheEverything: true },
  });
  if (!res.ok) throw new Error('Afvalwijzer ' + res.status);
  const data = await res.json().catch(() => null);
  if (!data || data.response === 'NOK') return json({ error: 'Afvalwijzer doesn\u2019t know this address – check the postcode and house number' }, 404);

  const seen = {};
  const pickups = [];
  [data.ophaaldagen, data.ophaaldagenNext].forEach((block) => {
    ((block && block.data) || []).forEach((d) => {
      if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d.date || '')) return;
      const key = d.date + '|' + d.type;
      if (seen[key]) return;
      seen[key] = true;
      pickups.push({ date: d.date, type: String(d.type || '').toLowerCase(), name: d.nameType || d.type || 'Afval' });
    });
  });
  pickups.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return json({ pickups });
}

// ---------------------------------------------------------------- router
// The access token comes in an Authorization header, or as ?token= for
// things the page loads as plain images (Ring snapshots).
function authorized(request, url, env) {
  const auth = request.headers.get('Authorization') || '';
  return !!env.HUB_TOKEN && (auth === 'Bearer ' + env.HUB_TOKEN || url.searchParams.get('token') === env.HUB_TOKEN);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);
    const p = url.pathname;

    if (p === '/' && url.searchParams.get('url')) return icsProxy(url.searchParams.get('url'));
    if (!/^\/(google|tuya|ring)\//.test(p) && p !== '/afval') return new Response('House Hub worker is running.', { headers: CORS });
    if (!env.HUB_TOKEN) return json({ error: 'HUB_TOKEN is not set on the worker' }, 501);
    if (!authorized(request, url, env)) return json({ error: 'wrong access token' }, 401);

    try {
      if (p.startsWith('/google/')) {
        if (!env.GOOGLE_SERVICE_ACCOUNT) return json({ error: 'Google sync is not set up on the worker' }, 501);
        if (p === '/google/events' && request.method === 'GET') return await listEvents(env, url);
        if (p === '/google/events' && request.method === 'POST') return await createEvent(env, request);
        const m = /^\/google\/events\/([^/]+)\/([^/]+)$/.exec(p);
        if (m && request.method === 'DELETE') return await deleteEvent(env, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
        if (m && request.method === 'PATCH') return await updateEvent(env, request, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
      }
      if (p.startsWith('/tuya/')) {
        if (!env.TUYA_CLIENT_ID || !env.TUYA_CLIENT_SECRET) return json({ error: 'Tuya is not set up on the worker' }, 501);
        const m = /^\/tuya\/stream\/([^/]+)$/.exec(p);
        if (m && request.method === 'GET') return await tuyaStream(env, decodeURIComponent(m[1]));
      }
      if (p === '/afval' && request.method === 'GET') return await afval(env, url);
      if (p.startsWith('/ring/')) {
        if (!env.HUB_KV) return json({ error: 'Ring needs the HUB_KV binding on the worker' }, 501);
        if (p === '/ring/login' && request.method === 'POST') return await ringLogin(env, request);
        if (p === '/ring/devices' && request.method === 'GET') return await ringDevices(env);
        const m = /^\/ring\/snapshot\/([^/]+)$/.exec(p);
        if (m && request.method === 'GET') return await ringSnapshot(env, decodeURIComponent(m[1]));
      }
    } catch (e) {
      return json({ error: e.message }, 502);
    }
    return json({ error: 'not found' }, 404);
  },
};
