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
  // Shared state lives on the server; a copy is cached in localStorage so the
  // app still works (and shows the last data) if the server is unreachable.
  var Store = {
    data: null,
    rev: 0,
    dirty: {},
    online: false,
    listeners: [],
    calendar: { events: [], errors: [] },

    init: function () {
      var cached = lsGet('househub.state', null);
      this.data = cached || {
        events: [], groceries: { items: [], history: {} }, todos: [], notes: [],
        checklists: {
          jess: { items: [], done: {} }, graham: { items: [], done: {} }, both: { items: [], done: {} }
        }
      };
      this.dirty = lsGet('househub.dirty', {});
      this.rev = lsGet('househub.rev', 0);
      this.pull();
      this.pullCalendar();
      var self = this;
      setInterval(function () { self.flush(); self.pull(); }, 10000);
      setInterval(function () { self.pullCalendar(); }, 5 * 60000);
    },
    onChange: function (fn) { this.listeners.push(fn); },
    emit: function () { for (var i = 0; i < this.listeners.length; i++) this.listeners[i](); },
    cache: function () {
      lsSet('househub.state', this.data);
      lsSet('househub.dirty', this.dirty);
      lsSet('househub.rev', this.rev);
    },
    pull: function () {
      var self = this;
      ajax('GET', '/api/state?since=' + this.rev, null, function (err, res) {
        self.online = !err;
        if (!err && res && !res.unchanged) {
          for (var k in res) {
            if (k !== 'rev' && res.hasOwnProperty(k) && !self.dirty[k]) self.data[k] = res[k];
          }
          self.rev = res.rev;
          self.cache();
        }
        self.emit();
      });
    },
    pullCalendar: function () {
      var self = this;
      ajax('GET', '/api/calendar', null, function (err, res) {
        if (!err && res) { self.calendar = res; self.emit(); }
      });
    },
    // Call after mutating Store.data[key].
    save: function (key) {
      this.dirty[key] = true;
      this.cache();
      this.emit();
      this.flush();
    },
    inflight: {},
    flush: function () {
      var self = this;
      Object.keys(this.dirty).forEach(function (key) {
        if (self.inflight[key]) return;
        self.inflight[key] = true;
        var sentValue = JSON.stringify(self.data[key]);
        ajax('PUT', '/api/state/' + key, { value: self.data[key] }, function (err, res) {
          self.inflight[key] = false;
          self.online = !err;
          if (err) return self.emit();
          // Only clear the flag if nothing changed while the request was in flight.
          if (JSON.stringify(self.data[key]) === sentValue) delete self.dirty[key];
          else setTimeout(function () { self.flush(); }, 0);
          if (res && res.rev === self.rev + 1) self.rev = res.rev; // otherwise next pull fetches others' changes
          self.cache();
          self.emit();
        });
      });
    }
  };

  var Config = { title: 'Our Home', cameras: [] };

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
  function groc() {
    var g = Store.data.groceries;
    if (!g || Object.prototype.toString.call(g) === '[object Array]') g = Store.data.groceries = { items: g || [], history: {} };
    if (!g.history) g.history = {};
    return g;
  }
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
      var favs = Object.keys(g.history).filter(function (n) { return !onList[n.toLowerCase()]; })
        .sort(function (a, b) { return g.history[b] - g.history[a]; }).slice(0, 14);
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
        g.items.forEach(function (i) { if (i.done) g.history[i.name] = (g.history[i.name] || 0) + 1; });
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
  // Streams only run while this screen is open (saves Wi-Fi and Ring battery).
  Apps.cameras = {
    title: 'Cameras',
    timers: [],
    headerActions: '<button class="btn small" data-action="cam-reload">Reload</button>',
    shell: function () {
      var cams = Config.cameras;
      if (!cams.length) {
        return '<div class="list"><div class="list-empty">No cameras configured yet.<br>Add them to <b>config.json</b> on the server (see README).</div></div>';
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
        var cam = Config.cameras[+img.getAttribute('data-cam')];
        var base = img.getAttribute('data-src');
        function bust() { return base + (base.indexOf('?') < 0 ? '?' : '&') + '_=' + Date.now(); }
        img.onerror = function () {
          if (!img.parentNode || img.parentNode.querySelector('.cam-err')) return;
          var e = document.createElement('div');
          e.className = 'cam-err';
          e.textContent = 'Camera offline – tap Reload';
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
        var c = Config.cameras[+el.getAttribute('data-id')];
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
    $('title').textContent = Config.title;
    var s = $('sync');
    s.className = 'sync ' + (Store.online ? 'ok' : 'bad');
    s.textContent = Store.online ? (Object.keys(Store.dirty).length ? '● Syncing…' : '● Synced') : '● Offline – changes saved on this iPad';

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
  // After a few idle minutes go back to the home screen (also stops camera
  // streams). Between 23:00 and 06:00 dim the screen; a tap wakes it.
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
  ajax('GET', '/api/config', null, function (err, cfg) {
    if (!err && cfg) { Config = cfg; lsSet('househub.config', cfg); }
    else Config = lsGet('househub.config', Config);
    renderHome();
  });
  renderHome();
})();
