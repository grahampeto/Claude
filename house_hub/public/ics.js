(function (root) {
'use strict';
// Minimal iCalendar (.ics) parser: VEVENTs with all-day/timed/UTC/TZID times,
// EXDATE and a practical RRULE subset (DAILY/WEEKLY/MONTHLY/YEARLY, INTERVAL,
// COUNT, UNTIL, BYDAY for weekly). TZID times are treated as the device's local time.

var DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function unfold(text) {
  return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, '');
}

function unescapeText(v) {
  return v.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
}

function parseLine(line) {
  var colon = -1, inQuote = false;
  for (var i = 0; i < line.length; i++) {
    var c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (c === ':' && !inQuote) { colon = i; break; }
  }
  if (colon < 0) return null;
  var head = line.slice(0, colon).split(';');
  var params = {};
  for (var j = 1; j < head.length; j++) {
    var eq = head[j].indexOf('=');
    if (eq > 0) params[head[j].slice(0, eq).toUpperCase()] = head[j].slice(eq + 1).replace(/"/g, '');
  }
  return { name: head[0].toUpperCase(), params: params, value: line.slice(colon + 1) };
}

// Returns { date: Date, allDay: bool }
function parseDate(value, params) {
  var m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  var y = +m[1], mo = +m[2] - 1, d = +m[3];
  if (!m[4] || (params && params.VALUE === 'DATE')) {
    return { date: new Date(y, mo, d), allDay: true };
  }
  var h = +m[4], mi = +m[5], s = +(m[6] || 0);
  var date = m[7] ? new Date(Date.UTC(y, mo, d, h, mi, s)) : new Date(y, mo, d, h, mi, s);
  return { date: date, allDay: false };
}

function parseRRule(value) {
  var rule = {};
  value.split(';').forEach(function (part) {
    var eq = part.indexOf('=');
    if (eq > 0) rule[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1);
  });
  return rule;
}

function parse(text) {
  var lines = unfold(text).split('\n');
  var events = [], cur = null, depth = 0;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!line) continue;
    var p = parseLine(line);
    if (!p) continue;
    if (p.name === 'BEGIN' && p.value.toUpperCase() === 'VEVENT') { cur = { exdates: [] }; depth = 0; continue; }
    if (!cur) continue;
    if (p.name === 'BEGIN') { depth++; continue; }          // e.g. VALARM
    if (p.name === 'END' && depth > 0) { depth--; continue; }
    if (depth > 0) continue;
    if (p.name === 'END' && p.value.toUpperCase() === 'VEVENT') {
      if (cur.start) events.push(cur);
      cur = null;
      continue;
    }
    switch (p.name) {
      case 'UID': cur.uid = p.value; break;
      case 'SUMMARY': cur.title = unescapeText(p.value); break;
      case 'LOCATION': cur.location = unescapeText(p.value); break;
      case 'DTSTART':
        var s = parseDate(p.value, p.params);
        if (s) { cur.start = s.date; cur.allDay = s.allDay; }
        break;
      case 'DTEND':
        var e = parseDate(p.value, p.params);
        if (e) cur.end = e.date;
        break;
      case 'RRULE': cur.rrule = parseRRule(p.value); break;
      case 'EXDATE':
        p.value.split(',').forEach(function (v) {
          var x = parseDate(v, p.params);
          if (x) cur.exdates.push(x.date.getTime());
        });
        break;
      case 'RECURRENCE-ID': cur.recurrenceId = parseDate(p.value, p.params); break;
      case 'STATUS': cur.status = p.value.toUpperCase(); break;
    }
  }
  return events;
}

function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// Expand events (including recurrences) into concrete instances within [from, to).
function expand(events, from, to) {
  var out = [];
  var overrides = {};
  events.forEach(function (ev) {
    if (ev.recurrenceId && ev.uid) overrides[ev.uid + '|' + ev.recurrenceId.date.getTime()] = true;
  });

  events.forEach(function (ev) {
    if (ev.status === 'CANCELLED') return;
    var duration = ev.end ? ev.end - ev.start : (ev.allDay ? 86400000 : 0);
    function push(start) {
      var end = new Date(start.getTime() + duration);
      if (end <= from && !(duration === 0 && start >= from)) return;
      if (start >= to) return;
      out.push({
        title: ev.title || '(no title)',
        location: ev.location || '',
        start: start.toISOString(),
        end: end.toISOString(),
        allDay: !!ev.allDay
      });
    }
    if (!ev.rrule || ev.recurrenceId) { push(ev.start); return; }

    var r = ev.rrule;
    var freq = (r.FREQ || '').toUpperCase();
    var interval = Math.max(1, parseInt(r.INTERVAL || '1', 10));
    var count = r.COUNT ? parseInt(r.COUNT, 10) : Infinity;
    var until = r.UNTIL ? parseDate(r.UNTIL).date : null;
    var byday = r.BYDAY ? r.BYDAY.split(',').map(function (d) { return DAY_CODES.indexOf(d.slice(-2)); }) : null;
    var n = 0, guard = 0;

    function emit(d) {
      if (until && d > until) return false;
      if (n >= count) return false;
      n++;
      var key = ev.uid + '|' + d.getTime();
      if (ev.exdates.indexOf(d.getTime()) < 0 && !overrides[key]) push(d);
      return true;
    }
    function atTime(base, y, m, day) {
      return new Date(y, m, day, base.getHours(), base.getMinutes(), base.getSeconds());
    }

    var s = ev.start;
    if (freq === 'WEEKLY' && byday) {
      // Walk week by week from the week containing DTSTART.
      var weekStart = new Date(s.getFullYear(), s.getMonth(), s.getDate() - s.getDay());
      for (var w = 0; guard++ < 5000; w += interval) {
        var stop = false;
        for (var k = 0; k < 7; k++) {
          var day = atTime(s, weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + w * 7 + k);
          if (day < s || byday.indexOf(day.getDay()) < 0) continue;
          if (day >= to || !emit(day)) { stop = true; break; }
        }
        if (stop) break;
      }
      return;
    }
    for (var i = 0; guard++ < 5000; i += interval) {
      var d;
      if (freq === 'DAILY') d = atTime(s, s.getFullYear(), s.getMonth(), s.getDate() + i);
      else if (freq === 'WEEKLY') d = atTime(s, s.getFullYear(), s.getMonth(), s.getDate() + i * 7);
      else if (freq === 'MONTHLY') {
        d = atTime(s, s.getFullYear(), s.getMonth() + i, s.getDate());
        if (d.getDate() !== s.getDate()) continue; // skip e.g. 31st in short months
      } else if (freq === 'YEARLY') {
        d = atTime(s, s.getFullYear() + i, s.getMonth(), s.getDate());
        if (d.getMonth() !== s.getMonth()) continue;
      } else { push(s); return; }
      if (d >= to || !emit(d)) break;
    }
  });
  out.sort(function (a, b) { return a.start < b.start ? -1 : a.start > b.start ? 1 : 0; });
  return out;
}

var api = { parse: parse, expand: expand, sameDay: sameDay };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.ICS = api;
})(this);
