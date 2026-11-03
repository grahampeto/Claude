/* House Hub – iPad home dashboard.
 * Deliberately ES5 (no arrow functions, let/const, template strings, fetch or
 * Promise) so it runs on old iPads stuck on iOS 9–12. */
(function () {
  'use strict';

  // ------------------------------------------------------------------ utils
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function dayKey(d) { d = d || new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function parseDay(k) { var p = k.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
  function fmtTime(d) { return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function fmtDayLong(d) { return DAYS[d.getDay()] + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()]; }
  function fmtDayShort(k) {
    var d = parseDay(k), today = new Date();
    var diff = Math.round((d - parseDay(dayKey(today))) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    if (diff === -1) return 'Yesterday';
    return DAYS[d.getDay()].slice(0, 3) + ' ' + d.getDate() + ' ' + MONTHS[d.getMonth()].slice(0, 3);
  }
  function closestAction(el) {
    while (el && el !== document) {
      if (el.getAttribute && el.getAttribute('data-action')) return el;
      el = el.parentNode;
    }
    return null;
  }
  function ajax(method, path, body, cb) {
    var x = new XMLHttpRequest();
    x.open(method, path, true);
    x.timeout = 15000;
    if (body) x.setRequestHeader('Content-Type', 'application/json');
    x.onreadystatechange = function () {
      if (x.readyState !== 4) return;
      if (x.status >= 200 && x.status < 300) {
        var data = null;
        try { data = JSON.parse(x.responseText); } catch (e) { /* ignore */ }
        cb(null, data);
      } else cb(new Error('HTTP ' + x.status));
    };
    x.send(body ? JSON.stringify(body) : null);
  }
  function lsGet(k, fallback) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } }

  var WHO = {
    jess: { label: 'Jess', cls: 'who-jess' },
    graham: { label: 'Graham', cls: 'who-graham' },
    both: { label: 'Both', cls: 'who-both' }
  };
  function whoTag(w) { var x = WHO[w]; return x ? '<span class="who ' + x.cls + '">' + x.label + '</span>' : ''; }

  // ------------------------------------------------------------------ store
  // No server of our own. Data is kept in localStorage on each device and, if
  // sync is set up, mirrored to a Firebase Realtime Database through its REST
  // API (plain XHR + EventSource, so it works on old iOS). Each top-level key
  // is written on its own so two devices editing different lists never clash.
  var STATE_KEYS = ['events', 'groceries', 'meals', 'todos', 'notes', 'checklists', 'settings'];

  function items(list) { return list.map(function (t, i) { return { id: 'd' + i, text: t }; }); }
  function defaults() {
    return {
      events: [], todos: [], notes: [], meals: [],
      groceries: { items: [], history: [] },
      checklists: {
        jess: { items: items(['Make bed', 'Take vitamins', 'Drink 2L water']), done: {} },
        graham: { items: items(['Make bed', 'Take vitamins', 'Drink 2L water']), done: {} },
        both: { items: items(['Unload dishwasher', 'Put bins out (if bin day)', 'Lock up & alarm on']), done: {} }
      },
      settings: { title: 'Our Home', calendars: [], cameras: [], corsProxy: '', google: { url: '', token: '' }, bins: { postcode: '', number: '', suffix: '' }, weather: { name: 'Veldhoven', lat: 51.4183, lon: 5.4028 } }
    };
  }
  // Firebase drops empty arrays/objects and may hand arrays back as objects,
  // so everything read from storage goes through here.
  function arr(v) {
    if (!v) return [];
    if (Object.prototype.toString.call(v) === '[object Array]') return v.filter(function (x) { return x != null; });
    return Object.keys(v).map(function (k) { return v[k]; });
  }
  function normalize(key, v) {
    var d = defaults()[key];
    if (key === 'events' || key === 'todos' || key === 'notes') return arr(v);
    if (key === 'meals') return arr(v).map(function (m) { m.ingredients = arr(m.ingredients); return m; });
    if (key === 'groceries') {
      v = v || {};
      if (Object.prototype.toString.call(v) === '[object Array]') v = { items: v };
      var hist = v.history || [];
      if (Object.prototype.toString.call(hist) !== '[object Array]' && typeof hist === 'object' && !hist[0]) {
        // Old format: { name: count }
        hist = Object.keys(hist).map(function (n) { return { name: n, count: v.history[n] }; });
      }
      var items = arr(v.items).filter(function (i) { return !i.done; }).map(function (i) {
        i.qty = Math.max(1, parseInt(i.qty, 10) || 1);
        i.meals = arr(i.meals);
        if (i.meal && i.meals.indexOf(i.meal) < 0) i.meals.push(i.meal); // older format
        delete i.meal;
        return i;
      });
      return { items: items, history: arr(hist) };
    }
    if (key === 'checklists') {
      v = v || d;
      var out = {};
      ['jess', 'graham', 'both'].forEach(function (w) {
        var c = v[w] || { items: [] };
        out[w] = {
          items: arr(c.items).map(function (it, i) { return typeof it === 'string' ? { id: 'm' + i, text: it } : it; }),
          done: c.done || {}
        };
      });
      return out;
    }
    if (key === 'settings') {
      v = v || {};
      var g = v.google || {};
      return {
        title: v.title || d.title, calendars: arr(v.calendars), cameras: arr(v.cameras), corsProxy: v.corsProxy || '',
        google: { url: (g.url || '').replace(/\/+$/, ''), token: g.token || '' },
        bins: { postcode: (v.bins && v.bins.postcode) || '', number: (v.bins && v.bins.number) || '', suffix: (v.bins && v.bins.suffix) || '' },
        weather: v.weather && typeof v.weather.lat === 'number' ? { name: v.weather.name || '', lat: v.weather.lat, lon: v.weather.lon } : d.weather
      };
    }
    return v;
  }
  function clone(v) { return v == null ? v : JSON.parse(JSON.stringify(v)); }

  var Store = {
    data: null,
    dirty: {},
    inflight: {},
    online: false,
    sync: null,           // { db: 'https://xxx.firebasedatabase.app', key: 'household key' }
    remote: null,         // mirror of the server copy, built from the event stream
    es: null,
    pollTimer: null,
    listeners: [],
    calendar: { events: [], errors: [] },
    google: { calendars: [], events: [], errors: [], status: 'off' },
    ring: { devices: [], error: '' },
    bins: { pickups: [], error: '', status: 'off' },

    init: function () {
      var cached = lsGet('househub.state', null) || {};
      this.data = {};
      for (var i = 0; i < STATE_KEYS.length; i++) {
        var k = STATE_KEYS[i];
        this.data[k] = k in cached ? normalize(k, cached[k]) : defaults()[k];
      }
      this.dirty = lsGet('househub.dirty', {});
      this.sync = lsGet('househub.sync', null);
      var gc = lsGet('househub.google', null);
      if (gc) { this.google = gc; this.google.status = 'cached'; }
      this.connect();
      var self = this;
      this.pullGoogle();
      setInterval(function () { self.flush(); }, 15000);
      this.pullCalendar();
      setInterval(function () { self.pullCalendar(); }, 10 * 60000);
      setInterval(function () { self.pullGoogle(); }, 2 * 60000);
      this.pullRing();
      setInterval(function () { self.pullRing(); }, 2 * 60000);
      var bc = lsGet('househub.bins', null);
      if (bc) this.bins = bc;
      this.pullBins();
      setInterval(function () { self.pullBins(); }, 6 * 3600000);
    },
    onChange: function (fn) { this.listeners.push(fn); },
    emit: function () { for (var i = 0; i < this.listeners.length; i++) this.listeners[i](); },
    cache: function () { lsSet('househub.state', this.data); lsSet('househub.dirty', this.dirty); },
    baseUrl: function () {
      if (!this.sync || !this.sync.db || !this.sync.key) return null;
      return this.sync.db.replace(/\/+$/, '') + '/homes/' + encodeURIComponent(this.sync.key);
    },

    setSync: function (sync) {
      this.sync = sync && sync.db && sync.key ? sync : null;
      lsSet('househub.sync', this.sync);
      this.dirty = {};          // joining a household: take its data, don't overwrite it
      this.cache();
      this.connect();
    },

    connect: function () {
      var self = this;
      if (this.es) { this.es.close(); this.es = null; }
      clearInterval(this.pollTimer);
      this.remote = null;
      this.online = false;
      var base = this.baseUrl();
      if (!base) { this.emit(); return; }
      if (window.EventSource) {
        var es = this.es = new EventSource(base + '.json');
        es.addEventListener('put', function (e) { self.online = true; var m = JSON.parse(e.data); self.applyRemote(m.path, m.data); });
        es.addEventListener('patch', function (e) {
          self.online = true;
          var m = JSON.parse(e.data);
          for (var k in m.data) if (m.data.hasOwnProperty(k)) self.applyRemote(m.path.replace(/\/$/, '') + '/' + k, m.data[k]);
        });
        es.addEventListener('cancel', function () { self.online = false; self.emit(); });
        es.onopen = function () { self.online = true; self.flush(); self.emit(); };
        es.onerror = function () { self.online = false; self.emit(); };
      } else {
        var poll = function () {
          ajax('GET', base + '.json', null, function (err, res) {
            self.online = !err;
            if (!err) self.applyRemote('/', res);
            else self.emit();
          });
        };
        poll();
        this.pollTimer = setInterval(poll, 10000);
      }
    },

    applyRemote: function (path, value) {
      var parts = path.split('/').filter(function (p) { return p; });
      var first = this.remote === null;
      if (!parts.length) this.remote = value || {};
      else {
        if (!this.remote) this.remote = {};
        var o = this.remote;
        for (var i = 0; i < parts.length - 1; i++) {
          if (!o[parts[i]] || typeof o[parts[i]] !== 'object') o[parts[i]] = {};
          o = o[parts[i]];
        }
        if (value === null) delete o[parts[parts.length - 1]];
        else o[parts[parts.length - 1]] = value;
      }
      var touched = parts.length ? [parts[0]] : STATE_KEYS;
      for (var j = 0; j < touched.length; j++) {
        var k = touched[j];
        if (STATE_KEYS.indexOf(k) < 0) continue;
        if (first && !(k in this.remote)) { this.dirty[k] = true; continue; } // new household: upload ours
        if (!this.dirty[k]) this.data[k] = normalize(k, clone(this.remote[k]));
      }
      this.cache();
      if (first) this.flush();
      if (touched.indexOf('settings') >= 0) { this.pullCalendar(); this.pullGoogle(); this.pullRing(); this.pullBins(); if (typeof Weather !== 'undefined') Weather.pull(); }
      this.emit();
    },

    // Call after mutating Store.data[key].
    save: function (key) {
      this.dirty[key] = true;
      this.cache();
      this.emit();
      this.flush();
      if (key === 'settings') { this.pullCalendar(); this.pullGoogle(); this.pullRing(); this.pullBins(); Weather.pull(); }
    },
    flush: function () {
      var self = this, base = this.baseUrl();
      if (!base) return;
      Object.keys(this.dirty).forEach(function (key) {
        if (self.inflight[key]) return;
        self.inflight[key] = true;
        var sent = JSON.stringify(self.data[key]);
        ajax('PUT', base + '/' + key + '.json', self.data[key], function (err) {
          self.inflight[key] = false;
          if (err) { self.online = false; return self.emit(); }
          // Only clear the flag if nothing changed while the request was in flight.
          if (JSON.stringify(self.data[key]) === sent) delete self.dirty[key];
          else setTimeout(function () { self.flush(); }, 0);
          self.cache();
          self.emit();
        });
      });
    },

    // Calendar feeds are fetched by the browser. Google/iCloud don't allow
    // that (no CORS headers), so a CORS proxy can be set in Settings.
    pullCalendar: function () {
      var self = this, s = this.data.settings;
      var feeds = s.calendars.filter(function (c) { return c.url; });
      // The House Hub worker doubles as the CORS proxy.
      var proxy = s.corsProxy || (s.google.url ? s.google.url + '/?url=' : '');
      if (!feeds.length) { this.calendar = { events: [], errors: [] }; return; }
      var now = new Date();
      var from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      var to = new Date(now.getFullYear(), now.getMonth() + 4, 1);
      var all = [], errors = [], pending = feeds.length;
      feeds.forEach(function (feed) {
        var u = feed.url.trim().replace(/^webcal:/i, 'https:');
        if (proxy) u = proxy.indexOf('{url}') >= 0 ? proxy.replace('{url}', encodeURIComponent(u)) : proxy + encodeURIComponent(u);
        var x = new XMLHttpRequest();
        x.open('GET', u, true);
        x.timeout = 20000;
        x.onreadystatechange = function () {
          if (x.readyState !== 4) return;
          if (x.status === 200 && x.responseText.indexOf('BEGIN:VCALENDAR') >= 0) {
            try {
              ICS.expand(ICS.parse(x.responseText), from, to).forEach(function (ev) {
                ev.calendar = feed.name || ''; ev.color = feed.color || ''; all.push(ev);
              });
            } catch (e) { errors.push((feed.name || 'Calendar') + ': could not read feed'); }
          } else {
            errors.push((feed.name || 'Calendar') + ': ' + (x.status === 0
              ? 'blocked by the browser – set a CORS proxy in Settings'
              : 'HTTP ' + x.status));
          }
          if (--pending === 0) { self.calendar = { events: all, errors: errors }; self.emit(); }
        };
        x.send(null);
      });
    },

    // Two-way Google Calendar sync through the House Hub Cloudflare Worker.
    workerOn: function () { var g = this.data.settings.google; return !!(g.url && g.token); },
    googleOn: function () { return this.workerOn() && this.google.status !== 'unavailable'; },
    // Bin collection days from Mijn Afvalwijzer (through the worker).
    pullBins: function () {
      var self = this, b = this.data.settings.bins;
      if (!this.workerOn() || !b.postcode || !b.number) { this.bins = { pickups: [], error: '', status: 'off' }; return; }
      var q = 'postcode=' + encodeURIComponent(b.postcode) + '&number=' + encodeURIComponent(b.number) + '&suffix=' + encodeURIComponent(b.suffix || '');
      this.googleCall('GET', '/afval?' + q, null, function (err, res) {
        if (err) { self.bins.status = 'error'; self.bins.error = err.message; }
        else { self.bins = { pickups: res.pickups || [], error: '', status: 'ok', at: Date.now() }; lsSet('househub.bins', self.bins); }
        self.emit();
      });
    },
    // Ring: doorbell presses / motion and battery, for home-screen notifications.
    pullRing: function () {
      var self = this;
      var hasRing = this.data.settings.cameras.some(function (c) { return c.type === 'ring'; });
      if (!this.workerOn() || !hasRing) { this.ring = { devices: [], error: '' }; return; }
      this.googleCall('GET', '/ring/devices', null, function (err, res) {
        self.ring = err ? { devices: self.ring.devices, error: err.message } : { devices: res.devices || [], error: '' };
        self.emit();
      });
    },
    googleCall: function (method, path, body, cb) {
      var g = this.data.settings.google;
      var x = new XMLHttpRequest();
      x.open(method, g.url + path, true);
      x.timeout = 20000;
      x.setRequestHeader('Authorization', 'Bearer ' + g.token);
      if (body) x.setRequestHeader('Content-Type', 'application/json');
      x.onreadystatechange = function () {
        if (x.readyState !== 4) return;
        var data = null;
        try { data = JSON.parse(x.responseText); } catch (e) { /* ignore */ }
        if (x.status >= 200 && x.status < 300) cb(null, data);
        else cb(new Error(data && data.error ? data.error : x.status === 0 ? 'can\u2019t reach the worker' : 'HTTP ' + x.status));
      };
      x.send(body ? JSON.stringify(body) : null);
    },
    pullGoogle: function () {
      var self = this;
      if (!this.workerOn()) { this.google = { calendars: [], events: [], errors: [], status: 'off' }; return; }
      var now = new Date();
      var from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      var to = new Date(now.getFullYear(), now.getMonth() + 6, 1);
      this.googleCall('GET', '/google/events?from=' + encodeURIComponent(from.toISOString()) + '&to=' + encodeURIComponent(to.toISOString()), null, function (err, res) {
        if (err && /not set up/.test(err.message)) { self.google = { calendars: [], events: [], errors: [], status: 'unavailable' }; }
        else if (err) { self.google.status = 'error'; self.google.errors = [err.message]; }
        else {
          self.google = { calendars: res.calendars || [], events: res.events || [], errors: res.errors || [], status: 'ok', at: Date.now() };
          lsSet('househub.google', self.google);
        }
        self.emit();
      });
    }
  };

  // Settings that belong to this device only (not shared).
  var Device = {
    get: function () {
      var d = lsGet('househub.device', null);
      if (!d) {
        // Tablets default to "wall display" (auto-home + night dimming); phones don't.
        var short = Math.min(window.screen.width, window.screen.height);
        d = { wall: short >= 700 };
      }
      return d;
    },
    set: function (d) { lsSet('househub.device', d); }
  };

  // ------------------------------------------------------------------ weather
  // Open-Meteo: free, no account, and browsers may read it directly.
  var WMO = {
    0: ['Clear', '☀️', '🌙'], 1: ['Mostly clear', '🌤️', '🌙'], 2: ['Partly cloudy', '⛅', '☁️'], 3: ['Cloudy', '☁️', '☁️'],
    45: ['Fog', '🌫️'], 48: ['Fog', '🌫️'], 51: ['Light drizzle', '🌦️'], 53: ['Drizzle', '🌦️'], 55: ['Heavy drizzle', '🌧️'],
    56: ['Freezing drizzle', '🌧️'], 57: ['Freezing drizzle', '🌧️'], 61: ['Light rain', '🌦️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '🌧️'],
    66: ['Freezing rain', '🌧️'], 67: ['Freezing rain', '🌧️'], 71: ['Light snow', '🌨️'], 73: ['Snow', '🌨️'], 75: ['Heavy snow', '❄️'],
    77: ['Snow grains', '🌨️'], 80: ['Showers', '🌦️'], 81: ['Showers', '🌧️'], 82: ['Heavy showers', '⛈️'], 85: ['Snow showers', '🌨️'],
    86: ['Snow showers', '❄️'], 95: ['Thunderstorm', '⛈️'], 96: ['Thunderstorm, hail', '⛈️'], 99: ['Thunderstorm, hail', '⛈️']
  };
  function wmo(code, isDay) {
    var w = WMO[code] || ['–', '🌡️'];
    return { text: w[0], icon: isDay === 0 && w[2] ? w[2] : w[1] };
  }
  var Weather = {
    data: lsGet('househub.weather', null),
    error: '',
    pull: function (cb) {
      var self = this, loc = Store.data.settings.weather;
      var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + loc.lat + '&longitude=' + loc.lon +
        '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,is_day,wind_speed_10m,wind_direction_10m,wind_gusts_10m,precipitation' +
        '&hourly=temperature_2m,precipitation_probability,weather_code,is_day' +
        '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,sunrise,sunset,uv_index_max,wind_speed_10m_max' +
        '&timezone=auto&forecast_days=14';
      ajax('GET', url, null, function (err, res) {
        if (err || !res || !res.current) { self.error = 'Weather unavailable'; }
        else { self.data = res; self.data.at = Date.now(); self.error = ''; lsSet('househub.weather', res); }
        if (cb) cb(err); else if (!current) renderHome(); else if (current === 'weather') Apps.weather.render();
      });
    },
    // "Rain likely from 15:00" if the next 8 hours have a ≥60% chance.
    rainSoon: function () {
      var d = this.data;
      if (!d || !d.hourly || !d.hourly.time) return '';
      var now = new Date(), t = d.hourly.time, p = d.hourly.precipitation_probability;
      for (var i = 0; i < t.length; i++) {
        var at = parseISO(t[i]), hrs = (at - now) / 3600000;
        if (hrs < -1) continue;
        if (hrs > 8) break;
        if (p[i] >= 60) return hrs <= 0 ? 'Rain likely now' : 'Rain likely from ' + fmtTime(at);
      }
      return '';
    },
    // The compact widget at the top of the home screen (tap for the forecast).
    html: function () {
      var d = this.data;
      if (!d) return '<div class="w-empty muted small">' + (this.error || 'Loading weather…') + '</div>';
      var c = d.current, now = wmo(c.weather_code, c.is_day), dl = d.daily;
      var rain = this.rainSoon();
      return '<div class="w-now flex center"><span class="w-icon">' + now.icon + '</span>' +
        '<span class="w-temp">' + Math.round(c.temperature_2m) + '°</span>' +
        '<div class="w-desc"><div>' + now.text + '</div>' +
        '<div class="muted">H ' + Math.round(dl.temperature_2m_max[0]) + '° · L ' + Math.round(dl.temperature_2m_min[0]) + '° · 💧' + (dl.precipitation_probability_max[0] || 0) + '%</div></div></div>' +
        (rain ? '<div class="w-sub"><span class="w-rain">☔ ' + rain + '</span></div>' : '');
    }
  };

  // ------------------------------------------------------------------ modal
  var Modal = {
    open: function (title, html, onSave, saveLabel) {
      $('modal-root').innerHTML =
        '<div class="modal-bg" data-action="modal-bg"><div class="modal">' +
        '<h3>' + esc(title) + '</h3>' + html +
        '<div class="modal-actions flex"><button class="btn" data-action="modal-cancel">Cancel</button>' +
        '<button class="btn primary" data-action="modal-save">' + esc(saveLabel || 'Save') + '</button></div>' +
        '</div></div>';
      this.onSave = onSave;
      var first = $('modal-root').querySelector('input, textarea');
      if (first) setTimeout(function () { first.focus(); }, 50);
    },
    close: function () { $('modal-root').innerHTML = ''; this.onSave = null; },
    val: function (name) { var el = $('modal-root').querySelector('[name="' + name + '"]'); return el ? el.value.trim() : ''; },
    seg: function (name) { var el = $('modal-root').querySelector('.seg[data-name="' + name + '"] .on'); return el ? el.getAttribute('data-value') : ''; }
  };
  function segHtml(name, options, selected) {
    var h = '<div class="seg flex" data-name="' + name + '">';
    for (var i = 0; i < options.length; i++) {
      h += '<button class="opt' + (options[i][0] === selected ? ' on' : '') + '" data-action="seg" data-value="' + options[i][0] + '">' + esc(options[i][1]) + '</button>';
    }
    return h + '</div>';
  }
  var WHO_OPTS = [['both', 'Both'], ['jess', 'Jess'], ['graham', 'Graham']];

  // ------------------------------------------------------------------ sub-apps
  // Each app: title, shell() -> static HTML (inputs etc.), render() -> updates
  // dynamic parts only (so a background sync never wipes what you're typing),
  // actions: { name: function(el) }, optional enter()/leave().
  var Apps = {};

  // ---- Calendar -------------------------------------------------------------
  // Parse "2026-11-05", "2026-11-05T09:30:00Z" or "...+01:00" without relying
  // on old Safari's Date parser.
  function parseISO(v) {
    var m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(v || '');
    if (!m) return new Date(v);
    if (!m[4]) return new Date(+m[1], +m[2] - 1, +m[3]);
    if (!m[7]) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
    var off = 0;
    if (m[7] !== 'Z') { var t = m[7].replace(':', ''); off = (t[0] === '-' ? -1 : 1) * (+t.slice(1, 3) * 60 + +t.slice(3, 5)); }
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) - off * 60000);
  }
  // Local date + time -> "2026-11-05T19:00:00+00:00" for Google.
  function isoLocal(dateKey, time) {
    var d = parseDay(dateKey), t = time.split(':');
    d.setHours(+t[0], +t[1]);
    var off = -d.getTimezoneOffset(), sign = off >= 0 ? '+' : '-';
    off = Math.abs(off);
    return dateKey + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':00' + sign + pad(Math.floor(off / 60)) + ':' + pad(off % 60);
  }
  // Google Calendar's own event colours, so events look the same in both.
  var GCOLORS = { '1': '#7986cb', '2': '#33b679', '3': '#8e24aa', '4': '#e67c73', '5': '#f6bf26', '6': '#f4511e', '7': '#039be5', '8': '#616161', '9': '#3f51b5', '10': '#0b8043', '11': '#d50000' };
  var GCOLOR_NAMES = { '1': 'Lavender', '2': 'Sage', '3': 'Grape', '4': 'Flamingo', '5': 'Banana', '6': 'Tangerine', '7': 'Peacock', '8': 'Graphite', '9': 'Blueberry', '10': 'Basil', '11': 'Tomato' };
  function colorPicker(selected) {
    var h = '<div class="seg swatches flex wrap" data-name="color">' +
      '<button class="opt auto' + (!selected ? ' on' : '') + '" data-action="seg" data-value="">Auto</button>';
    for (var i = 1; i <= 11; i++) {
      var k = String(i);
      h += '<button class="opt swatch' + (selected === k ? ' on' : '') + '" data-action="seg" data-value="' + k + '" title="' + GCOLOR_NAMES[k] + '" style="background:' + GCOLORS[k] + '"></button>';
    }
    return h + '</div>';
  }
  var GCAL_COLORS = ['#4f8cff', '#f5a623', '#7b61ff', '#3fbf7f', '#e86fa8'];
  function googleCalColor(id) {
    var cals = Store.google.calendars;
    for (var i = 0; i < cals.length; i++) if (cals[i].id === id) return GCAL_COLORS[i % GCAL_COLORS.length];
    return GCAL_COLORS[0];
  }

  var BIN_INFO = {
    gft: { label: 'GFT (green bin)', color: '#3fbf7f' },
    restafval: { label: 'Restafval (grey bin)', color: '#8a94a6' },
    papier: { label: 'Paper (blue bin)', color: '#4f8cff' },
    pmd: { label: 'PMD / plastic', color: '#f5a623' },
    plastic: { label: 'Plastic', color: '#f5a623' },
    glas: { label: 'Glass', color: '#7bd3c7' },
    textiel: { label: 'Textiles', color: '#b58cff' },
    kerstbomen: { label: 'Christmas trees', color: '#2e8b57' }
  };
  function binLabel(p) { var i = BIN_INFO[p.type]; return i ? i.label : p.name.charAt(0).toUpperCase() + p.name.slice(1); }
  function binsOn(key) { return Store.bins.pickups.filter(function (p) { return p.date === key; }); }

  function allEvents() {
    var out = [];
    Store.bins.pickups.forEach(function (p) {
      var info = BIN_INFO[p.type] || { color: '#8a94a6' };
      out.push({ title: '🗑️ ' + binLabel(p), allDay: true, start: parseDay(p.date), color: info.color, calendar: 'Bin collection', bin: true });
    });
    Store.data.events.forEach(function (e) {
      var start = parseDay(e.date), end = null, endDay = e.endDate && e.endDate > e.date ? e.endDate : e.date;
      if (e.time) {
        var t = e.time.split(':'); start.setHours(+t[0], +t[1]);
        if (e.end) { end = parseDay(endDay); var t2 = e.end.split(':'); end.setHours(+t2[0], +t2[1]); }
      } else if (endDay > e.date) end = addDays(parseDay(endDay), 1);
      out.push({ id: e.id, local: true, title: e.title, who: e.who, colorId: e.colorId || '', allDay: !e.time, start: start, end: end, color: GCOLORS[e.colorId] || '' });
    });
    (Store.calendar.events || []).forEach(function (e) {
      out.push({ title: e.title, location: e.location, allDay: e.allDay, start: new Date(e.start), end: new Date(e.end), color: e.color, calendar: e.calendar });
    });
    if (Store.googleOn()) {
      Store.google.events.forEach(function (e) {
        out.push({
          id: e.id, gcal: e.calendarId, title: e.title, location: e.location, allDay: e.allDay, who: e.who, colorId: e.colorId || '',
          start: parseISO(e.start), end: parseISO(e.end), calendar: e.calendar,
          color: GCOLORS[e.colorId] || (e.who ? '' : googleCalColor(e.calendarId))
        });
      });
    }
    out.sort(function (a, b) { return a.start - b.start; });
    return out;
  }
  function eventsOn(events, d) {
    var key = dayKey(d);
    return events.filter(function (e) {
      if (dayKey(e.start) === key) return true;
      // Multi-day events: show on every day they span.
      if (e.end && e.start < d) {
        var endKey = dayKey(new Date(e.end.getTime() - 1));
        return key <= endKey && key > dayKey(e.start);
      }
      return false;
    });
  }
  function eventColor(e) { return e.color || (e.who === 'jess' ? '#e86fa8' : e.who === 'graham' ? '#3fbf7f' : '#4f8cff'); }

  Apps.calendar = {
    title: 'Calendar',
    month: null,
    selected: null,
    enter: function () {
      var t = new Date(); this.month = new Date(t.getFullYear(), t.getMonth(), 1); this.selected = dayKey(t);
      Store.pullGoogle(); // always show the latest from Google when the calendar opens
    },
    headerActions: '<button class="btn small" data-action="cal-refresh" style="margin-right:8px">↻</button><button class="btn primary small" data-action="cal-add">+ Event</button>',
    shell: function () { return '<div class="cal-wrap flex"><div class="cal-month" id="cal-month"></div><div class="cal-day" id="cal-day"></div></div>'; },
    render: function () {
      var events = allEvents();
      var m = this.month, todayKey = dayKey(new Date());
      var h = '<div class="cal-nav flex center between"><button class="btn" data-action="cal-prev">‹</button>' +
        '<h3>' + MONTHS[m.getMonth()] + ' ' + m.getFullYear() + '</h3>' +
        '<div><button class="btn" data-action="cal-today">Today</button> <button class="btn" data-action="cal-next">›</button></div></div>';
      h += '<div class="cal-grid"><div class="cal-week">';
      ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach(function (d) { h += '<div class="cal-cell dow">' + d + '</div>'; });
      h += '</div>';
      var start = addDays(m, -((m.getDay() + 6) % 7)); // back to Monday
      for (var w = 0; w < 6; w++) {
        h += '<div class="cal-week">';
        for (var i = 0; i < 7; i++) {
          var d = addDays(start, w * 7 + i), k = dayKey(d);
          var evs = eventsOn(events, d);
          var cls = 'cal-cell' + (d.getMonth() !== m.getMonth() ? ' other' : '') + (k === todayKey ? ' today' : '') + (k === this.selected ? ' sel' : '');
          h += '<button class="' + cls + '" data-action="cal-select" data-day="' + k + '"><span class="num">' + d.getDate() + '</span><div class="dots flex wrap">';
          for (var j = 0; j < Math.min(evs.length, 6); j++) h += '<span class="dot" style="background:' + esc(eventColor(evs[j])) + '"></span>';
          h += '</div></button>';
        }
        h += '</div>';
        if (addDays(start, (w + 1) * 7).getMonth() !== m.getMonth() && w >= 3) break;
      }
      h += '</div>';
      var problems = (Store.calendar.errors || []).concat(Store.googleOn() ? Store.google.errors : []);
      if (problems.length) h += '<p class="small overdue">Calendar problem: ' + esc(problems.join('; ')) + '</p>';
      if (Store.googleOn() && Store.google.status === 'ok') {
        h += '<p class="small muted">✓ Google: ' + esc(Store.google.calendars.map(function (c) { return c.name; }).join(', ')) +
          (Store.google.at ? ' · synced ' + fmtTime(new Date(Store.google.at)) : '') + ' · ' + Store.google.events.length + ' events. ' +
          'Only these calendars are shown – add more to GOOGLE_CALENDAR_IDS on the worker.</p>';
      }
      $('cal-month').innerHTML = h;

      var sel = parseDay(this.selected), dayEvs = eventsOn(events, sel);
      var dh = '<h3 style="margin:6px 0 14px">' + fmtDayLong(sel) + '</h3>';
      if (!dayEvs.length) dh += '<div class="list"><div class="list-empty">Nothing planned</div></div>';
      dayEvs.forEach(function (e) {
        var editable = e.local || e.gcal;
        dh += '<div class="ev flex center' + (editable ? ' editable' : '') + '" style="border-left-color:' + esc(eventColor(e)) + '"' +
          (editable ? ' data-action="cal-edit" data-id="' + esc(e.id) + '"' + (e.gcal ? ' data-gcal="' + esc(e.gcal) + '"' : '') : '') + '><div class="grow">' +
          '<div class="t">' + (e.allDay ? 'All day' : fmtTime(e.start) + (e.end ? ' – ' + fmtTime(e.end) : '')) +
          (e.calendar ? ' · ' + esc(e.calendar) : '') + '</div>' +
          '<div class="n">' + (e.who ? whoTag(e.who) : '') + esc(e.title) + '</div>' +
          (e.location ? '<div class="t">' + esc(e.location) + '</div>' : '') + '</div>' +
          (editable ? '<span class="muted small" style="margin-right:6px">Edit</span>' : '') +
          (e.local || e.gcal ? '<button class="del" data-action="cal-del" data-id="' + esc(e.id) + '"' + (e.gcal ? ' data-gcal="' + esc(e.gcal) + '"' : '') + '>✕</button>' : '') +
          '</div>';
      });
      $('cal-day').innerHTML = dh;
    },
    actions: {
      'cal-prev': function () { var m = Apps.calendar.month; Apps.calendar.month = new Date(m.getFullYear(), m.getMonth() - 1, 1); },
      'cal-next': function () { var m = Apps.calendar.month; Apps.calendar.month = new Date(m.getFullYear(), m.getMonth() + 1, 1); },
      'cal-today': function () { Apps.calendar.enter(); },
      'cal-refresh': function () { Store.pullGoogle(); Store.pullCalendar(); Toast.show('Checking Google Calendar…'); },
      'cal-select': function (el) { Apps.calendar.selected = el.getAttribute('data-day'); },
      'cal-del': function (el) {
        var id = el.getAttribute('data-id'), gcal = el.getAttribute('data-gcal');
        if (!confirm(gcal ? 'Delete this event from Google Calendar?' : 'Delete this event?')) return;
        Modal.close();
        if (gcal) {
          Store.google.events = Store.google.events.filter(function (e) { return e.id !== id; });
          Store.googleCall('DELETE', '/google/events/' + encodeURIComponent(gcal) + '/' + encodeURIComponent(id), null, function (err) {
            if (err) alert('Couldn’t delete from Google: ' + err.message);
            Store.pullGoogle();
          });
          return;
        }
        Store.data.events = Store.data.events.filter(function (e) { return e.id !== id; });
        Store.save('events');
      },
      'cal-add': function () { Apps.calendar.editor(null); },
      'cal-edit': function (el) {
        var id = el.getAttribute('data-id'), gcal = el.getAttribute('data-gcal');
        if (/^pending-/.test(id)) return Toast.show('Still saving to Google – try again in a moment');
        var ev = allEvents().filter(function (e) { return e.id === id && (gcal ? e.gcal === gcal : e.local); })[0];
        if (ev) Apps.calendar.editor(ev);
      }
    },

    // One form for adding and editing. Events go to Google when it's connected
    // (or when the event came from Google), otherwise they're kept in the hub.
    editor: function (ev) {
      var isNew = !ev;
      var toGoogle = ev ? !!ev.gcal : !!(Store.googleOn() && Store.google.calendars.length);
      var date = ev ? dayKey(ev.start) : Apps.calendar.selected;
      var time = ev && !ev.allDay ? fmtTime(ev.start) : '';
      var endTime = ev && !ev.allDay && ev.end ? fmtTime(ev.end) : '';
      var endDate = date;
      if (ev && ev.end) endDate = dayKey(ev.allDay ? new Date(ev.end.getTime() - 1) : ev.end);
      if (endDate < date) endDate = date;
      var calPicker = isNew && toGoogle && Store.google.calendars.length > 1
        ? '<label class="lbl">Google calendar</label>' + segHtml('cal', Store.google.calendars.map(function (c) { return [c.id, c.name]; }), Store.google.calendars[0].id)
        : '';
      var title = isNew ? (toGoogle ? 'New event (saved to Google Calendar)' : 'New event') : (toGoogle ? 'Edit event (Google Calendar)' : 'Edit event');
      Modal.open(title,
        '<input class="field" name="title" placeholder="What?" value="' + esc(ev ? ev.title : '') + '">' +
        '<div class="flex"><div class="grow" style="margin-right:10px"><label class="lbl">Date</label><input class="field" type="date" name="date" value="' + date + '"></div>' +
        '<div class="grow"><label class="lbl">End date</label><input class="field" type="date" name="enddate" value="' + endDate + '"></div></div>' +
        '<div class="flex"><div class="grow" style="margin-right:10px"><label class="lbl">Start time (blank = all day)</label><input class="field" type="time" name="time" value="' + time + '"></div>' +
        '<div class="grow"><label class="lbl">End time</label><input class="field" type="time" name="end" value="' + endTime + '"></div></div>' +
        '<label class="lbl">Who</label>' + segHtml('who', WHO_OPTS, ev ? ev.who || '' : 'both') +
        '<label class="lbl">Colour <span class="muted">(Auto = by who)</span></label>' + colorPicker(ev ? ev.colorId : '') +
        calPicker +
        (isNew ? '' : '<button class="btn danger small" data-action="cal-del" data-id="' + esc(ev.id) + '"' + (ev.gcal ? ' data-gcal="' + esc(ev.gcal) + '"' : '') + '>Delete event</button>'),
        function () {
          var t = Modal.val('title'), d = Modal.val('date'), ed = Modal.val('enddate') || d, st = Modal.val('time'), et = Modal.val('end');
          var who = Modal.seg('who'), colorId = Modal.seg('color');
          if (!t || !/^\d{4}-\d{2}-\d{2}$/.test(d)) { alert('Give the event a name and a date.'); return false; }
          if (ed < d) ed = d;
          if (st && (!et || (ed === d && et <= st))) {
            var h = +st.split(':')[0];
            et = h >= 23 ? '23:59' : pad(h + 1) + ':' + st.split(':')[1]; // default: one hour
          }

          if (!toGoogle) {
            var obj = { id: ev ? ev.id : uid(), title: t, date: d, endDate: ed, time: st, end: st ? et : '', who: who, colorId: colorId };
            if (isNew) Store.data.events.push(obj);
            else Store.data.events = Store.data.events.map(function (x) { return x.id === obj.id ? obj : x; });
            Store.save('events');
            return;
          }

          var body = { title: t, who: who, colorId: colorId, allDay: !st };
          if (st) { body.start = isoLocal(d, st); body.end = isoLocal(ed, et); }
          else { body.start = d; body.end = dayKey(addDays(parseDay(ed), 1)); }
          // Show the change straight away; the next refresh brings Google's copy.
          var shown = { title: t, who: who, colorId: colorId, allDay: body.allDay, start: body.start, end: body.end, location: ev ? ev.location : '' };
          if (isNew) {
            body.calendarId = Modal.seg('cal') || Store.google.calendars[0].id;
            var cal = Store.google.calendars.filter(function (c) { return c.id === body.calendarId; })[0];
            shown.id = 'pending-' + uid(); shown.calendarId = body.calendarId; shown.calendar = cal ? cal.name : '';
            Store.google.events.push(shown);
            Store.googleCall('POST', '/google/events', body, function (err) {
              if (err) {
                alert('Couldn’t save to Google (' + err.message + '). Saved in House Hub instead.');
                Store.data.events.push({ id: uid(), title: t, date: d, endDate: ed, time: st, end: st ? et : '', who: who, colorId: colorId });
                Store.save('events');
              }
              Store.pullGoogle();
            });
          } else {
            Store.google.events.forEach(function (x) {
              if (x.id === ev.id && x.calendarId === ev.gcal) { for (var k in shown) if (shown.hasOwnProperty(k)) x[k] = shown[k]; }
            });
            Store.googleCall('PATCH', '/google/events/' + encodeURIComponent(ev.gcal) + '/' + encodeURIComponent(ev.id), body, function (err) {
              if (err) alert('Couldn’t update Google Calendar: ' + err.message);
              Store.pullGoogle();
            });
          }
        });
    }
  };

  // ---- Groceries ------------------------------------------------------------
  // Ticking an item removes it (with a few seconds to undo). Meals are saved
  // ingredient lists; adding a meal puts its ingredients on the list.
  function groc() { return Store.data.groceries; }
  function bumpHistory(name) {
    var g = groc();
    for (var j = 0; j < g.history.length; j++) {
      if (g.history[j].name.toLowerCase() === name.toLowerCase()) { g.history[j].count++; return; }
    }
    g.history.push({ name: name, count: 1 });
  }
  function findItem(name) {
    var items = groc().items;
    for (var i = 0; i < items.length; i++) if (items[i].name.toLowerCase() === name.toLowerCase()) return items[i];
    return null;
  }
  function onList(name) { return !!findItem(name); }
  function mealSummary(meals) {
    var counts = {}, order = [];
    meals.forEach(function (m) { if (!counts[m]) { counts[m] = 0; order.push(m); } counts[m]++; });
    return order.map(function (m) { return m + (counts[m] > 1 ? ' \u00d7' + counts[m] : ''); }).join(', ');
  }
  function qtyLabel(i) { return i.qty > 1 ? ' \u00d7' + i.qty : ''; }
  function findMeal(id) { var m = Store.data.meals; for (var i = 0; i < m.length; i++) if (m[i].id === id) return m[i]; return null; }

  var Toast = {
    timer: null,
    show: function (text, undoFn) {
      var el = $('toast');
      if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
      el.innerHTML = '<span>' + esc(text) + '</span>' + (undoFn ? '<button class="btn small" data-action="toast-undo">Undo</button>' : '');
      el.className = 'toast';
      this.undo = undoFn;
      clearTimeout(this.timer);
      var self = this;
      this.timer = setTimeout(function () { self.hide(); }, 5000);
    },
    hide: function () { var el = $('toast'); if (el) el.className = 'toast hidden'; this.undo = null; }
  };

  Apps.groceries = {
    title: 'Groceries',
    view: 'list',
    headerActions: '<button class="btn primary small" data-action="meal-new">+ Create meal</button>',
    shell: function () {
      return '<div class="tabs flex" id="groc-tabs"></div>' +
        '<div id="groc-view-list">' +
        '<form class="add-row flex" data-form="groc-add"><input class="field grow" id="groc-input" placeholder="Add an item…" autocomplete="off" autocorrect="on">' +
        '<button class="btn primary" type="submit">Add</button></form>' +
        '<div id="groc-list"></div><div class="chips flex wrap" id="groc-chips"></div></div>' +
        '<div id="groc-view-meals" class="hidden"></div>';
    },
    render: function () {
      var self = this, g = groc();
      var open = g.items.filter(function (i) { return !i.done; });
      $('groc-tabs').innerHTML =
        '<button class="tab grow' + (this.view === 'list' ? ' active' : '') + '" data-action="groc-view" data-v="list">🛒 Shopping list (' + open.length + ')</button>' +
        '<button class="tab grow' + (this.view === 'meals' ? ' active' : '') + '" data-action="groc-view" data-v="meals">🍝 Meals (' + Store.data.meals.length + ')</button>';
      $('groc-view-list').className = this.view === 'list' ? '' : 'hidden';
      $('groc-view-meals').className = this.view === 'meals' ? '' : 'hidden';

      if (this.view === 'list') {
        var h = '<div class="list">';
        if (!open.length) h += '<div class="list-empty">The list is empty 🎉</div>';
        open.slice().sort(function (a, b) { return a.added - b.added; }).forEach(function (i) {
          h += '<div class="row flex center" data-action="groc-tick" data-id="' + i.id + '">' +
            '<div class="check"></div><div class="text grow">' + esc(i.name) +
            (i.qty > 1 ? ' <span class="qty">\u00d7' + i.qty + '</span>' : '') +
            (i.meals.length ? '<div class="meta">for ' + esc(mealSummary(i.meals)) + '</div>' : '') + '</div>' +
            (i.qty > 1 ? '<button class="btn small" data-action="groc-less" data-id="' + i.id + '" style="margin-right:6px">\u2212</button>' : '') +
            '<button class="btn small" data-action="groc-more" data-id="' + i.id + '">+</button></div>';
        });
        $('groc-list').innerHTML = h + '</div>';
        var favs = g.history.filter(function (x) { return !onList(x.name); })
          .sort(function (a, b) { return b.count - a.count; }).slice(0, 16);
        $('groc-chips').innerHTML = favs.length ? '<div class="section-label" style="width:100%">Buy again</div>' + favs.map(function (x) {
          return '<button class="chip" data-action="groc-quick" data-name="' + esc(x.name) + '">+ ' + esc(x.name) + '</button>';
        }).join('') : '';
      } else {
        var meals = Store.data.meals.slice().sort(function (a, b) { return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1; });
        var mh = '';
        if (!meals.length) mh = '<div class="list"><div class="list-empty">No meals yet.<br><br><button class="btn primary" data-action="meal-new">+ Create meal</button></div></div>';
        else {
          mh = '<p class="muted small" style="margin-top:0">Tap <b>Add to list</b> to put a meal’s ingredients on the shopping list. If an ingredient is already there, its amount goes up (×2, ×3…).</p><div class="list">';
          meals.forEach(function (m) {
            mh += '<div class="row flex center"><div class="text grow" data-action="meal-edit" data-id="' + m.id + '">' +
              '<div><b>' + esc(m.name) + '</b></div><div class="meta">' + esc(m.ingredients.join(', ')) + '</div></div>' +
              '<button class="btn small" data-action="meal-edit" data-id="' + m.id + '" style="margin-right:8px">Edit</button>' +
              '<button class="btn primary small" data-action="meal-add" data-id="' + m.id + '">+ Add to list</button>' +
              '</div>';
          });
          mh += '</div>';
        }
        $('groc-view-meals').innerHTML = mh;
      }
    },
    // Adding something already on the list bumps its amount instead of
    // ignoring it, so two meals that both need onions give "Onion ×2".
    add: function (name, meal) {
      name = name.trim();
      if (!name) return null;
      var item = findItem(name);
      if (item) item.qty++;
      else { item = { id: uid(), name: name, qty: 1, meals: [], added: Date.now() }; groc().items.push(item); }
      if (meal) item.meals.push(meal);
      return item;
    },
    // Undo puts the list back exactly as it was before the change.
    undoable: function (text, change) {
      var before = JSON.stringify(groc().items);
      change();
      Store.save('groceries');
      Toast.show(text, function () { groc().items = JSON.parse(before); Store.save('groceries'); });
    },
    addOne: function (name) {
      if (!name.trim()) return;
      var item;
      this.undoable('', function () { item = Apps.groceries.add(name); });
      Toast.show(item.qty > 1 ? item.name + ' \u00d7' + item.qty + ' on the list' : 'Added ' + item.name, Toast.undo);
    },
    mealEditor: function (m) {
      var isNew = !m;
      m = m || { name: '', ingredients: [] };
      Modal.open(isNew ? 'Create meal' : 'Edit meal',
        '<input class="field" name="name" placeholder="Meal name, e.g. Spaghetti bolognese" value="' + esc(m.name) + '">' +
        '<label class="lbl">Ingredients – one per line</label>' +
        '<textarea class="field" name="ingredients" rows="8" placeholder="Spaghetti\nMince\nChopped tomatoes\nOnion\nGarlic">' + esc(m.ingredients.join('\n')) + '</textarea>' +
        (isNew ? '' : '<button class="btn danger small" data-action="meal-del" data-id="' + m.id + '">Delete meal</button>'),
        function () {
          var name = Modal.val('name');
          var ingredients = Modal.val('ingredients').split(/\n|,/).map(function (x) { return x.trim(); }).filter(function (x) { return x; });
          if (!name || !ingredients.length) { alert('Give the meal a name and at least one ingredient.'); return false; }
          if (isNew) Store.data.meals.push({ id: uid(), name: name, ingredients: ingredients });
          else { m.name = name; m.ingredients = ingredients; }
          Store.save('meals');
          Apps.groceries.view = 'meals';
        });
    },
    actions: {
      'groc-view': function (el) { Apps.groceries.view = el.getAttribute('data-v'); },
      'groc-add': function () {
        var el = $('groc-input');
        Apps.groceries.addOne(el.value);
        el.value = '';
      },
      'groc-quick': function (el) { Apps.groceries.addOne(el.getAttribute('data-name')); },
      'groc-more': function (el) {
        var id = el.getAttribute('data-id');
        groc().items.forEach(function (i) { if (i.id === id) i.qty++; });
        Store.save('groceries');
      },
      'groc-less': function (el) {
        var id = el.getAttribute('data-id');
        groc().items.forEach(function (i) { if (i.id === id && i.qty > 1) i.qty--; });
        Store.save('groceries');
      },
      'groc-tick': function (el) {
        var id = el.getAttribute('data-id'), g = groc(), removed = null, at = -1;
        for (var i = 0; i < g.items.length; i++) if (g.items[i].id === id) { removed = g.items[i]; at = i; }
        if (!removed) return;
        g.items.splice(at, 1);
        bumpHistory(removed.name);
        Store.save('groceries');
        Toast.show('Got ' + removed.name + qtyLabel(removed), function () {
          if (onList(removed.name)) return;
          groc().items.push(removed);
          Store.save('groceries');
        });
      },
      'meal-new': function () { Apps.groceries.mealEditor(null); },
      'meal-edit': function (el) { var m = findMeal(el.getAttribute('data-id')); if (m) Apps.groceries.mealEditor(m); },
      'meal-del': function (el) {
        var id = el.getAttribute('data-id'), m = findMeal(id);
        if (!m || !confirm('Delete the meal “' + m.name + '”?')) return;
        Store.data.meals = Store.data.meals.filter(function (x) { return x.id !== id; });
        Store.save('meals');
        Modal.close();
      },
      'meal-add': function (el) {
        var m = findMeal(el.getAttribute('data-id'));
        if (!m) return;
        var bumped = 0;
        Apps.groceries.undoable('', function () {
          m.ingredients.forEach(function (x) { if (Apps.groceries.add(x, m.name).qty > 1) bumped++; });
        });
        var n = m.ingredients.length;
        Toast.show('Added ' + n + ' item' + (n > 1 ? 's' : '') + ' for ' + m.name + (bumped ? ' (' + bumped + ' already on the list, now ×2+)' : ''), Toast.undo);
      }
    }
  };

  // ---- To-do -------------------------------------------------------------
  Apps.todo = {
    title: 'To-Do',
    filter: 'all',
    headerActions: '<button class="btn small" data-action="todo-clear">Clear done</button>',
    shell: function () {
      return '<div class="tabs flex" id="todo-tabs"></div>' +
        '<form class="add-row flex" data-form="todo-add"><input class="field grow" id="todo-input" placeholder="Add a task…" autocomplete="off">' +
        '<button class="btn primary" type="submit">Add</button></form><div id="todo-list"></div>';
    },
    render: function () {
      var f = this.filter, today = dayKey();
      $('todo-tabs').innerHTML = [['all', 'Everyone'], ['jess', 'Jess'], ['graham', 'Graham'], ['both', 'Together']].map(function (t) {
        return '<button class="tab grow' + (t[0] === f ? ' active' : '') + '" data-action="todo-filter" data-f="' + t[0] + '">' + t[1] + '</button>';
      }).join('');
      var todos = Store.data.todos.filter(function (t) { return f === 'all' || t.who === f; });
      var open = todos.filter(function (t) { return !t.done; }).sort(function (a, b) {
        return (a.due || '9999') < (b.due || '9999') ? -1 : (a.due || '9999') > (b.due || '9999') ? 1 : a.created - b.created;
      });
      var done = todos.filter(function (t) { return t.done; }).sort(function (a, b) { return b.doneAt - a.doneAt; });
      function row(t) {
        var late = !t.done && t.due && t.due < today;
        return '<div class="row flex center' + (t.done ? ' done' : '') + '" data-action="todo-toggle" data-id="' + t.id + '">' +
          '<div class="check">' + (t.done ? '✓' : '') + '</div><div class="grow text"><div>' + esc(t.text) + '</div>' +
          '<div class="meta">' + whoTag(t.who) + (t.due ? '<span class="' + (late ? 'overdue' : '') + '">' + (late ? 'Overdue · ' : 'Due ') + fmtDayShort(t.due) + '</span>' : '') + '</div></div>' +
          (t.done ? '' : '<button class="btn small home-toggle' + (t.home === false ? '' : ' on') + '" data-action="todo-home" data-id="' + t.id + '" title="Show on the home screen">' + (t.home === false ? '📋 List only' : '🏠 Home') + '</button>') +
          '<button class="btn small" data-action="todo-edit" data-id="' + t.id + '">Edit</button>' +
          '<button class="del" data-action="todo-del" data-id="' + t.id + '">✕</button></div>';
      }
      var h = '<div class="list">' + (open.length ? open.map(row).join('') : '<div class="list-empty">All done! 🎉</div>') + '</div>';
      if (done.length) h += '<div class="section-label">Done</div><div class="list">' + done.slice(0, 30).map(row).join('') + '</div>';
      $('todo-list').innerHTML = h;
    },
    editor: function (t) {
      var isNew = !t.id;
      Modal.open(isNew ? 'New task' : 'Edit task',
        '<input class="field" name="text" placeholder="Task" value="' + esc(t.text || '') + '">' +
        '<label class="lbl">Who</label>' + segHtml('who', WHO_OPTS, t.who || 'both') +
        '<label class="lbl">Due date (optional)</label><input class="field" type="date" name="due" value="' + esc(t.due || '') + '">' +
        '<label class="lbl">Show it</label>' + segHtml('home', [['yes', '🏠 On the home screen'], ['no', '📋 Only in the list']], t.home === false ? 'no' : 'yes'),
        function () {
          var text = Modal.val('text');
          if (!text) return false;
          t.text = text; t.who = Modal.seg('who'); t.due = Modal.val('due'); t.home = Modal.seg('home') !== 'no';
          if (isNew) { t.id = uid(); t.created = Date.now(); t.done = false; Store.data.todos.push(t); }
          Store.save('todos');
        });
    },
    find: function (id) { for (var i = 0; i < Store.data.todos.length; i++) if (Store.data.todos[i].id === id) return Store.data.todos[i]; return null; },
    actions: {
      'todo-filter': function (el) { Apps.todo.filter = el.getAttribute('data-f'); },
      'todo-add': function () {
        var el = $('todo-input'), text = el.value.trim();
        el.value = ''; el.blur();
        var f = Apps.todo.filter;
        Apps.todo.editor({ text: text, who: f === 'all' ? 'both' : f });
      },
      'todo-home': function (el) {
        var t = Apps.todo.find(el.getAttribute('data-id'));
        if (!t) return;
        t.home = t.home === false;
        Store.save('todos');
        Toast.show(t.home ? 'Shown on the home screen' : 'Now only in the list');
      },
      'todo-edit': function (el) { var t = Apps.todo.find(el.getAttribute('data-id')); if (t) Apps.todo.editor(t); },
      'todo-toggle': function (el) {
        var t = Apps.todo.find(el.getAttribute('data-id'));
        if (!t) return;
        t.done = !t.done; t.doneAt = t.done ? Date.now() : null;
        Store.save('todos');
      },
      'todo-del': function (el) {
        var id = el.getAttribute('data-id');
        Store.data.todos = Store.data.todos.filter(function (t) { return t.id !== id; });
        Store.save('todos');
      },
      'todo-clear': function () {
        Store.data.todos = Store.data.todos.filter(function (t) { return !t.done; });
        Store.save('todos');
      }
    }
  };

  // ---- Weather forecast -----------------------------------------------------
  function compass(deg) { return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(((deg || 0) % 360) / 45) % 8]; }
  Apps.weather = {
    title: 'Weather',
    headerActions: '<button class="btn small" data-action="weather-refresh">↻</button>',
    enter: function () { if (!Weather.data || Date.now() - (Weather.data.at || 0) > 10 * 60000) Weather.pull(); },
    shell: function () { return '<div id="wx"></div>'; },
    render: function () {
      var d = Weather.data, box = $('wx');
      if (!box) return;
      if (!d) { box.innerHTML = '<div class="list"><div class="list-empty">' + (Weather.error || 'Loading…') + '</div></div>'; return; }
      var c = d.current, now = wmo(c.weather_code, c.is_day), dl = d.daily, loc = Store.data.settings.weather.name;
      var sunrise = parseISO(dl.sunrise[0]), sunset = parseISO(dl.sunset[0]);
      // Current conditions
      var h = '<div class="wx-now">' +
        '<div class="wx-place muted">' + esc(loc) + '</div>' +
        '<div class="flex center" style="-webkit-box-pack:center;-webkit-justify-content:center;justify-content:center">' +
        '<span class="wx-icon">' + now.icon + '</span><span class="wx-temp">' + Math.round(c.temperature_2m) + '°</span></div>' +
        '<div class="wx-cond">' + now.text + '</div>' +
        '<div class="muted">H ' + Math.round(dl.temperature_2m_max[0]) + '° · L ' + Math.round(dl.temperature_2m_min[0]) + '° · Feels like ' + Math.round(c.apparent_temperature) + '°</div>' +
        (this.rain() ? '<div class="w-rain" style="margin-top:6px">☔ ' + this.rain() + '</div>' : '') +
        '</div>';
      // Details grid
      var tiles = [
        ['💨', 'Wind', Math.round(c.wind_speed_10m) + ' km/h ' + compass(c.wind_direction_10m), 'Gusts ' + Math.round(c.wind_gusts_10m) + ' km/h'],
        ['💧', 'Humidity', Math.round(c.relative_humidity_2m) + '%', ''],
        ['🌂', 'Rain today', (dl.precipitation_sum[0] || 0).toFixed(1) + ' mm', (dl.precipitation_probability_max[0] || 0) + '% chance'],
        ['☀️', 'UV index', Math.round(dl.uv_index_max[0] || 0), uvLabel(dl.uv_index_max[0])],
        ['🌅', 'Sunrise', fmtTime(sunrise), ''],
        ['🌇', 'Sunset', fmtTime(sunset), '']
      ];
      h += '<div class="wx-tiles flex wrap">' + tiles.map(function (t) {
        return '<div class="wx-tile"><div class="muted small">' + t[0] + ' ' + t[1] + '</div><div class="wx-val">' + t[2] + '</div>' + (t[3] ? '<div class="muted small">' + t[3] + '</div>' : '') + '</div>';
      }).join('') + '</div>';
      // Next 24 hours
      var hr = d.hourly, start = 0, nowT = new Date();
      for (var i = 0; i < hr.time.length; i++) { if (parseISO(hr.time[i]) > new Date(nowT.getTime() - 3600000)) { start = i; break; } }
      h += '<div class="section-label">Next 24 hours</div><div class="wx-hours">';
      for (var j = start; j < Math.min(start + 24, hr.time.length); j++) {
        var at = parseISO(hr.time[j]), w = wmo(hr.weather_code[j], hr.is_day[j]);
        h += '<div class="wx-hour"><div class="muted small">' + (j === start ? 'Now' : pad(at.getHours())) + '</div><div class="wx-hicon">' + w.icon + '</div>' +
          '<div class="wx-htemp">' + Math.round(hr.temperature_2m[j]) + '°</div><div class="wx-hrain">' + (hr.precipitation_probability[j] >= 10 ? hr.precipitation_probability[j] + '%' : '&nbsp;') + '</div></div>';
      }
      h += '</div>';
      // 14 days, with a bar showing each day's range against the fortnight's lows/highs
      var lo = Math.min.apply(null, dl.temperature_2m_min), hi = Math.max.apply(null, dl.temperature_2m_max), span = Math.max(1, hi - lo);
      h += '<div class="section-label">14-day forecast</div><div class="list">';
      for (var k = 0; k < dl.time.length; k++) {
        var day = parseDay(dl.time[k]), dw = wmo(dl.weather_code[k], 1), mn = dl.temperature_2m_min[k], mx = dl.temperature_2m_max[k];
        var label = k === 0 ? 'Today' : k === 1 ? 'Tomorrow' : DAYS[day.getDay()].slice(0, 3) + ' ' + day.getDate() + ' ' + MONTHS[day.getMonth()].slice(0, 3);
        h += '<div class="row flex center wx-day">' +
          '<div class="wx-dname">' + label + '</div>' +
          '<div class="wx-dicon" title="' + dw.text + '">' + dw.icon + '</div>' +
          '<div class="wx-drain">' + ((dl.precipitation_probability_max[k] || 0) >= 10 ? '💧' + dl.precipitation_probability_max[k] + '%' : '') + '</div>' +
          '<div class="wx-dmin muted">' + Math.round(mn) + '°</div>' +
          '<div class="wx-range grow"><div style="margin-left:' + Math.round(100 * (mn - lo) / span) + '%;width:' + Math.max(4, Math.round(100 * (mx - mn) / span)) + '%"></div></div>' +
          '<div class="wx-dmax">' + Math.round(mx) + '°</div></div>';
      }
      h += '</div><p class="muted small">Forecast by Open-Meteo · updated ' + fmtTime(new Date(d.at || Date.now())) + '. Change the town in ⚙️ Settings.</p>';
      box.innerHTML = h;
    },
    rain: function () { return Weather.rainSoon(); },
    actions: {
      'weather-refresh': function () { Weather.pull(); Toast.show('Updating the forecast…'); }
    }
  };
  function uvLabel(uv) { uv = uv || 0; return uv < 3 ? 'Low' : uv < 6 ? 'Moderate' : uv < 8 ? 'High' : uv < 11 ? 'Very high' : 'Extreme'; }

  // ---- Cameras ---------------------------------------------------------------
  // Modern browsers (phones, newer iPads) can run go2rtc's own player, which
  // picks the best format (WebRTC/MSE/HLS). Old iPads get plain HLS video.
  // Opens the Ring app (Android: straight in; iPhone/iPad: via the App Store page, which shows "Open").
  function ringAppLink() {
    if (/Android/i.test(navigator.userAgent)) {
      return 'intent://#Intent;package=com.ringapp;S.browser_fallback_url=' + encodeURIComponent('https://play.google.com/store/apps/details?id=com.ringapp') + ';end';
    }
    return 'https://apps.apple.com/app/id926252661';
  }
  var MODERN = (function () { try { return !!new Function('return async () => ({ ...{} })?.x'); } catch (e) { return false; } })();
  function cameras() {
    return Store.data.settings.cameras.map(function (c, i) {
      var cam = { id: i, name: c.name, type: c.type || 'mjpeg', url: c.url, refreshSeconds: c.refreshSeconds || 2 };
      var w = Store.data.settings.google; // the House Hub worker (also used for Google)
      if (cam.type === 'tuya') { cam.deviceId = c.deviceId; }
      if (cam.type === 'ring') {
        cam.deviceId = c.deviceId;
        cam.url = w.url + '/ring/snapshot/' + encodeURIComponent(c.deviceId) + '?token=' + encodeURIComponent(w.token);
        cam.refreshSeconds = 30;
      }
      if (cam.type === 'go2rtc') {
        var base = (c.server || '').replace(/\/+$/, ''), src = encodeURIComponent(c.stream || '');
        cam.server = base;
        if (MODERN) { cam.type = 'iframe'; cam.url = base + '/stream.html?src=' + src + '&mode=webrtc,mse,hls,mjpeg'; }
        else { cam.type = 'hls'; cam.url = base + '/api/stream.m3u8?src=' + src; }
      }
      return cam;
    });
  }
  function blockedCameraServer() {
    if (location.protocol !== 'https:') return '';
    var cams = cameras();
    for (var i = 0; i < cams.length; i++) if (/^http:/i.test(cams[i].url)) return cams[i].server || cams[i].url.replace(/^(http:\/\/[^\/]+).*$/i, '$1');
    return '';
  }
  // Streams only run while this screen is open (saves Wi-Fi and Ring battery).
  Apps.cameras = {
    title: 'Cameras',
    timers: [],
    headerActions: '<button class="btn small" data-action="cam-reload">Reload</button>',
    shell: function () {
      var cams = cameras();
      if (!cams.length) {
        return '<div class="list"><div class="list-empty">No cameras set up yet.<br><br><button class="btn primary" data-action="open" data-app="settings">Open Settings</button></div></div>';
      }
      var h = '', blocked = blockedCameraServer();
      if (blocked) {
        h += '<div class="notif warn flex center" style="margin-bottom:16px"><div class="icon">⚠️</div><div class="body grow">' +
          '<div class="title">Cameras may not play on this version</div>' +
          '<div class="sub">This copy of House Hub is https, and most browsers block http:// cameras inside it. At home, open House Hub from your camera box instead.</div></div>' +
          '<a class="btn primary small" href="' + esc(blocked) + '/" target="_blank">Open home version</a></div>';
      }
      h += '<div class="cams flex wrap">';
      cams.forEach(function (c) {
        h += '<div class="cam"><div class="cam-inner" data-action="cam-full" data-id="' + c.id + '">' + Apps.cameras.media(c) +
          '<div class="cam-name flex between"><span>' + esc(c.name) + '</span><span>⤢</span></div></div></div>';
      });
      return h + '</div><p class="muted small">Tap a camera for full screen. Streams stop when you leave this screen. Ring shows its latest snapshot (refreshed every 30s); use the button for live view.</p>';
    },
    media: function (c, full) {
      var u = esc(c.url);
      if (c.type === 'tuya') return '<video class="cam-media" data-cam="' + c.id + '" data-tuya="' + esc(c.deviceId) + '" autoplay muted playsinline webkit-playsinline></video>';
      if (c.type === 'ring') {
        return '<img class="cam-media" data-cam="' + c.id + '" data-src="' + u + '" alt="">' +
          '<a class="btn primary small ring-live" data-action="ext-link" href="' + esc(ringAppLink()) + '" target="_blank">▶ Live view in Ring app</a>' +
          '<div class="cam-age" data-age="' + c.id + '">Latest snapshot</div>';
      }
      if (c.type === 'hls') return '<video class="cam-media" data-cam="' + c.id + '" src="' + u + '" autoplay muted playsinline webkit-playsinline></video>';
      if (c.type === 'iframe') return '<iframe class="cam-media" data-cam="' + c.id + '" src="' + u + '" frameborder="0" style="height:' + (full ? '100%' : '300px') + '"></iframe>';
      // mjpeg & snapshot both use <img>; snapshot is refreshed on a timer.
      return '<img class="cam-media" data-cam="' + c.id + '" data-src="' + u + '" alt="">';
    },
    start: function (root) {
      var self = this;
      this.timers.forEach(clearInterval);
      this.timers = [];
      function showError(el, text) {
        if (!el.parentNode || el.parentNode.querySelector('.cam-err')) return;
        var e = document.createElement('div');
        e.className = 'cam-err';
        e.textContent = text;
        el.parentNode.appendChild(e);
      }
      // Tuya/LSC: ask the worker for a fresh live-stream link (they expire).
      var vids = root.querySelectorAll('video[data-tuya]');
      for (var v = 0; v < vids.length; v++) (function (video) {
        Store.googleCall('GET', '/tuya/stream/' + encodeURIComponent(video.getAttribute('data-tuya')), null, function (err, res) {
          if (err || !res || !res.url) return showError(video, 'Couldn\u2019t start the stream: ' + (err ? err.message : 'no link') + ' – tap Reload');
          video.onerror = function () { showError(video, 'Stream stopped or this device can\u2019t play it – tap Reload'); };
          video.src = res.url;
          try { var pr = video.play(); if (pr && pr.catch) pr.catch(function () { /* shown by onerror, or autoplay needs a tap */ }); } catch (e) { /* old Safari */ }
        });
      })(vids[v]);
      var imgs = root.querySelectorAll('img.cam-media');
      for (var i = 0; i < imgs.length; i++) (function (img) {
        var cam = cameras()[+img.getAttribute('data-cam')];
        var base = img.getAttribute('data-src');
        function bust() { return base + (base.indexOf('?') < 0 ? '?' : '&') + '_=' + Date.now(); }
        img.onerror = function () {
          if (!img.parentNode || img.parentNode.querySelector('.cam-err')) return;
          var e = document.createElement('div');
          e.className = 'cam-err';
          e.textContent = location.protocol === 'https:' && /^http:/.test(base)
            ? 'Can\u2019t load – this browser blocks http:// cameras on an https page (see README)'
            : 'Camera offline – tap Reload';
          img.parentNode.appendChild(e);
        };
        var age = root.querySelector('[data-age="' + img.getAttribute('data-cam') + '"]');
        function loaded() { if (age) age.textContent = 'Snapshot checked ' + fmtTime(new Date()); }
        img.onload = loaded;
        img.src = bust();
        if (cam && (cam.type === 'snapshot' || cam.type === 'ring')) {
          self.timers.push(setInterval(function () {
            var next = new Image();
            next.onload = function () { img.src = next.src; loaded(); };
            next.src = bust();
          }, (cam.refreshSeconds || 2) * 1000));
        }
      })(imgs[i]);
    },
    stop: function () {
      this.timers.forEach(clearInterval);
      this.timers = [];
      // Blanking the src closes MJPEG connections; pausing stops HLS.
      var media = document.querySelectorAll('.cam-media');
      for (var i = 0; i < media.length; i++) {
        if (media[i].tagName === 'IMG') { media[i].onerror = null; media[i].src = 'data:image/gif;base64,R0lGODlhAQABAAAAACw='; }
        else if (media[i].tagName === 'VIDEO') { media[i].pause(); media[i].removeAttribute('src'); media[i].load(); }
        else media[i].src = 'about:blank';
      }
      var full = document.querySelector('.cam-full');
      if (full) full.parentNode.removeChild(full);
    },
    enter: function () { var self = this; setTimeout(function () { self.start($('panel-body')); }, 0); },
    leave: function () { this.stop(); },
    render: function () { /* static */ },
    actions: {
      'cam-reload': function () { $('panel-body').innerHTML = Apps.cameras.shell(); Apps.cameras.start($('panel-body')); },
      'cam-full': function (el) {
        var c = cameras()[+el.getAttribute('data-id')];
        Apps.cameras.stop();
        var div = document.createElement('div');
        div.className = 'cam-full';
        div.innerHTML = Apps.cameras.media(c, true) + '<button class="close" data-action="cam-close">✕</button>';
        document.body.appendChild(div);
        Apps.cameras.start(div);
      },
      'cam-close': function () { Apps.cameras.actions['cam-reload'](); }
    }
  };

  // ---- Daily checklists ---------------------------------------------------
  // The three people shown on the home screen.
  var LISTS = [['jess', 'Jess'], ['graham', 'Graham'], ['both', 'Together']];

  // ---- Settings ---------------------------------------------------------------
  function randomKey() {
    var chars = 'abcdefghijkmnpqrstuvwxyz23456789', out = '';
    var buf = window.crypto && window.crypto.getRandomValues ? window.crypto.getRandomValues(new Uint8Array(24)) : null;
    for (var i = 0; i < 24; i++) out += chars[(buf ? buf[i] : Math.floor(Math.random() * 256)) % chars.length];
    return out;
  }
  function joinLink() {
    if (!Store.sync) return '';
    return location.href.split('#')[0] + '#join=' + encodeURIComponent(JSON.stringify(Store.sync));
  }
  var COLORS = [['#4f8cff', 'Blue'], ['#e86fa8', 'Pink'], ['#3fbf7f', 'Green'], ['#f5a623', 'Orange'], ['#7b61ff', 'Purple']];
  function colorSelect(id) {
    return '<select class="field" id="' + id + '">' + COLORS.map(function (c) { return '<option value="' + c[0] + '">' + c[1] + '</option>'; }).join('') + '</select>';
  }

  Apps.settings = {
    title: 'Settings',
    shell: function () {
      var sync = Store.sync || {}, s = Store.data.settings, dev = Device.get();
      return '' +
        '<div class="section-label">Sync between devices</div>' +
        '<div class="list" style="padding:16px">' +
        '<p class="muted small" style="margin-top:0">Optional. Without it, everything is saved on this device only. Set up a free Firebase Realtime Database (see README), paste its URL, make a household key, then send the setup link to your other devices.</p>' +
        '<label class="lbl">Firebase database URL</label><input class="field" id="set-db" placeholder="https://your-project-default-rtdb.europe-west1.firebasedatabase.app" value="' + esc(sync.db || '') + '" autocapitalize="off" autocorrect="off">' +
        '<label class="lbl" style="margin-top:12px">Household key (acts as your password – keep it secret)</label>' +
        '<div class="flex"><input class="field grow" id="set-key" value="' + esc(sync.key || '') + '" autocapitalize="off" autocorrect="off" style="margin-right:10px">' +
        '<button class="btn" data-action="set-genkey">New key</button></div>' +
        '<div class="flex wrap" style="margin-top:14px"><button class="btn primary" data-action="set-sync" style="margin:0 10px 10px 0">Save &amp; connect</button>' +
        '<button class="btn" data-action="set-share" style="margin:0 10px 10px 0">Share setup link</button>' +
        '<button class="btn danger" data-action="set-unsync" style="margin:0 10px 10px 0">Stop syncing</button></div>' +
        '<div id="set-status" class="small"></div>' +
        '<textarea class="field hidden" id="set-link" rows="3" readonly style="margin-top:10px;font-size:14px"></textarea>' +
        '<label class="lbl" style="margin-top:14px">Got a setup link? Paste it here</label>' +
        '<div class="flex"><input class="field grow" id="set-paste" placeholder="https://…#join=…" autocapitalize="off" autocorrect="off" style="margin-right:10px">' +
        '<button class="btn" data-action="set-paste">Connect</button></div>' +
        '</div>' +

        '<div class="section-label">Home screen</div>' +
        '<div class="list" style="padding:16px">' +
        '<label class="lbl">Title</label><div class="flex"><input class="field grow" id="set-title" value="' + esc(s.title) + '" style="margin-right:10px"><button class="btn" data-action="set-title">Save</button></div>' +
        '<label class="lbl" style="margin-top:12px">Weather location</label><div class="flex"><input class="field grow" id="set-weather" value="' + esc(s.weather.name) + '" placeholder="Veldhoven" style="margin-right:10px"><button class="btn" data-action="set-weather">Save</button></div>' +
        '<div id="weather-status" class="small muted" style="margin-top:6px"></div>' +
        '<div class="row flex center" data-action="set-wall" style="padding:14px 0 0;border:0;min-height:0"><div class="check' + (dev.wall ? ' on' : '') + '" id="set-wall-check">' + (dev.wall ? '✓' : '') + '</div>' +
        '<div class="text grow">This device is the wall display<div class="meta">Goes back home after 3 idle minutes and dims 23:00–06:00. Only affects this device.</div></div></div>' +
        '</div>' +

        '<div class="section-label">House Hub worker (Google Calendar &amp; cameras)</div>' +
        '<div class="list" style="padding:16px">' +
        '<p class="muted small" style="margin-top:0">Your free Cloudflare Worker (see README). It does two-way Google Calendar sync and fetches the Ring and LSC/Tuya cameras from the cloud – nothing needs to stay on at home.</p>' +
        '<label class="lbl">Worker URL</label><input class="field" id="g-url" placeholder="https://house-hub.yourname.workers.dev" value="' + esc(s.google.url) + '" autocapitalize="off" autocorrect="off">' +
        '<label class="lbl" style="margin-top:10px">Access token (HUB_TOKEN)</label><input class="field" id="g-token" type="password" value="' + esc(s.google.token) + '" autocapitalize="off" autocorrect="off">' +
        '<div class="flex wrap" style="margin-top:12px"><button class="btn primary" data-action="set-google" style="margin:0 10px 10px 0">Save &amp; test</button>' +
        '<button class="btn danger" data-action="set-google-off" style="margin:0 10px 10px 0">Disconnect</button></div>' +
        '<div id="g-status" class="small"></div>' +
        '</div>' +

        '<div class="section-label">Bin collection (Mijn Afvalwijzer)</div>' +
        '<div class="list" style="padding:16px">' +
        '<p class="muted small" style="margin-top:0">Shows your bin days in the calendar, and a reminder on the home screen from noon the day before. Uses the House Hub worker.</p>' +
        '<div class="flex">' +
        '<div class="grow" style="margin-right:10px"><label class="lbl">Postcode</label><input class="field" id="bin-pc" placeholder="1234AB" value="' + esc(s.bins.postcode) + '" autocapitalize="characters" autocorrect="off"></div>' +
        '<div style="width:110px;margin-right:10px"><label class="lbl">Number</label><input class="field" id="bin-nr" inputmode="numeric" value="' + esc(s.bins.number) + '"></div>' +
        '<div style="width:90px"><label class="lbl">Suffix</label><input class="field" id="bin-sx" placeholder="A" value="' + esc(s.bins.suffix) + '" autocorrect="off"></div>' +
        '</div>' +
        '<div class="flex wrap" style="margin-top:12px"><button class="btn primary" data-action="set-bins" style="margin:0 10px 10px 0">Save &amp; test</button>' +
        '<button class="btn danger" data-action="set-bins-off" style="margin:0 10px 10px 0">Remove</button></div>' +
        '<div id="bin-status" class="small"></div>' +
        '</div>' +

        '<div class="section-label">Other calendars (.ics feeds, read-only)</div>' +
        '<div id="set-cals"></div>' +
        '<form class="list" style="padding:16px" data-form="set-addcal">' +
        '<label class="lbl">Name</label><input class="field" id="cal-name" placeholder="Family">' +
        '<label class="lbl" style="margin-top:10px">Secret iCal address (Google: Settings → Integrate calendar)</label><input class="field" id="cal-url" placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" autocapitalize="off" autocorrect="off">' +
        '<label class="lbl" style="margin-top:10px">Colour</label>' + colorSelect('cal-color') +
        '<button class="btn primary" type="submit" style="margin-top:12px">Add calendar</button>' +
        '<label class="lbl" style="margin-top:18px">CORS proxy (leave blank to use the House Hub worker above)</label>' +
        '<div class="flex"><input class="field grow" id="set-proxy" placeholder="https://my-proxy.workers.dev/?url=" value="' + esc(s.corsProxy) + '" autocapitalize="off" autocorrect="off" style="margin-right:10px">' +
        '<button class="btn" type="button" data-action="set-proxy">Save</button></div>' +
        '</form>' +

        '<div class="section-label">Cameras</div>' +
        '<div id="set-cams"></div>' +
        '<form class="list" style="padding:16px" data-form="set-addcam">' +
        '<label class="lbl">Name</label><input class="field" id="cam-name" placeholder="Front door (Ring)">' +
        '<label class="lbl" style="margin-top:10px">Type</label><select class="field" id="cam-type">' +
        '<option value="tuya">LSC / Tuya camera – live, via the worker</option>' +
        '<option value="ring">Ring doorbell / camera – snapshots, via the worker</option>' +
        '<option value="go2rtc">go2rtc camera (needs a box at home)</option>' +
        '<option value="mjpeg">MJPEG stream URL</option><option value="hls">HLS video URL (.m3u8)</option>' +
        '<option value="snapshot">Snapshot image URL, refreshed every 2s</option><option value="iframe">Web page URL</option></select>' +
        '<div id="cam-tuya-fields">' +
        '<label class="lbl" style="margin-top:10px">Tuya device ID (Tuya IoT platform → your project → Devices)</label><input class="field" id="cam-device" placeholder="bf1234567890abcdef" autocapitalize="off" autocorrect="off">' +
        '</div>' +
        '<div id="cam-ring-fields" class="hidden">' +
        '<p class="muted small">Log in to Ring once. Your password goes only to your own worker, which keeps the login refreshed.</p>' +
        '<label class="lbl">Ring email</label><input class="field" id="ring-email" type="email" autocapitalize="off" autocorrect="off">' +
        '<label class="lbl" style="margin-top:10px">Ring password</label><input class="field" id="ring-pass" type="password">' +
        '<div id="ring-code-row" class="hidden"><label class="lbl" style="margin-top:10px" id="ring-code-lbl">Code</label><input class="field" id="ring-code" inputmode="numeric" autocomplete="one-time-code"></div>' +
        '<button class="btn" type="button" data-action="ring-login" style="margin-top:12px">Log in to Ring</button>' +
        '<div id="ring-devs" style="margin-top:12px"></div>' +
        '</div>' +
        '<div id="cam-go2rtc-fields" class="hidden">' +
        '<label class="lbl" style="margin-top:10px">go2rtc address</label><input class="field" id="cam-server" placeholder="http://192.168.1.10:1984" autocapitalize="off" autocorrect="off">' +
        '<label class="lbl" style="margin-top:10px">Stream name (as in go2rtc.yaml)</label><input class="field" id="cam-stream" placeholder="ring_doorbell" autocapitalize="off" autocorrect="off">' +
        '</div>' +
        '<div id="cam-url-fields" class="hidden"><label class="lbl" style="margin-top:10px">Stream URL</label><input class="field" id="cam-url" placeholder="http://192.168.1.10:1984/api/stream.mjpeg?src=garage" autocapitalize="off" autocorrect="off"></div>' +
        '<button class="btn primary" type="submit" style="margin-top:12px" id="cam-submit">Add camera</button>' +
        '</form>';
    },
    ringDevices: function () {
      var box = $('ring-devs');
      box.innerHTML = '<span class="muted small">Finding your Ring devices…</span>';
      Store.googleCall('GET', '/ring/devices', null, function (err, res) {
        if (err) { box.innerHTML = '<span class="small overdue">' + esc(err.message) + '</span>'; return; }
        var have = Store.data.settings.cameras.map(function (c) { return c.type === 'ring' ? c.deviceId : null; });
        box.innerHTML = (res.devices || []).length ? res.devices.map(function (d) {
          var added = have.indexOf(d.id) >= 0;
          return '<div class="flex center between" style="margin-bottom:8px"><span>🔔 ' + esc(d.name) + (d.battery != null ? ' <span class="muted small">(battery ' + d.battery + '%)</span>' : '') + '</span>' +
            (added ? '<span class="muted small">✓ Added</span>' : '<button class="btn primary small" type="button" data-action="ring-add" data-id="' + esc(d.id) + '" data-name="' + esc(d.name) + '">Add</button>') + '</div>';
        }).join('') : '<span class="muted small">No Ring devices found on this account.</span>';
      });
    },
    render: function () {
      var st = $('set-status');
      if (!st) return;
      if (!Store.sync) { st.className = 'small muted'; st.textContent = 'Not syncing – data stays on this device.'; }
      else if (Store.online) { st.className = 'small sync ok'; st.textContent = '● Connected – changes sync to every device with this key.'; }
      else { st.className = 'small sync bad'; st.textContent = '● Can’t reach the database. Check the URL and the database rules (see README).'; }

      var s = Store.data.settings;
      $('set-cals').innerHTML = s.calendars.length ? '<div class="list">' + s.calendars.map(function (c, i) {
        return '<div class="row flex center"><span class="dot" style="width:16px;height:16px;border-radius:8px;background:' + esc(c.color) + '"></span>' +
          '<div class="text grow">' + esc(c.name) + '<div class="meta">' + esc(c.url) + '</div></div>' +
          '<button class="del" data-action="set-delcal" data-i="' + i + '">✕</button></div>';
      }).join('') + '</div>' : '';
      if (Store.calendar.errors.length) $('set-cals').innerHTML += '<p class="small overdue">' + esc(Store.calendar.errors.join(' · ')) + '</p>';
      var bs = $('bin-status'), B = Store.bins;
      if (B.status === 'off') { bs.className = 'small muted'; bs.textContent = Store.workerOn() ? 'Not set up.' : 'Set up the House Hub worker first.'; }
      else if (B.status === 'error') { bs.className = 'small sync bad'; bs.textContent = '● ' + B.error; }
      else if (B.status === 'checking') { bs.className = 'small muted'; bs.textContent = 'Checking…'; }
      else {
        var todayK = dayKey(), next = B.pickups.filter(function (p) { return p.date >= todayK; }).slice(0, 4);
        bs.className = 'small sync ok';
        bs.textContent = next.length ? '● Next: ' + next.map(function (p) { return fmtDayShort(p.date) + ' – ' + binLabel(p); }).join(' · ') : '● Connected, but no upcoming collections found';
      }
      var gs = $('g-status'), G = Store.google;
      if (!Store.workerOn()) { gs.className = 'small muted'; gs.textContent = 'Not connected.'; }
      else if (G.status === 'unavailable') { gs.className = 'small sync ok'; gs.textContent = '● Worker connected (Google Calendar isn\u2019t set up on it yet – cameras can still use it)'; }
      else if (G.status === 'error') { gs.className = 'small sync bad'; gs.textContent = '● ' + G.errors.join('; '); }
      else if (G.status === 'ok') {
        gs.className = 'small sync ' + (G.errors.length ? 'bad' : 'ok');
        if (G.calendars.length) {
          gs.textContent = '● Connected: ' + G.calendars.map(function (c) { return c.name; }).join(', ') + ' (' + G.events.length + ' events)' +
            (G.errors.length ? ' · Problems: ' + G.errors.join('; ') : '');
        } else if (G.errors.length) {
          gs.textContent = '● Worker connected, but Google said no. ' + G.errors.join('; ');
        } else {
          gs.textContent = '● Worker connected, but no calendars – set GOOGLE_CALENDAR_IDS on the worker';
        }
      } else { gs.className = 'small muted'; gs.textContent = 'Checking…'; }
      $('set-cams').innerHTML = s.cameras.length ? '<div class="list">' + s.cameras.map(function (c, i) {
        var detail = c.type === 'go2rtc' ? c.server + ' → ' + c.stream : c.type === 'tuya' || c.type === 'ring' ? 'device ' + c.deviceId : c.url;
        return '<div class="row flex center"><div class="text grow">' + esc(c.name) + '<div class="meta">' + esc(c.type) + ' · ' + esc(detail) + '</div></div>' +
          '<button class="del" data-action="set-delcam" data-i="' + i + '">✕</button></div>';
      }).join('') + '</div>' : '';
    },
    actions: {
      'set-genkey': function () {
        if ($('set-key').value && !confirm('Make a new key? Devices using the old key will stop syncing with this one.')) return;
        $('set-key').value = randomKey();
      },
      'set-sync': function () {
        var db = $('set-db').value.trim().replace(/\/+$/, ''), key = $('set-key').value.trim();
        if (!/^https:\/\/.+/.test(db)) return alert('The database URL should start with https://');
        if (key.length < 16) return alert('Use a household key of at least 16 characters (tap “New key”).');
        Store.setSync({ db: db, key: key });
      },
      'set-unsync': function () {
        if (!Store.sync || !confirm('Stop syncing on this device? Your data stays here; other devices are not affected.')) return;
        Store.setSync(null);
        $('set-db').value = ''; $('set-key').value = '';
      },
      'set-share': function () {
        var link = joinLink();
        if (!link) return alert('Save & connect first.');
        if (navigator.share) { navigator.share({ title: 'House Hub setup', text: 'Open this to connect House Hub:', url: link }); return; }
        var t = $('set-link');
        t.className = 'field'; t.value = link; t.focus(); t.select();
        try { document.execCommand('copy'); } catch (e) { /* ignore */ }
      },
      'set-paste': function () {
        var m = /#join=(.+)$/.exec($('set-paste').value.trim());
        var cfg = null;
        try { cfg = m && JSON.parse(decodeURIComponent(m[1])); } catch (e) { /* bad link */ }
        if (!cfg || !cfg.db || !cfg.key) return alert('That doesn\u2019t look like a House Hub setup link.');
        Store.setSync(cfg);
        $('set-db').value = cfg.db; $('set-key').value = cfg.key; $('set-paste').value = '';
      },
      'set-weather': function () {
        var name = $('set-weather').value.trim();
        if (!name) return;
        $('weather-status').textContent = 'Looking up ' + name + '…';
        ajax('GET', 'https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&name=' + encodeURIComponent(name), null, function (err, res) {
          var r = res && res.results && res.results[0];
          if (err || !r) { $('weather-status').textContent = 'Couldn\u2019t find \u201c' + name + '\u201d – try the nearest town.'; return; }
          Store.data.settings.weather = { name: r.name, lat: r.latitude, lon: r.longitude };
          $('set-weather').value = r.name;
          $('weather-status').textContent = '✓ ' + r.name + (r.admin1 ? ', ' + r.admin1 : '') + (r.country ? ', ' + r.country : '');
          Store.save('settings');
        });
      },
      'set-title': function () { Store.data.settings.title = $('set-title').value.trim() || 'Our Home'; Store.save('settings'); },
      'set-google': function () {
        var url = $('g-url').value.trim().replace(/\/+$/, ''), token = $('g-token').value.trim();
        if (!/^https:\/\//.test(url)) return alert('The worker URL should start with https://');
        Store.data.settings.google = { url: url, token: token };
        Store.google.status = 'checking';
        Store.save('settings');
      },
      'set-google-off': function () {
        if (!confirm('Disconnect Google Calendar? Events stay in Google; they just won\u2019t show here.')) return;
        Store.data.settings.google = { url: '', token: '' };
        $('g-url').value = ''; $('g-token').value = '';
        Store.save('settings');
      },
      'set-bins': function () {
        var pc = $('bin-pc').value.replace(/\s+/g, '').toUpperCase(), nr = $('bin-nr').value.trim();
        if (!/^\d{4}[A-Z]{2}$/.test(pc)) return alert('Postcode should look like 1234AB');
        if (!/^\d+$/.test(nr)) return alert('Enter your house number (digits only; letters go in Suffix)');
        if (!Store.workerOn()) return alert('Set up the House Hub worker above first.');
        Store.data.settings.bins = { postcode: pc, number: nr, suffix: $('bin-sx').value.trim() };
        Store.bins.status = 'checking';
        Store.save('settings');
      },
      'set-bins-off': function () {
        Store.data.settings.bins = { postcode: '', number: '', suffix: '' };
        $('bin-pc').value = ''; $('bin-nr').value = ''; $('bin-sx').value = '';
        try { localStorage.removeItem('househub.bins'); } catch (e) { /* ignore */ }
        Store.save('settings');
      },
      'set-proxy': function () { Store.data.settings.corsProxy = $('set-proxy').value.trim(); Store.save('settings'); },
      'set-wall': function () {
        var d = Device.get(); d.wall = !d.wall; Device.set(d);
        $('set-wall-check').className = 'check' + (d.wall ? ' on' : '');
        $('set-wall-check').textContent = d.wall ? '✓' : '';
      },
      'set-addcal': function () {
        var url = $('cal-url').value.trim();
        if (!url) return;
        Store.data.settings.calendars.push({ name: $('cal-name').value.trim() || 'Calendar', url: url, color: $('cal-color').value });
        $('cal-name').value = ''; $('cal-url').value = '';
        Store.save('settings');
      },
      'set-delcal': function (el) { Store.data.settings.calendars.splice(+el.getAttribute('data-i'), 1); Store.save('settings'); },
      'set-addcam': function () {
        var type = $('cam-type').value, name = $('cam-name').value.trim() || 'Camera';
        if (type === 'ring') return Apps.settings.actions['ring-login']();
        if ((type === 'tuya') && !Store.workerOn()) return alert('Set up the House Hub worker above first.');
        if (type === 'tuya') {
          var dev = $('cam-device').value.trim();
          if (!dev) return alert('Enter the Tuya device ID.');
          Store.data.settings.cameras.push({ name: name === 'Camera' ? 'Garage' : name, type: 'tuya', deviceId: dev });
          $('cam-device').value = '';
        } else if (type === 'go2rtc') {
          var server = $('cam-server').value.trim().replace(/\/+$/, ''), stream = $('cam-stream').value.trim();
          if (!/^https?:\/\//.test(server) || !stream) return alert('Enter the go2rtc address (e.g. http://192.168.1.10:1984) and the stream name.');
          Store.data.settings.cameras.push({ name: name, type: type, server: server, stream: stream });
          $('cam-stream').value = '';
        } else {
          var url = $('cam-url').value.trim();
          if (!url) return;
          Store.data.settings.cameras.push({ name: name, type: type, url: url });
          $('cam-url').value = '';
        }
        $('cam-name').value = '';
        Store.save('settings');
      },
      'ring-login': function () {
        if (!Store.workerOn()) return alert('Set up the House Hub worker above first.');
        var body = { email: $('ring-email').value.trim(), password: $('ring-pass').value, code: $('ring-code').value.trim() };
        if (!body.email || !body.password) return alert('Enter your Ring email and password.');
        $('ring-devs').innerHTML = '<span class="muted small">Logging in…</span>';
        Store.googleCall('POST', '/ring/login', body, function (err, res) {
          if (err) { $('ring-devs').innerHTML = '<span class="small overdue">' + esc(err.message) + '</span>'; return; }
          if (res.needCode) {
            $('ring-code-row').className = '';
            $('ring-code-lbl').textContent = res.message;
            $('ring-devs').innerHTML = '<span class="muted small">Enter the code, then tap “Log in to Ring” again.</span>';
            $('ring-code').focus();
            return;
          }
          $('ring-pass').value = ''; $('ring-code').value = ''; $('ring-code-row').className = 'hidden';
          Apps.settings.ringDevices();
        });
      },
      'ring-add': function (el) {
        Store.data.settings.cameras.push({ name: el.getAttribute('data-name'), type: 'ring', deviceId: el.getAttribute('data-id') });
        Store.save('settings');
        Apps.settings.ringDevices();
      },
      'set-delcam': function (el) { Store.data.settings.cameras.splice(+el.getAttribute('data-i'), 1); Store.save('settings'); }
    }
  };

  // ------------------------------------------------------------------ home
  function notifications() {
    var out = [], now = new Date(), today = dayKey(now), tomorrow = dayKey(addDays(now, 1));
    var events = allEvents();

    // Ring doorbell: recent presses and low battery.
    Store.ring.devices.forEach(function (d) {
      // Only doorbell presses – motion is too noisy for the home screen.
      var ding = null;
      d.events.forEach(function (e) {
        var at = parseISO(e.at), mins = (now - at) / 60000;
        if (e.kind === 'ding' && mins < 30 && (!ding || at > ding)) ding = at;
      });
      if (ding) out.push({ cls: 'warn', icon: '🔔', app: 'cameras', title: 'Someone rang the doorbell at ' + fmtTime(ding), sub: d.name + ' · tap to see the camera' });
      if (d.battery != null && d.battery <= 20) out.push({ cls: 'warn', icon: '🔋', title: d.name + ' battery is at ' + d.battery + '%', sub: 'Time to charge the Ring doorbell' });
    });

    // Bins: the day before (from noon) and the morning of collection.
    var binsTomorrow = binsOn(tomorrow), binsToday = binsOn(today);
    if (binsToday.length && now.getHours() < 12) {
      out.push({ cls: 'warn', icon: '🗑️', app: 'calendar', title: 'Bin collection today: ' + binsToday.map(binLabel).join(' + '), sub: 'Make sure it\u2019s out at the kerb' });
    }
    if (binsTomorrow.length && now.getHours() >= 12) {
      out.push({ cls: 'warn', icon: '🗑️', app: 'calendar', title: 'Bin day tomorrow: ' + binsTomorrow.map(binLabel).join(' + '), sub: 'Put it out tonight' });
    }

    // Household notes (dismissable).
    Store.data.notes.forEach(function (n) {
      out.push({ cls: 'note', icon: '📝', title: n.text, sub: (WHO[n.who] ? 'From ' + WHO[n.who].label + ' · ' : '') + fmtDayShort(dayKey(new Date(n.at))), dismiss: n.id });
    });

    // Calendar: rest of today, then tomorrow.
    var calEvents = events.filter(function (e) { return !e.bin; }); // bins get their own reminder below
    var todays = eventsOn(calEvents, now).filter(function (e) { return e.allDay || (e.end || e.start) >= now; });
    if (todays.length) {
      out.push({
        cls: '', icon: '📅', app: 'calendar',
        title: todays.length === 1 ? todays[0].title : todays.length + ' things on today',
        sub: todays.slice(0, 4).map(function (e) { return (e.allDay ? 'All day' : fmtTime(e.start)) + ' ' + e.title; }).join(' · ')
      });
    }
    var tom = eventsOn(calEvents, addDays(now, 1));
    if (tom.length) {
      out.push({
        cls: '', icon: '🗓️', app: 'calendar', title: 'Tomorrow: ' + (tom.length === 1 ? tom[0].title : tom.length + ' events'),
        sub: tom.slice(0, 4).map(function (e) { return (e.allDay ? 'All day' : fmtTime(e.start)) + ' ' + e.title; }).join(' · ')
      });
    }

    // To-dos live on the people cards and groceries have a dock badge, so
    // notifications are only for things that pop up.
    return out;
  }

  function renderHome() {
    $('title').textContent = Store.data.settings.title;
    var s = $('sync');
    if (!Store.sync) { s.className = 'sync muted'; s.textContent = 'This device only'; }
    else {
      s.className = 'sync ' + (Store.online ? 'ok' : 'bad');
      s.textContent = Store.online ? (Object.keys(Store.dirty).length ? '● Syncing…' : '● Synced') : '● Offline – saved on this device';
    }

    $('weather').innerHTML = Weather.html();

    // One card per person with their open to-dos (those marked for the home screen).
    var todayK = dayKey(), MAX = 4;
    $('progress').innerHTML = LISTS.map(function (l) {
      var all = Store.data.todos.filter(function (t) { return !t.done && t.who === l[0]; });
      var todos = all.filter(function (t) { return t.home !== false; }).sort(function (a, b) {
        var da = a.due || '9999', db = b.due || '9999';
        return da < db ? -1 : da > db ? 1 : (a.created || 0) - (b.created || 0);
      });
      var hidden = all.length - todos.length;
      var h = '<div class="person grow">' +
        '<div class="person-head flex between center" data-action="open" data-app="todo" data-who="' + l[0] + '">' +
        '<span class="name">' + l[1] + '</span>' +
        '<span class="muted small">' + (all.length ? all.length + ' to-do' + (all.length > 1 ? 's' : '') : '') + ' ›</span></div>' +
        '<div class="person-todos">';
      if (!todos.length) h += '<div class="pt-empty muted small">' + (hidden ? 'Nothing for the home screen' : 'No to-dos 🎉') + '</div>';
      todos.slice(0, MAX).forEach(function (t) {
        var late = t.due && t.due < todayK;
        h += '<div class="pt flex center">' +
          '<button class="pt-check" data-action="home-todo-done" data-id="' + t.id + '" aria-label="Done"></button>' +
          '<div class="pt-text grow" data-action="open" data-app="todo" data-who="' + l[0] + '">' + esc(t.text) +
          (t.due ? ' <span class="pt-due' + (late ? ' overdue' : '') + '">' + (late ? 'overdue' : fmtDayShort(t.due).toLowerCase()) + '</span>' : '') + '</div></div>';
      });
      if (todos.length > MAX) h += '<div class="pt-more small" data-action="open" data-app="todo" data-who="' + l[0] + '">+ ' + (todos.length - MAX) + ' more</div>';
      h += '</div><button class="pt-add small" data-action="home-todo-add" data-who="' + l[0] + '">+ Add to-do</button></div>';
      return h;
    }).join('');

    var list = notifications();
    $('notifications').innerHTML = list.length ? list.map(function (n) {
      return '<div class="notif flex center ' + n.cls + '"' + (n.app ? ' data-action="open" data-app="' + n.app + '"' + (n.who ? ' data-who="' + n.who + '"' : '') : '') + '>' +
        '<div class="icon">' + n.icon + '</div><div class="body grow"><div class="title">' + esc(n.title) + '</div>' +
        (n.sub || n.whoHtml ? '<div class="sub">' + (n.whoHtml || '') + esc(n.sub || '') + '</div>' : '') + '</div>' +
        (n.tick ? '<button class="btn small" data-action="home-todo-done" data-id="' + n.tick + '">✓ Done</button>' : '') +
        (n.dismiss ? '<button class="x" data-action="dismiss-note" data-id="' + n.dismiss + '">✕</button>' : '') + '</div>';
    }).join('') : '<div class="empty-notif">All quiet – nothing needs attention 🌿</div>';

    // Badges on dock buttons.
    var today = dayKey();
    setBadge('calendar', eventsOn(allEvents(), new Date()).length);
    setBadge('groceries', groc().items.filter(function (i) { return !i.done; }).length);
    setBadge('todo', Store.data.todos.filter(function (t) { return !t.done && t.due && t.due <= today; }).length);
  }
  function setBadge(app, n) {
    var b = $('badge-' + app);
    if (!b) return;
    b.textContent = n > 99 ? '99+' : n;
    b.className = 'badge' + (n ? '' : ' hidden');
  }

  function tickClock() {
    var now = new Date();
    $('clock').textContent = fmtTime(now);
    $('date').textContent = fmtDayLong(now);
    $('dim-clock').textContent = fmtTime(now);
  }

  // ------------------------------------------------------------------ navigation
  var current = null;
  function openApp(name, opts) {
    var app = Apps[name];
    if (!app) return;
    if (current && Apps[current].leave) Apps[current].leave();
    current = name;
    if (opts && opts.who && name === 'todo') app.filter = opts.who;
    if (app.enter) app.enter();
    $('panel-title').textContent = app.title;
    $('panel-actions').innerHTML = app.headerActions || '';
    $('panel-body').innerHTML = app.shell();
    $('panel-body').scrollTop = 0;
    app.render();
    $('home').className = 'screen flex col hidden';
    $('panel').className = 'screen flex col';
  }
  function goHome() {
    if (current && Apps[current].leave) Apps[current].leave();
    current = null;
    Modal.close();
    $('panel').className = 'screen flex col hidden';
    $('home').className = 'screen flex col';
    renderHome();
  }
  function rerender() {
    if (current) Apps[current].render(); else renderHome();
  }

  // ------------------------------------------------------------------ events
  document.addEventListener('click', function (e) {
    poke();
    var el = closestAction(e.target);
    if (!el) return;
    var action = el.getAttribute('data-action');
    if (action === 'open') return openApp(el.getAttribute('data-app'), { who: el.getAttribute('data-who') });
    if (action === 'home') return goHome();
    if (action === 'modal-cancel') return Modal.close();
    if (action === 'modal-bg') { if (e.target === el) Modal.close(); return; }
    if (action === 'modal-save') {
      if (Modal.onSave && Modal.onSave() === false) return;
      Modal.close();
      return rerender();
    }
    if (action === 'seg') {
      var opts = el.parentNode.children;
      for (var i = 0; i < opts.length; i++) opts[i].className = opts[i].className.replace(/(^|\s)on(\s|$)/g, ' ').replace(/\s+$/, '');
      el.className += ' on';
      return;
    }
    if (action === 'add-note') {
      return Modal.open('Leave a note',
        '<textarea class="field" name="text" rows="3" placeholder="e.g. Parcel arriving today, please sign"></textarea>' +
        '<label class="lbl">From</label>' + segHtml('who', [['jess', 'Jess'], ['graham', 'Graham'], ['both', 'Us']], 'both'),
        function () {
          var text = Modal.val('text');
          if (!text) return false;
          Store.data.notes.unshift({ id: uid(), text: text, who: Modal.seg('who'), at: Date.now() });
          Store.save('notes');
        }, 'Post');
    }
    if (action === 'home-todo-add') {
      return Apps.todo.editor({ text: '', who: el.getAttribute('data-who') });
    }
    if (action === 'home-todo-done') {
      var tid = el.getAttribute('data-id');
      Store.data.todos.forEach(function (t) {
        if (t.id !== tid) return;
        t.done = true; t.doneAt = Date.now();
        Toast.show('Done: ' + t.text, function () { t.done = false; t.doneAt = null; Store.save('todos'); });
      });
      return Store.save('todos');
    }
    if (action === 'toast-undo') {
      var fn = Toast.undo;
      Toast.hide();
      if (fn) fn();
      return;
    }
    if (action === 'dismiss-note') {
      e.stopPropagation();
      var id = el.getAttribute('data-id');
      Store.data.notes = Store.data.notes.filter(function (n) { return n.id !== id; });
      return Store.save('notes');
    }
    var app = current && Apps[current];
    if (app && app.actions[action]) {
      app.actions[action](el);
      app.render();
    }
  }, false);

  document.addEventListener('change', function (e) {
    if (e.target.id === 'cam-type') {
      var t = e.target.value, url = !/^(tuya|ring|go2rtc)$/.test(t);
      $('cam-tuya-fields').className = t === 'tuya' ? '' : 'hidden';
      $('cam-ring-fields').className = t === 'ring' ? '' : 'hidden';
      $('cam-go2rtc-fields').className = t === 'go2rtc' ? '' : 'hidden';
      $('cam-url-fields').className = url ? '' : 'hidden';
      $('cam-submit').className = t === 'ring' ? 'hidden' : 'btn primary';
    }
  }, false);

  document.addEventListener('submit', function (e) {
    e.preventDefault();
    var form = e.target, name = form.getAttribute('data-form');
    var app = current && Apps[current];
    if (app && app.actions[name]) { app.actions[name](form); app.render(); }
  }, false);

  // ------------------------------------------------------------------ idle & night
  // Wall display only: after a few idle minutes go back to the home screen
  // (also stops camera streams); between 23:00 and 06:00 dim the screen.
  var lastTouch = Date.now(), IDLE_MS = 3 * 60000, NIGHT_START = 23, NIGHT_END = 6;
  function poke() {
    lastTouch = Date.now();
    $('dimmer').className = 'hidden';
  }
  document.addEventListener('touchstart', function (e) {
    // First tap on the dimmed screen only wakes it – don't press what's underneath.
    if ($('dimmer').className !== 'hidden') e.preventDefault();
    poke();
  }, false);
  $('dimmer').addEventListener('click', function (e) { e.stopPropagation(); poke(); }, false);
  setInterval(function () {
    tickClock();
    if (!Device.get().wall) return;
    var idle = Date.now() - lastTouch;
    var focused = document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName);
    if (current && idle > IDLE_MS && !focused) goHome();
    var h = new Date().getHours();
    var night = h >= NIGHT_START || h < NIGHT_END;
    if (night && idle > 60000) $('dimmer').className = '';
  }, 1000);

  // Re-render home every minute so "today"/"tomorrow" stay correct after midnight.
  setInterval(function () { if (!current) renderHome(); }, 60000);

  // ------------------------------------------------------------------ boot
  // render() never touches text inputs (they live in each app's shell), so
  // it is safe to re-render whenever a sync brings in changes.
  Store.onChange(function () { if (current !== 'cameras') rerender(); });

  tickClock();
  Store.init();
  Weather.pull();
  setInterval(function () { Weather.pull(); }, 15 * 60000);

  // Setup link from another device: #join=<{"db":..,"key":..}>
  function checkJoin() {
    var join = /#join=(.+)$/.exec(location.hash);
    if (!join) return;
    try {
      var cfg = JSON.parse(decodeURIComponent(join[1]));
      if (cfg.db && cfg.key && (!Store.sync || Store.sync.key !== cfg.key) &&
          confirm('Connect this device to the shared House Hub?')) Store.setSync(cfg);
    } catch (e) { /* bad link */ }
    if (window.history && history.replaceState) history.replaceState(null, '', location.href.split('#')[0]);
    else location.hash = '';
  }
  checkJoin();
  window.addEventListener('hashchange', checkJoin, false);

  // Phones drop the live connection when the browser sleeps: reconnect on wake.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    if (Store.sync && !Store.online) Store.connect();
    Store.pullGoogle(); // phones: catch up after being in the background
  }, false);

  // Auto-update: the wall iPad never gets reloaded by hand, so every 15
  // minutes check whether a new version was published and, if so, reload
  // while nobody is using it (on the home screen, idle for a minute).
  var appVersion = null, updateReady = false;
  function checkForUpdate() {
    var x = new XMLHttpRequest();
    x.open('HEAD', 'app.js?check=' + Date.now(), true);
    x.onreadystatechange = function () {
      if (x.readyState !== 4 || x.status !== 200) return;
      var v = x.getResponseHeader('ETag') || x.getResponseHeader('Last-Modified');
      if (!v) return;
      if (appVersion === null) appVersion = v;
      else if (v !== appVersion) updateReady = true;
    };
    x.send(null);
  }
  checkForUpdate();
  setInterval(checkForUpdate, 15 * 60000);
  setInterval(function () {
    var focused = document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName);
    if (updateReady && !current && !focused && !$('modal-root').innerHTML && Date.now() - lastTouch > 60000) location.reload();
  }, 30000);

  // Offline support / installable app (not available on very old iOS – that's fine).
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js');
  }
  renderHome();
})();
