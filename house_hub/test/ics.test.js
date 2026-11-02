'use strict';
var test = require('node:test');
var assert = require('node:assert');
var ics = require('../public/ics');

var SAMPLE = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'UID:1',
  'SUMMARY:Dentist\\, Jess',
  'DTSTART:20261105T093000',
  'DTEND:20261105T101500',
  'BEGIN:VALARM',
  'SUMMARY:ignore me',
  'END:VALARM',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:2',
  'SUMMARY:Bin day',
  'DTSTART;VALUE=DATE:20261103',
  'DTEND;VALUE=DATE:20261104',
  'RRULE:FREQ=WEEKLY;COUNT=4',
  'EXDATE;VALUE=DATE:20261110',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:3',
  'SUMMARY:Gym with a very long',
  '  folded title',
  'DTSTART:20261102T180000',
  'DTEND:20261102T190000',
  'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261112T000000Z',
  'END:VEVENT',
  'END:VCALENDAR'
].join('\r\n');

test('parses single, all-day recurring and BYDAY events', function () {
  var evs = ics.parse(SAMPLE);
  assert.strictEqual(evs.length, 3);
  assert.strictEqual(evs[0].title, 'Dentist, Jess');
  assert.strictEqual(evs[2].title, 'Gym with a very long folded title');

  var out = ics.expand(evs, new Date(2026, 10, 1), new Date(2026, 11, 31));
  var bins = out.filter(function (e) { return e.title === 'Bin day'; });
  assert.strictEqual(bins.length, 3); // 4 occurrences minus one EXDATE
  assert.ok(bins.every(function (e) { return e.allDay; }));

  var gym = out.filter(function (e) { return e.title.indexOf('Gym') === 0; });
  var days = gym.map(function (e) { return new Date(e.start).getDate(); });
  assert.deepStrictEqual(days, [2, 4, 9, 11]);
});
