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
  var STATE_KEYS = ['events', 'groceries', 'todos', 'notes', 'checklists', 'settings'];

  function items(list) { return list.map(function (t, i) { return { id: 'd' + i, text: t }; }); }
  function defaults() {
    return {
      events: [], todos: [], notes: [],
      groceries: { items: [], history: [] },
      checklists: {
        jess: { items: items(['Make bed', 'Take vitamins', 'Drink 2L water']), done: {} },
        graham: { items: items(['Make bed', 'Take vitamins', 'Drink 2L water']), done: {} },
        both: { items: items(['Unload dishwasher', 'Put bins out (if bin day)', 'Lock up & alarm on']), done: {} }
      },
      settings: { title: 'Our Home', calendars: [], cameras: [], corsProxy: '' }
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
    if (key === 'groceries') {
      v = v || {};
      if (Object.prototype.toString.call(v) === '[object Array]') v = { items: v };
      var hist = v.history || [];
      if (Object.prototype.toString.call(hist) !== '[object Array]' && typeof hist === 'object' && !hist[0]) {
        // Old format: { name: count }
        hist = Object.keys(hist).map(function (n) { return { name: n, count: v.history[n] }; });
      }
      return { items: arr(v.items), history: arr(hist) };
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
      return { title: v.title || d.title, calendars: arr(v.calendars), cameras: arr(v.cameras), corsProxy: v.corsProxy || '' };
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

    init: function () {
      var cached = lsGet('househub.state', null) || {};
      this.data = {};
      for (var i = 0; i < STATE_KEYS.length; i++) {
        var k = STATE_KEYS[i];
        this.data[k] = k in cached ? normalize(k, cached[k]) : defaults()[k];
      }
      this.dirty = lsGet('househub.dirty', {});
      this.sync = lsGet('househub.sync', null);
      this.connect();
      var self = this;
      setInterval(function () { self.flush(); }, 15000);
      this.pullCalendar();
      setInterval(function () { self.pullCalendar(); }, 10 * 60000);
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
      if (touched.indexOf('settings') >= 0) this.pullCalendar();
      this.emit();
    },

    // Call after mutating Store.data[key].
    save: function (key) {
      this.dirty[key] = true;
      this.cache();
      this.emit();
      this.flush();
      if (key === 'settings') this.pullCalendar();
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
      if (!feeds.length) { this.calendar = { events: [], errors: [] }; return; }
      var now = new Date();
      var from = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      var to = new Date(now.getFullYear(), now.getMonth() + 4, 1);
      var all = [], errors = [], pending = feeds.length;
      feeds.forEach(function (feed) {
        var u = feed.url.trim().replace(/^webcal:/i, 'https:');
        if (s.corsProxy) u = s.corsProxy.indexOf('{url}') >= 0 ? s.corsProxy.replace('{url}', encodeURIComponent(u)) : s.corsProxy + encodeURIComponent(u);
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
  function allEvents() {
    var out = [];
    Store.data.events.forEach(function (e) {
      var start = parseDay(e.date);
      if (e.time) { var t = e.time.split(':'); start.setHours(+t[0], +t[1]); }
      out.push({ id: e.id, local: true, title: e.title, who: e.who, allDay: !e.time, start: start, color: '' });
    });
    (Store.calendar.events || []).forEach(function (e) {
      out.push({ title: e.title, location: e.location, allDay: e.allDay, start: new Date(e.start), end: new Date(e.end), color: e.color, calendar: e.calendar });
    });
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
    enter: function () { var t = new Date(); this.month = new Date(t.getFullYear(), t.getMonth(), 1); this.selected = dayKey(t); },
    headerActions: '<button class="btn primary small" data-action="cal-add">+ Event</button>',
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
      if (Store.calendar.errors && Store.calendar.errors.length) {
        h += '<p class="small overdue">Calendar feed problem: ' + esc(Store.calendar.errors.join('; ')) + '</p>';
      }
      $('cal-month').innerHTML = h;

      var sel = parseDay(this.selected), dayEvs = eventsOn(events, sel);
      var dh = '<h3 style="margin:6px 0 14px">' + fmtDayLong(sel) + '</h3>';
      if (!dayEvs.length) dh += '<div class="list"><div class="list-empty">Nothing planned</div></div>';
      dayEvs.forEach(function (e) {
        dh += '<div class="ev flex center" style="border-left-color:' + esc(eventColor(e)) + '"><div class="grow">' +
          '<div class="t">' + (e.allDay ? 'All day' : fmtTime(e.start) + (e.end ? ' – ' + fmtTime(e.end) : '')) +
          (e.calendar ? ' · ' + esc(e.calendar) : '') + '</div>' +
          '<div class="n">' + (e.who ? whoTag(e.who) : '') + esc(e.title) + '</div>' +
          (e.location ? '<div class="t">' + esc(e.location) + '</div>' : '') + '</div>' +
          (e.local ? '<button class="del" data-action="cal-del" data-id="' + e.id + '" style="font-size:24px;color:#6b7487;padding:4px 8px">✕</button>' : '') +
          '</div>';
      });
      $('cal-day').innerHTML = dh;
    },
    actions: {
      'cal-prev': function () { var m = Apps.calendar.month; Apps.calendar.month = new Date(m.getFullYear(), m.getMonth() - 1, 1); },
      'cal-next': function () { var m = Apps.calendar.month; Apps.calendar.month = new Date(m.getFullYear(), m.getMonth() + 1, 1); },
      'cal-today': function () { Apps.calendar.enter(); },
      'cal-select': function (el) { Apps.calendar.selected = el.getAttribute('data-day'); },
      'cal-del': function (el) {
        if (!confirm('Delete this event?')) return;
        var id = el.getAttribute('data-id');
        Store.data.events = Store.data.events.filter(function (e) { return e.id !== id; });
        Store.save('events');
      },
      'cal-add': function () {
        Modal.open('New event',
          '<input class="field" name="title" placeholder="What?">' +
          '<div class="flex"><div class="grow" style="margin-right:10px"><label class="lbl">Date</label><input class="field" type="date" name="date" value="' + Apps.calendar.selected + '"></div>' +
          '<div class="grow"><label class="lbl">Time (blank = all day)</label><input class="field" type="time" name="time"></div></div>' +
          '<label class="lbl">Who</label>' + segHtml('who', WHO_OPTS, 'both'),
          function () {
            var title = Modal.val('title'), date = Modal.val('date');
            if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
            Store.data.events.push({ id: uid(), title: title, date: date, time: Modal.val('time'), who: Modal.seg('who') });
            Store.save('events');
          });
      }
    }
  };

  // ---- Groceries ------------------------------------------------------------
  function groc() { return Store.data.groceries; }
  Apps.groceries = {
    title: 'Groceries',
    headerActions: '<button class="btn small" data-action="groc-clear">Clear ticked</button>',
    shell: function () {
      return '<form class="add-row flex" data-form="groc-add"><input class="field grow" id="groc-input" placeholder="Add an item…" autocomplete="off" autocorrect="on">' +
        '<button class="btn primary" type="submit">Add</button></form>' +
        '<div class="chips flex wrap" id="groc-chips"></div><div id="groc-list"></div>';
    },
    render: function () {
      var g = groc();
      var onList = {};
      g.items.forEach(function (i) { onList[i.name.toLowerCase()] = true; });
      var favs = g.history.filter(function (h) { return !onList[h.name.toLowerCase()]; })
        .sort(function (a, b) { return b.count - a.count; }).slice(0, 14)
        .map(function (h) { return h.name; });
      $('groc-chips').innerHTML = favs.length ? favs.map(function (n) {
        return '<button class="chip" data-action="groc-quick" data-name="' + esc(n) + '">+ ' + esc(n) + '</button>';
      }).join('') : '';

      var items = g.items.slice().sort(function (a, b) { return (a.done ? 1 : 0) - (b.done ? 1 : 0) || a.added - b.added; });
      var h = '<div class="list">';
      if (!items.length) h += '<div class="list-empty">The list is empty 🎉</div>';
      items.forEach(function (i) {
        h += '<div class="row flex center' + (i.done ? ' done' : '') + '" data-action="groc-toggle" data-id="' + i.id + '">' +
          '<div class="check">' + (i.done ? '✓' : '') + '</div><div class="text grow">' + esc(i.name) + '</div>' +
          '<button class="del" data-action="groc-del" data-id="' + i.id + '">✕</button></div>';
      });
      $('groc-list').innerHTML = h + '</div>';
    },
    add: function (name) {
      name = name.trim();
      if (!name) return;
      var g = groc();
      for (var i = 0; i < g.items.length; i++) {
        if (g.items[i].name.toLowerCase() === name.toLowerCase()) { g.items[i].done = false; Store.save('groceries'); return; }
      }
      g.items.push({ id: uid(), name: name, done: false, added: Date.now() });
      Store.save('groceries');
    },
    actions: {
      'groc-add': function () { var el = $('groc-input'); Apps.groceries.add(el.value); el.value = ''; },
      'groc-quick': function (el) { Apps.groceries.add(el.getAttribute('data-name')); },
      'groc-toggle': function (el) {
        var id = el.getAttribute('data-id');
        groc().items.forEach(function (i) { if (i.id === id) i.done = !i.done; });
        Store.save('groceries');
      },
      'groc-del': function (el) {
        var id = el.getAttribute('data-id');
        var g = groc();
        g.items = g.items.filter(function (i) { return i.id !== id; });
        Store.save('groceries');
      },
      'groc-clear': function () {
        var g = groc();
        g.items.forEach(function (i) {
          if (!i.done) return;
          var h = null;
          for (var j = 0; j < g.history.length; j++) if (g.history[j].name.toLowerCase() === i.name.toLowerCase()) h = g.history[j];
          if (h) h.count++; else g.history.push({ name: i.name, count: 1 });
        });
        g.items = g.items.filter(function (i) { return !i.done; });
        Store.save('groceries');
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
        '<label class="lbl">Due date (optional)</label><input class="field" type="date" name="due" value="' + esc(t.due || '') + '">',
        function () {
          var text = Modal.val('text');
          if (!text) return false;
          t.text = text; t.who = Modal.seg('who'); t.due = Modal.val('due');
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

  // ---- Cameras ---------------------------------------------------------------
  function cameras() {
    return Store.data.settings.cameras.map(function (c, i) {
      return { id: i, name: c.name, type: c.type || 'mjpeg', url: c.url, refreshSeconds: c.refreshSeconds || 2 };
    });
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
      var h = '<div class="cams flex wrap">';
      cams.forEach(function (c) {
        h += '<div class="cam"><div class="cam-inner" data-action="cam-full" data-id="' + c.id + '">' + Apps.cameras.media(c) +
          '<div class="cam-name">' + esc(c.name) + '</div></div></div>';
      });
      return h + '</div><p class="muted small">Tap a camera for full screen. Streams stop when you leave this screen.</p>';
    },
    media: function (c, full) {
      var u = esc(c.url);
      if (c.type === 'hls') return '<video class="cam-media" data-cam="' + c.id + '" src="' + u + '" autoplay muted playsinline webkit-playsinline></video>';
      if (c.type === 'iframe') return '<iframe class="cam-media" data-cam="' + c.id + '" src="' + u + '" frameborder="0" style="height:' + (full ? '100%' : '300px') + '"></iframe>';
      // mjpeg & snapshot both use <img>; snapshot is refreshed on a timer.
      return '<img class="cam-media" data-cam="' + c.id + '" data-src="' + u + '" alt="">';
    },
    start: function (root) {
      var self = this;
      this.stop();
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
        img.src = bust();
        if (cam && cam.type === 'snapshot') {
          self.timers.push(setInterval(function () {
            var next = new Image();
            next.onload = function () { img.src = next.src; };
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
  var LISTS = [['jess', 'Jess'], ['graham', 'Graham'], ['both', 'Together']];
  function checklist(who) {
    var c = Store.data.checklists[who];
    if (!c) c = Store.data.checklists[who] = { items: [], done: {} };
    // Migrate plain-string items from older data.
    c.items = c.items.map(function (it, i) { return typeof it === 'string' ? { id: 'm' + i, text: it } : it; });
    if (!c.done) c.done = {};
    return c;
  }
  function checklistProgress(who, day) {
    var c = checklist(who), d = c.done[day || dayKey()] || {};
    var n = 0;
    c.items.forEach(function (it) { if (d[it.id]) n++; });
    return { done: n, total: c.items.length };
  }
  Apps.checklists = {
    title: 'Daily Checklist',
    who: 'jess',
    editing: false,
    headerActions: '<button class="btn small" data-action="chk-edit" id="chk-edit-btn">Edit list</button>',
    shell: function () {
      return '<div class="tabs flex" id="chk-tabs"></div>' +
        '<form class="add-row flex hidden" data-form="chk-add" id="chk-form"><input class="field grow" id="chk-input" placeholder="New daily item…" autocomplete="off">' +
        '<button class="btn primary" type="submit">Add</button></form><div id="chk-body"></div>';
    },
    render: function () {
      var self = this, today = dayKey();
      $('chk-tabs').innerHTML = LISTS.map(function (l) {
        var p = checklistProgress(l[0]);
        return '<button class="tab grow' + (l[0] === self.who ? ' active' : '') + '" data-action="chk-who" data-who="' + l[0] + '">' +
          l[1] + ' <span class="small">' + p.done + '/' + p.total + '</span></button>';
      }).join('');
      var btn = $('chk-edit-btn');
      if (btn) btn.textContent = this.editing ? 'Done' : 'Edit list';

      var c = checklist(this.who), doneToday = c.done[today] || {}, p = checklistProgress(this.who);
      var h = '';
      if (!this.editing) {
        h += '<div class="big-progress">' + p.done + ' of ' + p.total + ' done today</div>';
        h += '<div class="bar" style="margin-bottom:14px"><div style="width:' + (p.total ? Math.round(100 * p.done / p.total) : 0) + '%"></div></div>';
        h += '<div class="week-dots flex">';
        for (var i = 6; i >= 0; i--) {
          var d = addDays(new Date(), -i), q = checklistProgress(this.who, dayKey(d));
          var cls = q.total && q.done === q.total ? 'full' : q.done ? 'part' : '';
          h += '<div class="wd">' + DAYS[d.getDay()].slice(0, 3) + '<div class="d ' + cls + '">' + (cls === 'full' ? '✓' : d.getDate()) + '</div></div>';
        }
        h += '</div>';
      }
      $('chk-form').className = 'add-row flex' + (this.editing ? '' : ' hidden');
      h += '<div class="list">';
      if (!c.items.length) h += '<div class="list-empty">No items yet – tap “Edit list” to add some.</div>';
      c.items.forEach(function (it, idx) {
        if (self.editing) {
          h += '<div class="row flex center"><div class="text grow">' + esc(it.text) + '</div>' +
            '<button class="btn small" data-action="chk-move" data-i="' + idx + '" data-dir="-1">▲</button> ' +
            '<button class="btn small" data-action="chk-move" data-i="' + idx + '" data-dir="1" style="margin-left:6px">▼</button>' +
            '<button class="del" data-action="chk-del" data-id="' + it.id + '">✕</button></div>';
        } else {
          var on = !!doneToday[it.id];
          h += '<div class="row flex center' + (on ? ' done' : '') + '" data-action="chk-toggle" data-id="' + it.id + '">' +
            '<div class="check">' + (on ? '✓' : '') + '</div><div class="text grow">' + esc(it.text) + '</div></div>';
        }
      });
      h += '</div>';
      if (!this.editing && p.total && p.done === p.total) h += '<div class="celebrate">🎉 All done for today – nice work!</div>';
      $('chk-body').innerHTML = h;
    },
    actions: {
      'chk-who': function (el) { Apps.checklists.who = el.getAttribute('data-who'); },
      'chk-edit': function () { Apps.checklists.editing = !Apps.checklists.editing; },
      'chk-toggle': function (el) {
        var c = checklist(Apps.checklists.who), today = dayKey(), id = el.getAttribute('data-id');
        if (!c.done[today]) c.done[today] = {};
        if (c.done[today][id]) delete c.done[today][id]; else c.done[today][id] = true;
        // Keep 30 days of history.
        var cutoff = dayKey(addDays(new Date(), -30));
        Object.keys(c.done).forEach(function (k) { if (k < cutoff) delete c.done[k]; });
        Store.save('checklists');
      },
      'chk-add': function () {
        var el = $('chk-input'), text = el.value.trim();
        if (!text) return;
        checklist(Apps.checklists.who).items.push({ id: uid(), text: text });
        el.value = '';
        Store.save('checklists');
      },
      'chk-del': function (el) {
        var c = checklist(Apps.checklists.who), id = el.getAttribute('data-id');
        c.items = c.items.filter(function (it) { return it.id !== id; });
        Store.save('checklists');
      },
      'chk-move': function (el) {
        var c = checklist(Apps.checklists.who), i = +el.getAttribute('data-i'), j = i + (+el.getAttribute('data-dir'));
        if (j < 0 || j >= c.items.length) return;
        var t = c.items[i]; c.items[i] = c.items[j]; c.items[j] = t;
        Store.save('checklists');
      }
    }
  };

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
        '</div>' +

        '<div class="section-label">Home screen</div>' +
        '<div class="list" style="padding:16px">' +
        '<label class="lbl">Title</label><div class="flex"><input class="field grow" id="set-title" value="' + esc(s.title) + '" style="margin-right:10px"><button class="btn" data-action="set-title">Save</button></div>' +
        '<div class="row flex center" data-action="set-wall" style="padding:14px 0 0;border:0;min-height:0"><div class="check' + (dev.wall ? ' on' : '') + '" id="set-wall-check">' + (dev.wall ? '✓' : '') + '</div>' +
        '<div class="text grow">This device is the wall display<div class="meta">Goes back home after 3 idle minutes and dims 23:00–06:00. Only affects this device.</div></div></div>' +
        '</div>' +

        '<div class="section-label">Calendars (.ics feeds)</div>' +
        '<div id="set-cals"></div>' +
        '<form class="list" style="padding:16px" data-form="set-addcal">' +
        '<label class="lbl">Name</label><input class="field" id="cal-name" placeholder="Family">' +
        '<label class="lbl" style="margin-top:10px">Secret iCal address (Google: Settings → Integrate calendar)</label><input class="field" id="cal-url" placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" autocapitalize="off" autocorrect="off">' +
        '<label class="lbl" style="margin-top:10px">Colour</label>' + colorSelect('cal-color') +
        '<button class="btn primary" type="submit" style="margin-top:12px">Add calendar</button>' +
        '<label class="lbl" style="margin-top:18px">CORS proxy (needed for Google &amp; iCloud feeds – see README)</label>' +
        '<div class="flex"><input class="field grow" id="set-proxy" placeholder="https://my-proxy.workers.dev/?url=" value="' + esc(s.corsProxy) + '" autocapitalize="off" autocorrect="off" style="margin-right:10px">' +
        '<button class="btn" type="button" data-action="set-proxy">Save</button></div>' +
        '</form>' +

        '<div class="section-label">Cameras</div>' +
        '<div id="set-cams"></div>' +
        '<form class="list" style="padding:16px" data-form="set-addcam">' +
        '<label class="lbl">Name</label><input class="field" id="cam-name" placeholder="Front door (Ring)">' +
        '<label class="lbl" style="margin-top:10px">Type</label><select class="field" id="cam-type">' +
        '<option value="mjpeg">MJPEG stream (best for old iPads)</option><option value="hls">HLS video (.m3u8)</option>' +
        '<option value="snapshot">Snapshot image, refreshed every 2s</option><option value="iframe">Web page</option></select>' +
        '<label class="lbl" style="margin-top:10px">Stream URL</label><input class="field" id="cam-url" placeholder="http://192.168.1.10:1984/api/stream.mjpeg?src=garage" autocapitalize="off" autocorrect="off">' +
        '<button class="btn primary" type="submit" style="margin-top:12px">Add camera</button>' +
        '</form>';
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
      $('set-cams').innerHTML = s.cameras.length ? '<div class="list">' + s.cameras.map(function (c, i) {
        return '<div class="row flex center"><div class="text grow">' + esc(c.name) + '<div class="meta">' + esc(c.type) + ' · ' + esc(c.url) + '</div></div>' +
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
      'set-title': function () { Store.data.settings.title = $('set-title').value.trim() || 'Our Home'; Store.save('settings'); },
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
        var url = $('cam-url').value.trim();
        if (!url) return;
        Store.data.settings.cameras.push({ name: $('cam-name').value.trim() || 'Camera', type: $('cam-type').value, url: url });
        $('cam-name').value = ''; $('cam-url').value = '';
        Store.save('settings');
      },
      'set-delcam': function (el) { Store.data.settings.cameras.splice(+el.getAttribute('data-i'), 1); Store.save('settings'); }
    }
  };

  // ------------------------------------------------------------------ home
  function notifications() {
    var out = [], now = new Date(), today = dayKey(now), tomorrow = dayKey(addDays(now, 1));
    var events = allEvents();

    // Household notes (dismissable).
    Store.data.notes.forEach(function (n) {
      out.push({ cls: 'note', icon: '📝', title: n.text, sub: (WHO[n.who] ? 'From ' + WHO[n.who].label + ' · ' : '') + fmtDayShort(dayKey(new Date(n.at))), dismiss: n.id });
    });

    // Calendar: rest of today, then tomorrow.
    var todays = eventsOn(events, now).filter(function (e) { return e.allDay || (e.end || e.start) >= now; });
    if (todays.length) {
      out.push({
        cls: '', icon: '📅', app: 'calendar',
        title: todays.length === 1 ? todays[0].title : todays.length + ' things on today',
        sub: todays.slice(0, 4).map(function (e) { return (e.allDay ? 'All day' : fmtTime(e.start)) + ' ' + e.title; }).join(' · ')
      });
    }
    var tom = eventsOn(events, addDays(now, 1));
    if (tom.length) {
      out.push({
        cls: '', icon: '🗓️', app: 'calendar', title: 'Tomorrow: ' + (tom.length === 1 ? tom[0].title : tom.length + ' events'),
        sub: tom.slice(0, 4).map(function (e) { return (e.allDay ? 'All day' : fmtTime(e.start)) + ' ' + e.title; }).join(' · ')
      });
    }

    // To-dos overdue / due today / due tomorrow.
    var open = Store.data.todos.filter(function (t) { return !t.done && t.due; });
    var overdue = open.filter(function (t) { return t.due < today; });
    var dueToday = open.filter(function (t) { return t.due === today; });
    var dueTom = open.filter(function (t) { return t.due === tomorrow; });
    function names(list) { return list.slice(0, 4).map(function (t) { return t.text; }).join(' · '); }
    if (overdue.length) out.push({ cls: 'warn', icon: '⚠️', app: 'todo', title: overdue.length + ' overdue task' + (overdue.length > 1 ? 's' : ''), sub: names(overdue) });
    if (dueToday.length) out.push({ cls: 'warn', icon: '✅', app: 'todo', title: dueToday.length + ' task' + (dueToday.length > 1 ? 's' : '') + ' due today', sub: names(dueToday) });
    if (dueTom.length) out.push({ cls: '', icon: '✅', app: 'todo', title: dueTom.length + ' task' + (dueTom.length > 1 ? 's' : '') + ' due tomorrow', sub: names(dueTom) });

    // Evening nudge for unfinished checklists.
    if (now.getHours() >= 18) {
      LISTS.forEach(function (l) {
        var p = checklistProgress(l[0]);
        if (p.total && p.done < p.total) out.push({ cls: 'pink', icon: '📋', app: 'checklists', who: l[0], title: l[1] + ': ' + (p.total - p.done) + ' checklist item' + (p.total - p.done > 1 ? 's' : '') + ' left', sub: 'Tap to finish today’s list' });
      });
    }

    var gi = groc().items.filter(function (i) { return !i.done; });
    if (gi.length) out.push({ cls: 'ok', icon: '🛒', app: 'groceries', title: gi.length + ' item' + (gi.length > 1 ? 's' : '') + ' on the shopping list', sub: gi.slice(0, 6).map(function (i) { return i.name; }).join(', ') });
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

    $('progress').innerHTML = LISTS.map(function (l) {
      var p = checklistProgress(l[0]);
      var pct = p.total ? Math.round(100 * p.done / p.total) : 0;
      return '<button class="progress-card grow" data-action="open" data-app="checklists" data-who="' + l[0] + '" style="text-align:left">' +
        '<div class="flex between"><span class="name">' + l[1] + '</span><span class="muted">' + p.done + '/' + p.total + (p.total && p.done === p.total ? ' 🎉' : '') + '</span></div>' +
        '<div class="bar"><div style="width:' + pct + '%"></div></div></button>';
    }).join('');

    var list = notifications();
    $('notifications').innerHTML = list.length ? list.map(function (n) {
      return '<div class="notif flex center ' + n.cls + '"' + (n.app ? ' data-action="open" data-app="' + n.app + '"' + (n.who ? ' data-who="' + n.who + '"' : '') : '') + '>' +
        '<div class="icon">' + n.icon + '</div><div class="body grow"><div class="title">' + esc(n.title) + '</div>' +
        (n.sub ? '<div class="sub">' + esc(n.sub) + '</div>' : '') + '</div>' +
        (n.dismiss ? '<button class="x" data-action="dismiss-note" data-id="' + n.dismiss + '">✕</button>' : '') + '</div>';
    }).join('') : '<div class="empty-notif">All quiet – nothing needs attention 🌿</div>';

    // Badges on dock buttons.
    var today = dayKey();
    setBadge('calendar', eventsOn(allEvents(), new Date()).length);
    setBadge('groceries', groc().items.filter(function (i) { return !i.done; }).length);
    setBadge('todo', Store.data.todos.filter(function (t) { return !t.done && t.due && t.due <= today; }).length);
    var left = 0;
    LISTS.forEach(function (l) { var p = checklistProgress(l[0]); left += p.total - p.done; });
    setBadge('checklists', left);
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
    if (opts && opts.who && name === 'checklists') { app.who = opts.who; app.editing = false; }
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
      for (var i = 0; i < opts.length; i++) opts[i].className = 'opt';
      el.className = 'opt on';
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
    if (!document.hidden && Store.sync && !Store.online) Store.connect();
  }, false);

  // Offline support / installable app (not available on very old iOS – that's fine).
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js');
  }
  renderHome();
})();
