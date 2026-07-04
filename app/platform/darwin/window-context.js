'use strict';

const { execFileSync } = require('node:child_process');

/**
 * macOS WindowContextProvider using AppleScript / System Events. Extracted
 * verbatim from text-intel.js. macOS is not a primary support target, but the
 * adapter is kept so the shared code has no `process.platform` branch and the
 * behavior is preserved where it exists. Never throws.
 */
function createDarwinWindowContextProvider() {
  return {
    async collect() {
      const script = `
      set appName to ""
      set windowTitle to ""
      tell application "System Events"
        try
          set frontApp to first application process whose frontmost is true
          set appName to name of frontApp
          try
            set windowTitle to name of front window of frontApp
          end try
        end try
      end tell
      return appName & linefeed & windowTitle
    `;
      try {
        const result = execFileSync('osascript', ['-e', script], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 1200,
        }).trimEnd();
        const [appName = '', windowTitle = ''] = result.split(/\r?\n/);
        return { appName, windowTitle };
      } catch {
        return { appName: '', windowTitle: '' };
      }
    },
  };
}

module.exports = { createDarwinWindowContextProvider };
