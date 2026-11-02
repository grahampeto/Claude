'use strict';
// House Hub server: serves the iPad app, stores shared household data and
// proxies calendar (.ics) feeds. No dependencies – just `node server.js`.

var http = require('http');
var https = require('https');
var fs = require('fs');
var path = require('path');
var url = require('url');
var ics = require('./lib/ics');

var ROOT = __dirname;
var PUBLIC = path.join(ROOT, 'public');
var DATA_DIR = process.env.HOUSE_HUB_DATA || path.join(ROOT, 'data');
var STATE_FILE = path.join(DATA_DIR, 'state.json');
var CONFIG_FILE = fs.existsSync(path.join(ROOT, 'config.json'))
  ? path.join(ROOT, 'config.json') : path.join(ROOT, 'config.example.json');

// Keys of the shared state, each saved independently so two devices editing
// different lists never overwrite each other.
var STATE_KEYS = ['events', 'groceries', 'todos', 'checklists', 'notes'];

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch (e) { console.error('Could not read ' + CONFIG_FILE + ': ' + e.message); return {}; }
}
var config = loadConfig();

function items(list) {
  return list.map(function (text, i) { return { id: 'd' + i, text: text }; });
}

function defaultState() {
  return {
    rev: 1,
    events: [],
    groceries: { items: [], history: {} },
    todos: [],
    notes: [],
    checklists: {
      jess: { items: items(['Make bed', 'Take vitamins', 'Drink 2L water']), done: {} },
      graham: { items: items(['Make bed', 'Take vitamins', 'Drink 2L water']), done: {} },
      both: { items: items(['Unload dishwasher', 'Put bins out (if bin day)', 'Lock up & alarm on']), done: {} }
    }
  };
}

var state;
try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
catch (e) { state = defaultState(); }

var saveTimer = null;
function saveState() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(function () {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    var tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1));
    fs.renameSync(tmp, STATE_FILE);
  }, 200);
}

function send(res, code, body, type) {
  var data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(data);
}

function readBody(req, cb) {
  var chunks = [], size = 0;
  req.on('data', function (c) {
    size += c.length;
    if (size > 2e6) { req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', function () {
    try { cb(null, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
    catch (e) { cb(e); }
  });
}

// ---- Calendar feeds -------------------------------------------------------
var calCache = { at: 0, events: [], errors: [] };

function fetchText(target, redirects, cb) {
  var mod = target.indexOf('https:') === 0 ? https : http;
  var req = mod.get(target, { headers: { 'User-Agent': 'HouseHub/1.0' }, timeout: 15000 }, function (res) {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
      res.resume();
      return fetchText(url.resolve(target, res.headers.location), redirects + 1, cb);
    }
    if (res.statusCode !== 200) { res.resume(); return cb(new Error('HTTP ' + res.statusCode)); }
    var chunks = [];
    res.on('data', function (c) { chunks.push(c); });
    res.on('end', function () { cb(null, Buffer.concat(chunks).toString('utf8')); });
  });
  req.on('timeout', function () { req.destroy(new Error('timeout')); });
  req.on('error', cb);
}

function getCalendarEvents(cb) {
  var feeds = (config.calendars || []).filter(function (f) { return f.url; });
  var ttl = (config.calendarRefreshMinutes || 10) * 60000;
  if (Date.now() - calCache.at < ttl) return cb(calCache);
  if (!feeds.length) return cb({ events: [], errors: [] });

  var now = new Date();
  var from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  var to = new Date(now.getFullYear(), now.getMonth() + 4, 1);
  var all = [], errors = [], pending = feeds.length;
  feeds.forEach(function (feed) {
    var u = feed.url.replace(/^webcal:/, 'https:');
    fetchText(u, 0, function (err, text) {
      if (err) errors.push((feed.name || u) + ': ' + err.message);
      else {
        ics.expand(ics.parse(text), from, to).forEach(function (ev) {
          ev.calendar = feed.name || '';
          ev.color = feed.color || '';
          all.push(ev);
        });
      }
      if (--pending === 0) {
        all.sort(function (a, b) { return a.start < b.start ? -1 : 1; });
        calCache = { at: errors.length ? 0 : Date.now(), events: all, errors: errors };
        cb(calCache);
      }
    });
  });
}

// ---- Camera snapshot proxy (avoids mixed-content / CORS / auth in URL) -----
function proxyCamera(cam, res) {
  var target = cam.snapshotUrl || cam.url;
  var mod = target.indexOf('https:') === 0 ? https : http;
  var req = mod.get(target, { timeout: 10000 }, function (up) {
    res.writeHead(up.statusCode, {
      'Content-Type': up.headers['content-type'] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    up.pipe(res);
    res.on('close', function () { up.destroy(); });
  });
  req.on('timeout', function () { req.destroy(new Error('timeout')); });
  req.on('error', function (e) { if (!res.headersSent) send(res, 502, { error: e.message }); });
}

// ---- Static files -----------------------------------------------------------
var TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json'
};

function serveStatic(pathname, res) {
  var file = path.normalize(path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
  if (file.indexOf(PUBLIC) !== 0) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(file, function (err, data) {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, data, TYPES[path.extname(file)] || 'application/octet-stream');
  });
}

// ---- Router ---------------------------------------------------------------
var server = http.createServer(function (req, res) {
  var parsed = url.parse(req.url, true);
  var p = parsed.pathname;

  if (p === '/api/state' && req.method === 'GET') {
    var since = parseInt(parsed.query.since || '0', 10);
    if (since && since === state.rev) return send(res, 200, { rev: state.rev, unchanged: true });
    return send(res, 200, state);
  }

  var m = /^\/api\/state\/([a-z]+)$/.exec(p);
  if (m && req.method === 'PUT') {
    if (STATE_KEYS.indexOf(m[1]) < 0) return send(res, 404, { error: 'unknown key' });
    return readBody(req, function (err, body) {
      if (err || !body || !('value' in body)) return send(res, 400, { error: 'bad body' });
      state[m[1]] = body.value;
      state.rev++;
      saveState();
      send(res, 200, { rev: state.rev });
    });
  }

  if (p === '/api/config' && req.method === 'GET') {
    // Only expose what the client needs; camera URLs pointing at go2rtc etc.
    return send(res, 200, {
      title: config.title || 'Our Home',
      people: config.people || ['Jess', 'Graham'],
      cameras: (config.cameras || []).map(function (c, i) {
        return {
          id: i, name: c.name, type: c.type || 'mjpeg',
          url: c.type === 'snapshot' ? '/api/camera/' + i : c.url,
          refreshSeconds: c.refreshSeconds || 2
        };
      })
    });
  }

  var cm = /^\/api\/camera\/(\d+)$/.exec(p);
  if (cm && req.method === 'GET') {
    var cam = (config.cameras || [])[+cm[1]];
    if (!cam) return send(res, 404, { error: 'no camera' });
    return proxyCamera(cam, res);
  }

  if (p === '/api/calendar' && req.method === 'GET') {
    return getCalendarEvents(function (data) { send(res, 200, { events: data.events, errors: data.errors }); });
  }

  if (req.method === 'GET') return serveStatic(decodeURIComponent(p), res);
  send(res, 405, { error: 'method not allowed' });
});

var PORT = process.env.PORT || config.port || 8080;
if (require.main === module) {
  server.listen(PORT, function () {
    console.log('House Hub running on http://0.0.0.0:' + PORT + '  (config: ' + path.basename(CONFIG_FILE) + ')');
  });
}
module.exports = server;
