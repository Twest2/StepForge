'use strict';

const fs = require('node:fs');
const path = require('node:path');
const CODES = new Set(['cancelled', 'timeout', 'unavailable', 'portal-failed', 'stream-failed', 'session-closed', 'helper-failed']);
const STAGES = new Set(['CreateSession', 'SelectSources', 'Start', 'OpenPipeWireRemote']);
const plainText = (text, values = {}) => text.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');

function failureCode(reason, code) {
  if (CODES.has(code)) return code;
  if (/ServiceUnknown|NameHasNoOwner|UnknownMethod|UnknownInterface|org\.freedesktop\.portal.*not (found|provided)/i.test(reason)) return 'unavailable';
  if (/timed?\s*out|NoReply/i.test(reason)) return 'timeout';
  if (/PipeWire|GStreamer|pipewiresrc/i.test(reason)) return 'stream-failed';
  if (/ENOENT|No module named|Namespace .* not available|helper exited/i.test(reason)) return 'helper-failed';
  return 'portal-failed';
}

function failureMessage(reason, code, desktop, t = plainText) {
  switch (code) {
    case 'cancelled': return t('Screen sharing was cancelled. Start recording again and select the monitors to share.');
    case 'timeout': return t('Screen sharing timed out. Check for a hidden sharing dialog, then try recording again. If it continues, check xdg-desktop-portal and your desktop portal backend.');
    case 'unavailable': return t('The screen-sharing portal is unavailable. Install or enable xdg-desktop-portal and the {desktop} portal backend, then log out and back in.', { desktop });
    case 'stream-failed': return t('The screen stream stopped. Check PipeWire, WirePlumber and your desktop portal backend, then start recording again.');
    case 'session-closed': return t('Screen sharing ended. Start recording again and share every monitor you want to record.');
    case 'helper-failed': return t('The capture helper could not run. Check that Python 3, PyGObject, GStreamer and the PipeWire plugin are installed. See docs/LINUX_PORTAL_TROUBLESHOOTING.md.');
    default: return String(reason || t('The screen-sharing portal failed.')) + ' ' + t('Try recording again. If it continues, see docs/LINUX_PORTAL_TROUBLESHOOTING.md for portal service checks.');
  }
}

/** Bounded local metadata only: never write stderr, frames, titles or D-Bus payloads. */
function logFailure(directory, { desktop, code, stage }) {
  if (!directory) return null;
  const file = path.join(directory, 'linux-capture.jsonl');
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.existsSync(file) && fs.statSync(file).size >= 256 * 1024) fs.renameSync(file, file + '.1');
    fs.appendFileSync(file, JSON.stringify({ time: new Date().toISOString(),
      desktop: desktop === 'plasma' ? 'plasma' : 'gnome', code: CODES.has(code) ? code : 'portal-failed',
      ...(STAGES.has(stage) ? { stage } : {}) }) + '\n', { mode: 0o600 });
    return file;
  } catch { return null; } // Diagnostics must never stop capture error handling.
}

module.exports = { failureCode, failureMessage, logFailure, plainText };
