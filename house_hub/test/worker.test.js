'use strict';
var test = require('node:test');
var assert = require('node:assert');
var crypto = require('node:crypto');

async function setup() {
  var worker = (await import('../house-hub.worker.js')).default;
  var kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  var env = {
    HUB_TOKEN: 'secret-token',
    GOOGLE_CALENDAR_IDS: 'family@group.calendar.google.com, me@gmail.com',
    GOOGLE_SERVICE_ACCOUNT: JSON.stringify({
      client_email: 'hub@proj.iam.gserviceaccount.com',
      private_key: kp.privateKey.export({ type: 'pkcs8', format: 'pem' })
    })
  };
  var calls = [];
  global.fetch = async function (u, init) {
    init = init || {};
    calls.push({ url: String(u), init: init });
    u = String(u);
    if (u === 'https://oauth2.googleapis.com/token') {
      var assertion = new URLSearchParams(init.body).get('assertion').split('.');
      var ok = crypto.verify('RSA-SHA256', Buffer.from(assertion[0] + '.' + assertion[1]), kp.publicKey, Buffer.from(assertion[2], 'base64url'));
      assert.ok(ok, 'JWT signature must verify');
      var claims = JSON.parse(Buffer.from(assertion[1], 'base64url'));
      assert.strictEqual(claims.iss, 'hub@proj.iam.gserviceaccount.com');
      return Response.json({ access_token: 'gtoken', expires_in: 3600 });
    }
    assert.strictEqual(init.headers.Authorization, 'Bearer gtoken');
    if (/\/events\?/.test(u)) {
      return Response.json({ items: [
        { id: 'e1', summary: 'Dentist', start: { dateTime: '2026-11-05T09:30:00Z' }, end: { dateTime: '2026-11-05T10:00:00Z' } },
        { id: 'e2', summary: 'Bin day', start: { date: '2026-11-03' }, end: { date: '2026-11-04' }, extendedProperties: { private: { houseHubWho: 'graham' } } },
        { id: 'e3', status: 'cancelled', start: { date: '2026-11-03' }, end: { date: '2026-11-04' } }
      ] });
    }
    if (init.method === 'POST') {
      var b = JSON.parse(init.body);
      return Response.json(Object.assign({ id: 'new1' }, b));
    }
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    if (init.method === 'PATCH') return Response.json(Object.assign({ id: 'e1' }, JSON.parse(init.body)));
    return Response.json({ summary: u.indexOf('family') >= 0 ? 'Family' : 'Me' });
  };
  return { worker: worker, env: env, calls: calls };
}

function req(path, init) {
  init = init || {};
  init.headers = Object.assign({ Authorization: 'Bearer secret-token' }, init.headers || {});
  return new Request('https://w.dev' + path, init);
}

test('worker: Google list / create / delete and auth', async function () {
  var realFetch = global.fetch;
  try {
    var s = await setup();
    var bad = await s.worker.fetch(new Request('https://w.dev/google/events?from=a&to=b', { headers: { Authorization: 'Bearer nope' } }), s.env);
    assert.strictEqual(bad.status, 401);

    var res = await s.worker.fetch(req('/google/events?from=2026-11-01T00:00:00Z&to=2026-12-01T00:00:00Z'), s.env);
    var data = await res.json();
    assert.strictEqual(res.status, 200, JSON.stringify(data));
    assert.deepStrictEqual(data.calendars.map(function (c) { return c.name; }), ['Family', 'Me']);
    assert.strictEqual(data.events.length, 4); // 2 per calendar, cancelled dropped
    var bin = data.events.filter(function (e) { return e.title === 'Bin day'; })[0];
    assert.strictEqual(bin.allDay, true);
    assert.strictEqual(bin.start, '2026-11-03');
    assert.strictEqual(bin.who, 'graham');

    var c = await s.worker.fetch(req('/google/events', { method: 'POST', body: JSON.stringify({ title: 'Dinner', start: '2026-11-06T19:00:00+00:00', end: '2026-11-06T20:00:00+00:00', who: 'jess' }) }), s.env);
    var created = await c.json();
    assert.strictEqual(created.id, 'new1');
    var post = s.calls.filter(function (x) { return x.init.method === 'POST' && x.url.indexOf('/events') > 0; })[0];
    assert.ok(post.url.indexOf(encodeURIComponent('family@group.calendar.google.com')) > 0, 'defaults to first calendar');
    assert.strictEqual(JSON.parse(post.init.body).colorId, '4');

    // Edit: rename, switch to all-day, pick a colour.
    var e = await s.worker.fetch(req('/google/events/' + encodeURIComponent('me@gmail.com') + '/e1', { method: 'PATCH', body: JSON.stringify({ title: 'Dentist (moved)', allDay: true, start: '2026-11-07', end: '2026-11-08', who: 'graham', colorId: '11' }) }), s.env);
    assert.strictEqual(e.status, 200);
    var patch = s.calls.filter(function (x) { return x.init.method === 'PATCH'; })[0];
    var pb = JSON.parse(patch.init.body);
    assert.ok(/\/calendars\/me%40gmail\.com\/events\/e1$/.test(patch.url), patch.url);
    assert.deepStrictEqual(pb.start, { date: '2026-11-07', dateTime: null });
    assert.strictEqual(pb.colorId, '11');
    assert.strictEqual(pb.summary, 'Dentist (moved)');
    assert.strictEqual(pb.extendedProperties.private.houseHubWho, 'graham');
    // "Auto" colour falls back to the who-colour; new events don't send nulls.
    await s.worker.fetch(req('/google/events/' + encodeURIComponent('me@gmail.com') + '/e1', { method: 'PATCH', body: JSON.stringify({ title: 'x', allDay: false, start: '2026-11-07T10:00:00+01:00', end: '2026-11-07T11:00:00+01:00', who: 'jess', colorId: '' }) }), s.env);
    var pb2 = JSON.parse(s.calls.filter(function (x) { return x.init.method === 'PATCH'; })[1].init.body);
    assert.strictEqual(pb2.colorId, '4');
    assert.deepStrictEqual(pb2.start, { dateTime: '2026-11-07T10:00:00+01:00', date: null });
    assert.strictEqual(JSON.parse(post.init.body).start.date, undefined);

    var d = await s.worker.fetch(req('/google/events/' + encodeURIComponent('me@gmail.com') + '/e1', { method: 'DELETE' }), s.env);
    assert.strictEqual(d.status, 200);
    var d2 = await s.worker.fetch(req('/google/events/' + encodeURIComponent('evil@gmail.com') + '/e1', { method: 'DELETE' }), s.env);
    assert.strictEqual(d2.status, 404);

    // Only one token request despite many calls (cached).
    assert.strictEqual(s.calls.filter(function (x) { return x.url.indexOf('oauth2') > 0; }).length, 1);
  } finally { global.fetch = realFetch; }
});

test('worker: ICS proxy only forwards calendar hosts', async function () {
  var realFetch = global.fetch, seen = null;
  global.fetch = async function (u) { seen = String(u); return new Response('BEGIN:VCALENDAR'); };
  try {
    var worker = (await import('../house-hub.worker.js')).default;
    var ok = await worker.fetch(new Request('https://w.dev/?url=' + encodeURIComponent('webcal://p52-caldav.icloud.com/published/2/abc')), {});
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(seen, 'https://p52-caldav.icloud.com/published/2/abc');
    var bad = await worker.fetch(new Request('https://w.dev/?url=' + encodeURIComponent('https://calendar.google.com.evil.com/x')), {});
    assert.strictEqual(bad.status, 403);
  } finally { global.fetch = realFetch; }
});
