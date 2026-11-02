'use strict';
var test = require('node:test');
var assert = require('node:assert');
var crypto = require('node:crypto');

// Fresh copy of the worker per scenario (it caches tokens in module scope).
var n = 0;
async function freshWorker() { return (await import('../house-hub.worker.js?v=' + (n++))).default; }

function sa(kp, id) {
  return JSON.stringify({ client_email: 'hub@p.iam.gserviceaccount.com', private_key_id: id, private_key: kp.privateKey.export({ type: 'pkcs8', format: 'pem' }) });
}
function jwk(kp, kid) { var j = kp.publicKey.export({ format: 'jwk' }); j.kid = kid; return j; }

async function run(envSa, published) {
  var worker = await freshWorker();
  var real = global.fetch;
  global.fetch = async function (u) {
    u = String(u);
    if (u === 'https://oauth2.googleapis.com/token') return Response.json({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }, { status: 400 });
    if (u.indexOf('/service_accounts/v1/jwk/') > 0) return Response.json({ keys: published });
    throw new Error('unexpected ' + u);
  };
  try {
    var env = { HUB_TOKEN: 't', GOOGLE_SERVICE_ACCOUNT: envSa, GOOGLE_CALENDAR_IDS: 'me@gmail.com' };
    var r = await worker.fetch(new Request('https://w.dev/google/events?from=a&to=b', { headers: { Authorization: 'Bearer t' } }), env);
    return (await r.json()).errors.join(' ');
  } finally { global.fetch = real; }
}

test('explains a deleted / too-new key', async function () {
  var kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  var msg = await run(sa(kp, 'abc12345xyz'), []);
  assert.match(msg, /doesn.t have this key \(key abc12345…\)/);
});

test('explains a private key that does not match the published key', async function () {
  var kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  var other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  var msg = await run(sa(kp, 'k1'), [jwk(other, 'k1')]);
  assert.match(msg, /doesn.t match key/);
});

test('says a matching key is fine (just wait)', async function () {
  var kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  var msg = await run(sa(kp, 'k1'), [jwk(kp, 'k1')]);
  assert.match(msg, /checks out/);
});

test('explains broken JSON and literal \\n in the key', async function () {
  assert.match(await run('{"client_email": "x", "private_key": "abc', []), /isn.t valid JSON/);
  var kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  var escaped = JSON.parse(sa(kp, 'k1'));
  escaped.private_key = escaped.private_key.replace(/\n/g, '\\n'); // double-escaped paste
  var msg = await run(JSON.stringify(escaped), [jwk(kp, 'k1')]);
  assert.match(msg, /checks out/, 'literal \\n is tolerated and signs correctly');
});
