// Optional Cloudflare Worker that lets the browser read Google / iCloud /
// Outlook calendar feeds (they don't send CORS headers). Free tier is plenty.
// Deploy: dash.cloudflare.com → Workers & Pages → Create → "Hello World" →
// Edit code → paste this file → Deploy. Then in House Hub Settings set the
// CORS proxy to:  https://<your-worker>.workers.dev/?url=
//
// Only calendar hosts are allowed, so it can't be abused as an open proxy.
const ALLOWED_HOSTS = [
  'calendar.google.com',
  'outlook.office365.com',
  'outlook.live.com',
];
const ALLOWED_SUFFIXES = ['.icloud.com']; // pXX-caldav.icloud.com etc.

export default {
  async fetch(request) {
    const cors = { 'Access-Control-Allow-Origin': '*' };
    const target = new URL(request.url).searchParams.get('url');
    if (!target) return new Response('missing ?url=', { status: 400, headers: cors });

    let u;
    try { u = new URL(target.replace(/^webcal:/i, 'https:')); } catch (e) {
      return new Response('bad url', { status: 400, headers: cors });
    }
    const ok = u.protocol === 'https:' && (ALLOWED_HOSTS.includes(u.hostname) ||
      ALLOWED_SUFFIXES.some((s) => u.hostname.endsWith(s)));
    if (!ok) return new Response('host not allowed', { status: 403, headers: cors });

    const res = await fetch(u.toString(), { headers: { 'User-Agent': 'HouseHub/2.0' }, cf: { cacheTtl: 300 } });
    return new Response(res.body, {
      status: res.status,
      headers: { ...cors, 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'max-age=300' },
    });
  },
};
