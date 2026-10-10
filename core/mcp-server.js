'use strict';

/**
 * A small Model Context Protocol server: JSON-RPC 2.0 messages, one per line,
 * over stdin/stdout. It serves tools only, which is all StepForge offers, so it
 * needs no SDK dependency.
 */

// Newest first. A client asking for one of these gets it; anything else gets the newest.
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const reply = (id, result) => ({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

/**
 * `tools`: [{ name, description, inputSchema, annotations?, handler(args) }],
 * where a handler resolves to an MCP tool result: { content, isError? }.
 */
function createMcpServer({ name, version, instructions = '', tools = [] }) {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  async function handle(message) {
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return fail(message && message.id !== undefined ? message.id : null, -32600, 'Invalid request');
    }
    const { id, method, params = {} } = message;
    const notification = id === undefined;
    try {
      switch (method) {
        case 'initialize': {
          const requested = params.protocolVersion;
          return reply(id, {
            protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name, version },
            ...(instructions ? { instructions } : {}),
          });
        }
        case 'ping':
          return notification ? null : reply(id, {});
        case 'tools/list':
          return reply(id, {
            tools: tools.map(({ name: toolName, description, inputSchema, annotations }) => ({
              name: toolName, description, inputSchema, ...(annotations ? { annotations } : {}),
            })),
          });
        case 'tools/call': {
          const tool = byName.get(params.name);
          if (!tool) return fail(id, -32602, `Unknown tool: ${params.name}`);
          try {
            return reply(id, await tool.handler(params.arguments || {}));
          } catch (err) {
            // An unexpected failure inside a tool is reported to the agent as a
            // tool error it can read, not as a broken protocol exchange.
            return reply(id, { content: [{ type: 'text', text: `StepForge could not do that: ${err && err.message ? err.message : err}` }], isError: true });
          }
        }
        default:
          // Notifications (initialized, cancelled, …) need no answer.
          return notification ? null : fail(id, -32601, `Method not found: ${method}`);
      }
    } catch (err) {
      return notification ? null : fail(id, -32603, err && err.message ? err.message : 'Internal error');
    }
  }

  return { handle };
}

/**
 * Serve `server` over newline-delimited JSON on `input`/`output`. Messages are
 * handled one at a time, in order, so two writes never race each other.
 * Resolves when the input ends.
 */
function serveStdio(server, { input = process.stdin, output = process.stdout } = {}) {
  const write = (message) => output.write(`${JSON.stringify(message)}\n`);
  let queue = Promise.resolve();
  let buffer = '';
  const dispatch = (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      write(fail(null, -32700, 'Parse error'));
      return;
    }
    queue = queue.then(async () => {
      const response = await server.handle(message);
      if (response) write(response);
    });
  };
  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    buffer += chunk;
    for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) dispatch(line);
    }
  });
  return new Promise((resolve) => {
    input.on('end', () => {
      if (buffer.trim()) dispatch(buffer.trim());
      queue.then(resolve);
    });
  });
}

module.exports = { createMcpServer, serveStdio, PROTOCOL_VERSIONS };
