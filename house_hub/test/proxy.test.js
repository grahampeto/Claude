'use strict';
var test = require('node:test');
var assert = require('node:assert');

test('CORS proxy only forwards calendar hosts', async function () {
  var worker = (await import('../cors-proxy.worker.js')).default;
  var realFetch = global.fetch, seen = null;
  global.fetch = async function (u) { seen = u; return new Response('BEGIN:VCALENDAR'); };
  try {
    var ok = await worker.fetch(new Request('https://w.dev/?url=' + encodeURIComponent('webcal://p52-caldav.icloud.com/published/2/abc')));
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.headers.get('access-control-allow-origin'), '*');
    assert.strictEqual(seen, 'https://p52-caldav.icloud.com/published/2/abc');
    var bad = await worker.fetch(new Request('https://w.dev/?url=' + encodeURIComponent('https://evil.example.com/x')));
    assert.strictEqual(bad.status, 403);
    var sneaky = await worker.fetch(new Request('https://w.dev/?url=' + encodeURIComponent('https://calendar.google.com.evil.com/x')));
    assert.strictEqual(sneaky.status, 403);
  } finally { global.fetch = realFetch; }
});
