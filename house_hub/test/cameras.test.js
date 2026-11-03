'use strict';
var test = require('node:test');
var assert = require('node:assert');
var crypto = require('node:crypto');

function kv() {
  var m = {};
  return { get: async function (k) { return k in m ? m[k] : null; }, put: async function (k, v) { m[k] = v; }, _m: m };
}
function req(path, init) {
  init = init || {};
  init.headers = Object.assign({ Authorization: 'Bearer tok' }, init.headers || {});
  return new Request('https://w.dev' + path, init);
}

test('Tuya: signed token + stream allocation', async function () {
  var worker = (await import('../house-hub.worker.js')).default;
  var env = { HUB_TOKEN: 'tok', TUYA_CLIENT_ID: 'cid', TUYA_CLIENT_SECRET: 'secret' };
  var real = global.fetch, calls = [];
  global.fetch = async function (u, init) {
    u = String(u); init = init || {};
    var h = init.headers, path = u.replace('https://openapi.tuyaeu.com', '');
    calls.push(path);
    // Independently recompute the signature from Tuya's documented algorithm.
    var bodyHash = crypto.createHash('sha256').update(init.body || '').digest('hex');
    var sts = [init.method || 'GET', bodyHash, '', path].join('\n');
    var expect = crypto.createHmac('sha256', 'secret').update('cid' + (h.access_token || '') + h.t + '' + sts).digest('hex').toUpperCase();
    assert.strictEqual(h.sign, expect, 'signature for ' + path);
    assert.strictEqual(h.sign_method, 'HMAC-SHA256');
    if (path === '/v1.0/token?grant_type=1') return Response.json({ success: true, result: { access_token: 'tt', expire_time: 7200 } });
    assert.strictEqual(h.access_token, 'tt');
    assert.deepStrictEqual(JSON.parse(init.body), { type: 'hls' });
    return Response.json({ success: true, result: { url: 'https://hls.tuyaeu.com/live/abc.m3u8' } });
  };
  try {
    var r = await worker.fetch(req('/tuya/stream/bf123'), env);
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await r.json()).url, 'https://hls.tuyaeu.com/live/abc.m3u8');
    await worker.fetch(req('/tuya/stream/bf123'), env);
    assert.deepStrictEqual(calls, ['/v1.0/token?grant_type=1', '/v1.0/devices/bf123/stream/actions/allocate', '/v1.0/devices/bf123/stream/actions/allocate']);
    var none = await worker.fetch(req('/tuya/stream/x'), { HUB_TOKEN: 'tok' });
    assert.strictEqual(none.status, 501);
  } finally { global.fetch = real; }
});

test('Ring: 2FA login, rotating refresh token, devices, snapshot fallback, ?token= auth', async function () {
  var worker = (await import('../house-hub.worker.js')).default;
  var env = { HUB_TOKEN: 'tok', HUB_KV: kv() };
  var real = global.fetch, refreshSeen = [];
  global.fetch = async function (u, init) {
    u = String(u); init = init || {};
    if (u === 'https://oauth.ring.com/oauth/token') {
      var b = JSON.parse(init.body);
      assert.ok(init.headers.hardware_id, 'hardware id sent');
      if (b.grant_type === 'password') {
        if (!init.headers['2fa-code']) return Response.json({ tsv_state: 'sms', phone: '+31******12' }, { status: 412 });
        assert.strictEqual(init.headers['2fa-code'], '123456');
        return Response.json({ access_token: 'a1', refresh_token: 'r1', expires_in: 1 }); // expires immediately -> forces refresh
      }
      refreshSeen.push(b.refresh_token);
      var n = refreshSeen.length;
      return Response.json({ access_token: 'a' + (n + 1), refresh_token: 'r' + (n + 1), expires_in: 3600 });
    }
    if (u.endsWith('/session')) return Response.json({});
    if (u.endsWith('/ring_devices')) return Response.json({ doorbots: [{ id: 42, description: 'Front Door', battery_life: '87' }], stickup_cams: [] });
    if (u.indexOf('/doorbots/42/history') > 0) return Response.json([{ kind: 'ding', created_at: '2026-11-02T14:05:00Z' }]);
    if (u.indexOf('app-snaps.ring.com') > 0) return new Response('nope', { status: 404 });
    if (u.indexOf('/snapshots/image/42') > 0) return new Response('JPEGDATA', { headers: { 'Content-Type': 'image/jpeg' } });
    throw new Error('unexpected ' + u);
  };
  try {
    var r1 = await worker.fetch(req('/ring/login', { method: 'POST', body: JSON.stringify({ email: 'g@x.com', password: 'pw' }) }), env);
    var j1 = await r1.json();
    assert.ok(j1.needCode && /\+31/.test(j1.message), JSON.stringify(j1));
    var r2 = await worker.fetch(req('/ring/login', { method: 'POST', body: JSON.stringify({ email: 'g@x.com', password: 'pw', code: '123456' }) }), env);
    assert.deepStrictEqual(await r2.json(), { ok: true });
    // The login token expired at once, so registering the session already
    // used (and rotated) the refresh token.
    assert.deepStrictEqual(refreshSeen, ['r1']);
    assert.strictEqual(env.HUB_KV._m.ring_refresh_token, 'r2', 'rotated refresh token is saved');

    var d = await (await worker.fetch(req('/ring/devices'), env)).json();
    assert.deepStrictEqual(d.devices, [{ id: '42', name: 'Front Door', battery: 87, events: [{ kind: 'ding', at: '2026-11-02T14:05:00Z' }] }]);
    assert.deepStrictEqual(refreshSeen, ['r1'], 'new access token is cached, no extra refresh');

    var snap = await worker.fetch(new Request('https://w.dev/ring/snapshot/42?token=tok'), env);
    assert.strictEqual(snap.status, 200);
    assert.strictEqual(await snap.text(), 'JPEGDATA');
    var bad = await worker.fetch(new Request('https://w.dev/ring/snapshot/42?token=wrong'), env);
    assert.strictEqual(bad.status, 401);
  } finally { global.fetch = real; }
});

