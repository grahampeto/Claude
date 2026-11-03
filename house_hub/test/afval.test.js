'use strict';
var test = require('node:test');
var assert = require('node:assert');

test('afval: fetches, merges, de-duplicates and sorts pickups', async function () {
  var worker = (await import('../house-hub.worker.js')).default;
  var real = global.fetch, seenUrl = null;
  global.fetch = async function (u) {
    seenUrl = new URL(String(u));
    if (seenUrl.searchParams.get('postcode') === '9999ZZ') return Response.json({ response: 'NOK' });
    return Response.json({
      response: 'OK',
      ophaaldagen: { data: [
        { nameType: 'gft', type: 'gft', date: '2026-11-04' },
        { nameType: 'restafval', type: 'restafval', date: '2026-11-11' },
        { nameType: 'papier', type: 'papier', date: 'geen' }
      ] },
      ophaaldagenNext: { data: [{ nameType: 'gft', type: 'gft', date: '2026-11-04' }, { nameType: 'pmd', type: 'pmd', date: '2026-11-06' }] }
    });
  };
  try {
    var env = { HUB_TOKEN: 't' };
    var r = await worker.fetch(new Request('https://w.dev/afval?postcode=1234%20ab&number=12&suffix=A', { headers: { Authorization: 'Bearer t' } }), env);
    var j = await r.json();
    assert.strictEqual(r.status, 200, JSON.stringify(j));
    assert.deepStrictEqual(j.pickups.map(function (p) { return p.date + ' ' + p.type; }), ['2026-11-04 gft', '2026-11-06 pmd', '2026-11-11 restafval']);
    assert.strictEqual(seenUrl.hostname, 'api.mijnafvalwijzer.nl');
    assert.strictEqual(seenUrl.searchParams.get('postcode'), '1234AB');
    assert.strictEqual(seenUrl.searchParams.get('huisnummer'), '12');
    assert.strictEqual(seenUrl.searchParams.get('toevoeging'), 'A');

    var bad = await worker.fetch(new Request('https://w.dev/afval?postcode=12&number=1', { headers: { Authorization: 'Bearer t' } }), env);
    assert.strictEqual(bad.status, 400);
    var unknown = await worker.fetch(new Request('https://w.dev/afval?postcode=9999ZZ&number=1', { headers: { Authorization: 'Bearer t' } }), env);
    assert.strictEqual(unknown.status, 404);
    var evil = await worker.fetch(new Request('https://w.dev/afval?postcode=1234AB&number=1&provider=evil.com', { headers: { Authorization: 'Bearer t' } }), env);
    assert.strictEqual(evil.status, 400);
    var noauth = await worker.fetch(new Request('https://w.dev/afval?postcode=1234AB&number=1'), env);
    assert.strictEqual(noauth.status, 401);
  } finally { global.fetch = real; }
});
