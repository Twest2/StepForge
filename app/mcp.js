'use strict';

// `StepForge --mcp`: serve the library to AI agents (Claude, Codex, any MCP
// app) over stdin/stdout. No window opens, and the process ends when the agent
// closes the connection.

const os = require('node:os');
const path = require('node:path');
const { GuideStore } = require('../core/store');
const { Settings } = require('../core/settings');
const { createMcpServer, serveStdio } = require('../core/mcp-server');
const { createAgentTools, INSTRUCTIONS } = require('../core/agent-tools');
const { recordAgentChange } = require('../core/agent-changes');
const { libraryLocationFor } = require('./data-dir');
const pkg = require('../package.json');

/** Electron's app object when running inside StepForge, or null under plain Node. */
function electronApp() {
  try {
    const electron = require('electron');
    return electron && typeof electron === 'object' && electron.app ? electron.app : null;
  } catch {
    return null;
  }
}

/** StepForge's userData folder, computed the way Electron does when run with plain Node. */
function userDataDir(app) {
  if (app) return app.getPath('userData');
  let appData;
  if (process.platform === 'win32') appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  else if (process.platform === 'darwin') appData = path.join(os.homedir(), 'Library', 'Application Support');
  else appData = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(appData, pkg.productName || pkg.name);
}

async function main() {
  // stdout carries the protocol, so anything else that prints goes to stderr.
  console.log = console.error;
  console.info = console.error;
  console.warn = console.error;
  const app = electronApp();
  if (app) app.disableHardwareAcceleration();

  // Read where the library is; never apply a pending library move from here.
  const store = new GuideStore(libraryLocationFor(userDataDir(app)).status().current);
  const tools = createAgentTools({
    store,
    // Read on every call, so turning access off in Settings takes effect at once.
    agentSettings: () => new Settings(store.settingsDir).get('ai.agents') || {},
    onChange: (guideId) => recordAgentChange(store.libraryDir, guideId),
  });
  await serveStdio(createMcpServer({ name: 'stepforge', version: pkg.version, instructions: INSTRUCTIONS, tools }));
  if (app) app.exit(0);
  else process.exit(0);
}

module.exports = { main };

if (require.main === module) main();
