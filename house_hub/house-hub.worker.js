// House Hub helper – a free Cloudflare Worker. Two jobs:
//
//  1. Calendar feed proxy:   GET /?url=<ics url>
//     Lets the browser read Google / iCloud / Outlook .ics feeds (they don't
//     send CORS headers). Only calendar hosts are allowed.
//
//  2. Google Calendar sync:  /google/...   (needs the secrets below)
//     Reads events from your Google calendars and creates / deletes events,
//     using a Google service account that you share your calendars with.
//     No sign-in on the iPad, nothing that expires.
//
// Secrets / variables (Worker → Settings → Variables and Secrets):
//   HUB_TOKEN                  any long random string; also typed into House Hub Settings
//   GOOGLE_SERVICE_ACCOUNT     the whole service-account JSON key file (as a Secret)
//   GOOGLE_CALENDAR_IDS        comma-separated calendar IDs, e.g.
//                              you@gmail.com,family123@group.calendar.google.com
//                              (the first one is where new events go by default)
// See house_hub/README.md for step-by-step setup.

const ICS_HOSTS = ['calendar.google.com', 'outlook.office365.com', 'outlook.live.com'];
const ICS_SUFFIXES = ['.icloud.com'];
const GCAL = 'https://www.googleapis.com/calendar/v3';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
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

async function fetchToken(env) {
  const sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT);
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const now = Math.floor(Date.now() / 1000);
  const unsigned = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' + b64url(JSON.stringify({
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
  if (!res.ok) throw new Error('Google sign-in failed: ' + (data.error_description || data.error || res.status));
  tokenCache = { token: data.access_token, exp: Date.now() + data.expires_in * 1000 };
  return tokenCache.token;
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
  const allDay = !!(ev.start && ev.start.date);
  const priv = (ev.extendedProperties && ev.extendedProperties.private) || {};
  return {
    id: ev.id,
    calendarId: cal.id,
    calendar: cal.name,
    title: ev.summary || '(no title)',
    location: ev.location || '',
    allDay,
    // All-day dates are passed through as YYYY-MM-DD so the device can read them in local time.
    start: allDay ? ev.start.date : ev.start.dateTime,
    end: allDay ? ev.end.date : ev.end.dateTime,
    who: priv.houseHubWho || '',
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
  if (WHO_COLOR[b.who]) body.colorId = WHO_COLOR[b.who];
  if (b.allDay) {
    body.start = { date: b.start };
    body.end = { date: b.end || b.start };
  } else {
    body.start = { dateTime: b.start };
    body.end = { dateTime: b.end || b.start };
  }
  const ev = await gcal(env, '/calendars/' + encodeURIComponent(calId) + '/events', { method: 'POST', body: JSON.stringify(body) });
  return json(simplify(ev, { id: calId, name: '' }));
}

async function deleteEvent(env, calId, eventId) {
  if (!calendarIds(env).includes(calId)) return json({ error: 'unknown calendar' }, 404);
  await gcal(env, '/calendars/' + encodeURIComponent(calId) + '/events/' + encodeURIComponent(eventId), { method: 'DELETE' });
  return json({ ok: true });
}

// ---------------------------------------------------------------- router
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(request.url);

    if (url.pathname === '/' && url.searchParams.get('url')) return icsProxy(url.searchParams.get('url'));

    if (url.pathname.startsWith('/google/')) {
      if (!env.HUB_TOKEN || !env.GOOGLE_SERVICE_ACCOUNT) return json({ error: 'Google sync is not set up on the worker' }, 501);
      const auth = request.headers.get('Authorization') || '';
      if (auth !== 'Bearer ' + env.HUB_TOKEN) return json({ error: 'wrong access token' }, 401);
      try {
        if (url.pathname === '/google/events' && request.method === 'GET') return await listEvents(env, url);
        if (url.pathname === '/google/events' && request.method === 'POST') return await createEvent(env, request);
        const m = /^\/google\/events\/([^/]+)\/([^/]+)$/.exec(url.pathname);
        if (m && request.method === 'DELETE') return await deleteEvent(env, decodeURIComponent(m[1]), decodeURIComponent(m[2]));
      } catch (e) {
        return json({ error: e.message }, 502);
      }
      return json({ error: 'not found' }, 404);
    }
    return new Response('House Hub worker is running.', { headers: CORS });
  },
};