test('Ring live view: offer goes to Ring, answer comes back, end closes it', async function () {
  var worker = (await import('../house-hub.worker.js?live')).default;
  var env = { HUB_TOKEN: 'tok', HUB_KV: kv() };
  await env.HUB_KV.put('ring_refresh_token', 'r0');
  var real = global.fetch, calls = [];
  global.fetch = async function (u, init) {
    u = String(u); init = init || {};
    if (u === 'https://oauth.ring.com/oauth/token') return Response.json({ access_token: 'a', refresh_token: 'r1', expires_in: 3600 });
    calls.push({ u: u, body: init.body ? JSON.parse(init.body) : null, auth: init.headers.Authorization });
    if (u.endsWith('/liveview/start')) return Response.json({ sdp: 'v=0\r\nanswer' });
    if (u.endsWith('/liveview/end')) return new Response(null, { status: 204 });
    throw new Error('unexpected ' + u);
  };
  try {
    var r = await worker.fetch(req('/ring/live/start', { method: 'POST', body: JSON.stringify({ deviceId: '42', sdp: 'v=0\r\noffer' }) }), env);
    var j = await r.json();
    assert.strictEqual(r.status, 200, JSON.stringify(j));
    assert.strictEqual(j.sdp, 'v=0\r\nanswer');
    assert.ok(/^[0-9a-f-]{36}$/.test(j.sessionId));
    assert.deepStrictEqual(calls[0].body, { session_id: j.sessionId, device_id: 42, sdp: 'v=0\r\noffer', protocol: 'webrtc' });
    assert.strictEqual(calls[0].auth, 'Bearer a');
    var e = await worker.fetch(req('/ring/live/end', { method: 'POST', body: JSON.stringify({ sessionId: j.sessionId }) }), env);
    assert.strictEqual(e.status, 200);
    assert.deepStrictEqual(calls[1].body, { session_id: j.sessionId });
    var bad = await worker.fetch(req('/ring/live/start', { method: 'POST', body: JSON.stringify({ deviceId: 'x', sdp: 'v=0' }) }), env);
    assert.strictEqual(bad.status, 400);
  } finally { global.fetch = real; }
});

test('Ring talk: switches the doorbell speaker on (tries PATCH, then PUT)', async function () {
  var worker = (await import('../house-hub.worker.js?talk')).default;
  var env = { HUB_TOKEN: 'tok', HUB_KV: kv() };
  await env.HUB_KV.put('ring_refresh_token', 'r0');
  var real = global.fetch, calls = [];
  global.fetch = async function (u, init) {
    u = String(u); init = init || {};
    if (u === 'https://oauth.ring.com/oauth/token') return Response.json({ access_token: 'a', refresh_token: 'r1', expires_in: 3600 });
    calls.push(init.method + ' ' + u.split('/').pop() + ' ' + init.body);
    if (init.method === 'PATCH') return new Response('', { status: 405 });
    return new Response(null, { status: 204 });
  };
  try {
    var r = await worker.fetch(req('/ring/live/speaker', { method: 'POST', body: JSON.stringify({ sessionId: 's1' }) }), env);
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(calls, [
      'PATCH options {"session_id":"s1","actions":["turn_off_stealth_mode"]}',
      'PUT options {"session_id":"s1","actions":["turn_off_stealth_mode"]}'
    ]);
  } finally { global.fetch = real; }
});
