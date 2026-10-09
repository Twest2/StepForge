'use strict';

// Entry point. `--mcp` serves the library to AI agents over stdin/stdout
// without opening a window; anything else starts the app.
if (process.argv.includes('--mcp')) require('./mcp').main();
else require('./main');
