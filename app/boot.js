'use strict';

// Entry point. `--mcp` serves the library to AI agents over stdin/stdout
// without opening a window; anything else starts the app.
if (!process.argv.includes('--mcp')) {
  require('./main');
} else if (process.platform === 'win32' && process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE) {
  // On Windows, Electron's main process is a GUI app and never reads piped
  // stdin, so the agent would get no answers. Run the server in a child
  // StepForge working as plain Node; it inherits the agent's stdin/stdout.
  const { spawn } = require('node:child_process');
  const path = require('node:path');
  const child = spawn(process.execPath, [path.join(__dirname, 'mcp.js')], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true,
  });
  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', (err) => {
    process.stderr.write(`StepForge could not start its MCP server: ${err.message}\n`);
    process.exit(1);
  });
} else {
  require('./mcp').main();
}
