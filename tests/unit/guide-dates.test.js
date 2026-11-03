'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { rendererI18n } = require('./helpers');

// app.js is one IIFE that boots the app; load it without booting and expose the date helpers.
function load() {
  const context = { ...rendererI18n('en'), window: {}, document: { addEventListener() {} } };
  const source = fs.readFileSync(path.join(__dirname, '../../app/renderer/app.js'), 'utf8');
  const exposed = '\nwindow.formatGuideDate = formatGuideDate;\nwindow.timeAgo = timeAgo;\n';
  vm.runInNewContext(source.replace('\nboot();', exposed), context);
  return context.window;
}
const { formatGuideDate, timeAgo } = load();

// Local-time ISO string, the same shape the library stores (UTC, with Z).
const local = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min).toISOString();

test('guide dates are DD-MMM-YYYY, with the day padded to two digits', () => {
  assert.equal(formatGuideDate(local(2026, 11, 1)), '01-Nov-2026');
  assert.equal(formatGuideDate(local(2026, 1, 3)), '03-Jan-2026');
  assert.equal(formatGuideDate(local(2025, 6, 19)), '19-Jun-2025');
  assert.equal(formatGuideDate(local(2026, 12, 31)), '31-Dec-2026');
});

test('every month has its three-letter English name', () => {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  months.forEach((name, index) => {
    assert.equal(formatGuideDate(local(2026, index + 1, 15)), `15-${name}-2026`);
  });
});

test('the day comes from local time, so a late-evening save keeps its day', () => {
  // Local midnight edges. In zones east or west of UTC these fall on a different UTC day,
  // so a UTC-based formatter fails here (the suite runs under several TZ values).
  assert.equal(formatGuideDate(local(2026, 11, 1, 23, 59)), '01-Nov-2026');
  assert.equal(formatGuideDate(local(2026, 11, 2, 0, 1)), '02-Nov-2026');
  assert.equal(formatGuideDate(local(2026, 12, 31, 23, 30)), '31-Dec-2026');
  assert.equal(formatGuideDate(local(2027, 1, 1, 0, 30)), '01-Jan-2027');
});

test('an invalid or missing date formats as an empty string', () => {
  assert.equal(formatGuideDate('not a date'), '');
  assert.equal(formatGuideDate('2026-13-45T99:00:00Z'), '');
  assert.equal(formatGuideDate(''), '');
  assert.equal(formatGuideDate(undefined), '');
  assert.equal(formatGuideDate(null), '');
});

test('other interfaces use their languages normal date conventions', () => {
  const iso = local(2026, 11, 1);
  assert.equal(formatGuideDate(iso, 'fr'), '1 nov. 2026');
  assert.equal(formatGuideDate(iso, 'es'), '1 nov 2026');
  assert.equal(formatGuideDate(iso, 'ru'), '1 нояб. 2026 г.');
  assert.equal(formatGuideDate(iso, 'ja'), '2026/11/01');
  assert.equal(formatGuideDate(iso, 'zh-CN'), '2026年11月1日');
});

test('localized dates keep the local day near midnight', () => {
  assert.equal(formatGuideDate(local(2026, 11, 1, 23, 59), 'ru'), '1 нояб. 2026 г.');
  assert.equal(formatGuideDate(local(2026, 11, 2, 0, 1), 'ja'), '2026/11/02');
});

test('Trash retains relative deletion times and formats older dates consistently', () => {
  const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(timeAgo(new Date().toISOString()), 'just now');
  assert.equal(timeAgo(daysAgo(3)), '3 days ago');
  const old = daysAgo(40);
  assert.equal(timeAgo(old), formatGuideDate(old, 'en'));
  assert.match(timeAgo(old), /^\d{2}-[A-Z][a-z]{2}-\d{4}$/);
});
