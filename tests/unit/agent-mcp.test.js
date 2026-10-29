'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert/strict');

const { makeTmpDir, rmrf, TINY_PNG } = require('./helpers');
const { GuideStore } = require('../../core/store');
const { Settings } = require('../../core/settings');
const { encodePng, decodePng } = require('../../core/png');
const { createImage, fillRect } = require('../../core/raster');
const { createMcpServer, PROTOCOL_VERSIONS } = require('../../core/mcp-server');
const { createAgentTools, INSTRUCTIONS } = require('../../core/agent-tools');
const { recordAgentChange, agentChangesSince } = require('../../core/agent-changes');
const { listSnapshots, restoreSnapshot, pruneSnapshots, createSnapshot, createAgentSnapshot } = require('../../core/snapshots');

const ROOT = path.resolve(__dirname, '..', '..');

/** A library with one guide: an intro, a placeholder credit, and two captured steps. */
function makeLibrary(t, agents = { enabled: true, screenshots: true }) {
  const dir = makeTmpDir('agent-mcp');
  t.after(() => rmrf(dir));
  const store = new GuideStore(dir);
  const settings = new Settings(store.settingsDir);
  settings.set('ai.agents', agents);
  const guide = store.createGuide({ title: 'Lab 5', descriptionHtml: '<p>Old intro.</p><p>[[stepforge]]</p>' });
  // The left half of the screenshot (pure red) is blurred.
  const img = createImage(20, 10, [0, 0, 255, 255]);
  fillRect(img, 0, 0, 10, 10, [255, 0, 0, 255]);
  const first = store.addStep(guide.guideId, {
    title: 'Screen capture',
    annotations: [{ id: 'b1', type: 'blur', x: 0, y: 0, w: 0.5, h: 1 }],
    textBlocks: [{ id: 'tb1', order: 1, level: 'info', title: 'note', descriptionHtml: '<p>old note</p>' }],
    captureMetadata: {
      mode: 'fullscreen', appName: 'chrome.exe', windowTitle: 'Canvas', elementLabel: 'Submit', elementRole: 'button',
      ocrText: 'secret under the blur', recentTyped: 'hunter2', elementValue: 'typed value',
    },
  }, encodePng(img), { width: 20, height: 10 });
  const second = store.addStep(guide.guideId, { title: 'Paste the answer' });
  const changes = [];
  const tools = createAgentTools({
    store,
    agentSettings: () => new Settings(store.settingsDir).get('ai.agents'),
    onChange: (guideId) => changes.push(guideId),
  });
  const call = async (name, args = {}) => tools.find((tool) => tool.name === name).handler(args);
  const json = (result) => JSON.parse(result.content[0].text);
  return { dir, store, settings, guide, first, second, tools, call, json, changes };
}

test('agents get every guide tool except changing or deleting placeholders', (t) => {
  const { tools } = makeLibrary(t);
  assert.deepEqual(tools.map((tool) => tool.name), [
    'list_guides', 'get_guide', 'get_step', 'create_guide', 'update_guide', 'delete_guide',
    'create_step', 'update_step', 'move_step', 'delete_step', 'delete_blocks', 'set_screenshot', 'remove_screenshot',
    'create_placeholder', 'add_annotations', 'delete_annotations',
    // Behind their own switch (tests/unit/agent-brand-tools.test.js).
    'list_brand_profiles', 'get_brand_profile', 'create_brand_profile', 'update_brand_profile', 'set_brand_file', 'set_active_brand_profile',
  ]);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, 'object');
    assert.ok(!/placeholder/.test(tool.name) || tool.name === 'create_placeholder');
    assert.equal(tool.annotations.destructiveHint === true, /^(delete|remove|set_screenshot)/.test(tool.name), tool.name);
  }
  assert.match(INSTRUCTIONS, /snapshots the guide before each of these/);
  assert.match(INSTRUCTIONS, /cannot change or delete placeholders/);
});

test('every tool refuses, with a fix the user can act on, while agent access is off', async (t) => {
  const { call, guide, settings } = makeLibrary(t, { enabled: false, screenshots: true });
  for (const [name, args] of [['list_guides', {}], ['get_guide', { guide_id: guide.guideId }], ['update_guide', { guide_id: guide.guideId, title: 'x' }]]) {
    const result = await call(name, args);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Settings → AI → Let AI agents edit your guides/);
  }
  // Turning it on takes effect on the next call, with no restart.
  settings.set('ai.agents.enabled', true);
  assert.equal((await call('list_guides')).isError, undefined);
});

test('reading a guide gives Markdown text, numbered steps, and no typed text or OCR', async (t) => {
  const { call, json, guide, first, store } = makeLibrary(t);
  store.createGuide({ title: 'Other guide' });
  assert.deepEqual(json(await call('list_guides', { query: 'lab' })).map((g) => g.title), ['Lab 5']);

  const read = json(await call('get_guide', { guide_id: guide.guideId }));
  assert.equal(read.description, 'Old intro.', 'the placeholder paragraph is not shown to agents');
  assert.deepEqual(read.steps.map((s) => [s.number, s.title]), [['1', 'Screen capture'], ['2', 'Paste the answer']]);
  assert.deepEqual(read.steps[0].blocks, [{ id: 'tb1', kind: 'text', level: 'info', title: 'note', body: 'old note' }]);
  assert.deepEqual(read.steps[0].capture, { app: 'chrome.exe', window: 'Canvas', element: 'Submit (button)' });
  const raw = JSON.stringify(read);
  for (const secret of ['secret under the blur', 'hunter2', 'typed value']) assert.ok(!raw.includes(secret), `${secret} leaked`);
  assert.equal(read.steps[0].step_id, first.stepId);
});

test('a step screenshot comes with its blurs filled, and not at all when screenshots are off', async (t) => {
  const { call, guide, first, settings } = makeLibrary(t);
  const result = await call('get_step', { guide_id: guide.guideId, step_id: first.stepId });
  const image = result.content.find((part) => part.type === 'image');
  assert.equal(image.mimeType, 'image/png');
  const png = decodePng(Buffer.from(image.data, 'base64'));
  for (let x = 0; x < 10; x++) {
    const p = (5 * png.width + x) * 4;
    assert.ok(!(png.data[p] === 255 && png.data[p + 2] === 0), `blurred pixel ${x} shows the secret`);
  }
  settings.set('ai.agents.screenshots', false);
  const textOnly = await call('get_step', { guide_id: guide.guideId, step_id: first.stepId });
  assert.ok(!textOnly.content.some((part) => part.type === 'image'));
  assert.match(textOnly.content[1].text, /Screenshots are turned off/);
});

test('agents rewrite step and guide text; update_step merges blocks by id and never deletes them', async (t) => {
  const { call, json, guide, first, store, changes } = makeLibrary(t);
  const before = store.getStep(guide.guideId, first.stepId);
  const result = json(await call('update_step', {
    guide_id: guide.guideId,
    step_id: first.stepId,
    title: 'Click Submit',
    description: 'Click **Submit** to [turn in](https://canvas.example) the lab.',
    blocks: [
      { id: 'tb1', kind: 'text', level: 'warn', body: 'You can only submit **once**.' },
      { kind: 'code', language: 'bash', code: 'ls lab5' },
    ],
  }));
  assert.equal(result.title, 'Click Submit');
  const saved = store.getStep(guide.guideId, first.stepId);
  assert.equal(saved.descriptionHtml, '<p>Click <strong>Submit</strong> to <a href="https://canvas.example">turn in</a> the lab.</p>');
  assert.equal(saved.textBlocks.length, 1);
  assert.equal(saved.textBlocks[0].level, 'warn');
  assert.equal(saved.textBlocks[0].title, 'note', 'a field the agent left out is kept');
  assert.equal(saved.textBlocks[0].descriptionHtml, '<p>You can only submit <strong>once</strong>.</p>');
  assert.deepEqual(saved.codeBlocks.map((b) => b.code), ['ls lab5']);
  assert.deepEqual(saved.annotations, before.annotations, 'annotations are untouched');
  assert.equal(saved.revision, before.revision + 1);

  await call('update_guide', { guide_id: guide.guideId, title: 'Submit Lab 5 in Canvas', description: 'How to turn in **Lab 5**.' });
  const savedGuide = store.getGuide(guide.guideId);
  assert.equal(savedGuide.title, 'Submit Lab 5 in Canvas');
  assert.equal(savedGuide.descriptionHtml, '<p>How to turn in <strong>Lab 5</strong>.</p><p>[[stepforge]]</p>');
  assert.deepEqual(changes, [guide.guideId, guide.guideId]);
});

test('bad ids and empty updates come back as errors the agent can read', async (t) => {
  const { call, guide } = makeLibrary(t);
  assert.match((await call('get_guide', { guide_id: 'nope' })).content[0].text, /No guide with id "nope"/);
  assert.match((await call('get_step', { guide_id: guide.guideId, step_id: 'nope' })).content[0].text, /has no step "nope"/);
  assert.match((await call('update_step', { guide_id: guide.guideId, step_id: 'nope', title: 'x' })).content[0].text, /has no step/);
  const empty = await call('update_guide', { guide_id: guide.guideId });
  assert.equal(empty.isError, true);
  const long = await call('update_guide', { guide_id: guide.guideId, title: 'x'.repeat(301) });
  assert.match(long.content[0].text, /at most 300 characters/);
});

test('the MCP server negotiates a version, lists tools, and reports tool errors as results', async () => {
  const server = createMcpServer({
    name: 'stepforge',
    version: '1.0.0',
    instructions: 'hi',
    tools: [
      { name: 'ok', description: 'd', inputSchema: { type: 'object' }, handler: async () => ({ content: [{ type: 'text', text: 'done' }] }) },
      { name: 'boom', description: 'd', inputSchema: { type: 'object' }, handler: async () => { throw new Error('disk full'); } },
    ],
  });
  const init = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } });
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.equal(init.result.instructions, 'hi');
  const future = await server.handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } });
  assert.equal(future.result.protocolVersion, PROTOCOL_VERSIONS[0]);
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  assert.deepEqual((await server.handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' })).result.tools.map((tool) => tool.name), ['ok', 'boom']);
  assert.equal((await server.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'ok' } })).result.content[0].text, 'done');
  const boom = await server.handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'boom' } });
  assert.equal(boom.result.isError, true);
  assert.match(boom.result.content[0].text, /disk full/);
  assert.equal((await server.handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'missing' } })).error.code, -32602);
  assert.equal((await server.handle({ jsonrpc: '2.0', id: 7, method: 'nope' })).error.code, -32601);
  assert.equal((await server.handle({ id: 8 })).error.code, -32600);
});

test('the app learns which guides agents changed since it last looked', (t) => {
  const dir = makeTmpDir('agent-changes');
  t.after(() => rmrf(dir));
  recordAgentChange(dir, 'g1', 1000);
  recordAgentChange(dir, 'g2', 2000);
  recordAgentChange(dir, 'g1', 3000);
  assert.deepEqual(agentChangesSince(dir, 1500), { guideIds: ['g2', 'g1'], branding: false, activeProfileId: undefined, latest: 3000 });
  assert.deepEqual(agentChangesSince(dir, 3000), { guideIds: [], branding: false, activeProfileId: undefined, latest: 3000 });
});

test('`--mcp` serves the library over stdin and stdout', async (t) => {
  const { dir, guide, first, store } = makeLibrary(t);
  const child = spawn(process.execPath, [path.join(ROOT, 'app', 'boot.js'), '--mcp'], {
    env: { ...process.env, STEPFORGE_DATA_DIR: dir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'update_step', arguments: { guide_id: guide.guideId, step_id: first.stepId, title: 'Click Submit' } } });
  child.stdin.end();
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0);
  const replies = out.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(replies.map((r) => r.id), [1, 2], 'one line per reply, nothing else on stdout');
  assert.equal(replies[0].result.serverInfo.name, 'stepforge');
  assert.equal(replies[1].result.isError, undefined);
  assert.equal(store.getStep(guide.guideId, first.stepId).title, 'Click Submit');
  // The app polls this file to reload the guide.
  assert.deepEqual(agentChangesSince(store.libraryDir, 0).guideIds, [guide.guideId]);
  assert.ok(fs.existsSync(path.join(store.libraryDir, 'agent-changes.json')));
});

test('agents see placeholders, parents and annotations, and can nest steps without reordering', async (t) => {
  const { call, json, guide, first, second, store, settings } = makeLibrary(t);
  settings.setGlobalPlaceholders({ Org: { format: 'markdown', text: 'TAMU' } });
  store.saveGuide({ ...store.getGuide(guide.guideId), placeholders: { Course: 'ECEN 350' } });
  const read = json(await call('get_guide', { guide_id: guide.guideId }));
  assert.deepEqual(read.placeholders.guide, [{ name: 'Course', value: 'ECEN 350' }]);
  assert.deepEqual(read.placeholders.global, [{ name: 'Org', value: 'TAMU' }]);
  assert.ok(read.placeholders.built_in.includes('Date'));
  assert.deepEqual(read.steps.map((s) => s.parent_step_id), [null, null]);
  assert.deepEqual(read.steps[0].screenshot_size, { width: 20, height: 10 });
  assert.deepEqual(read.steps[0].annotations, [{ id: 'b1', type: 'blur', x: 0, y: 0, width: 10, height: 10 }]);

  const nested = json(await call('update_step', { guide_id: guide.guideId, step_id: second.stepId, parent_step_id: first.stepId }));
  assert.equal(nested.number, '1.1');
  assert.deepEqual(store.getGuide(guide.guideId).stepsOrder, [first.stepId, second.stepId], 'order is unchanged');
  const third = store.addStep(guide.guideId, { title: 'Third' });
  const broken = await call('update_step', { guide_id: guide.guideId, step_id: first.stepId, parent_step_id: third.stepId });
  assert.equal(broken.isError, true);
  assert.match(broken.content[0].text, /break the step numbering/);
  // The last substep can move back to the top level.
  assert.equal(json(await call('update_step', { guide_id: guide.guideId, step_id: second.stepId, parent_step_id: null })).number, '2');
});

test('agents add guide and global placeholders but never change or shadow existing ones', async (t) => {
  const { call, guide, store, settings, changes } = makeLibrary(t);
  settings.setGlobalPlaceholders({ Org: { format: 'markdown', text: 'TAMU' } });
  assert.equal((await call('create_placeholder', { name: 'Course Code', value: 'ECEN 350', scope: 'guide', guide_id: guide.guideId })).isError, undefined);
  assert.equal(store.getGuide(guide.guideId).placeholders['Course Code'], 'ECEN 350');
  assert.deepEqual(changes, [guide.guideId]);
  assert.equal((await call('create_placeholder', { name: 'Support', value: '[help](mailto:it@example.com)', scope: 'global' })).isError, undefined);
  assert.deepEqual(settings.getGlobalPlaceholders().Support, { format: 'markdown', text: '[help](mailto:it@example.com)' });

  for (const [args, message] of [
    [{ name: 'course code', value: 'x', scope: 'guide', guide_id: guide.guideId }, /already has \[\[course code\]\]/],
    [{ name: 'org', value: 'x', scope: 'guide', guide_id: guide.guideId }, /global placeholder \[\[org\]\] already exists/],
    [{ name: 'Date', value: 'x', scope: 'global' }, /can't be a placeholder name/],
    [{ name: 'Lab', value: '  ', scope: 'global' }, /can't be empty/],
    [{ name: 'Lab', value: 'x', scope: 'guide', guide_id: 'nope' }, /No guide with id/],
  ]) {
    const result = await call('create_placeholder', args);
    assert.equal(result.isError, true, JSON.stringify(args));
    assert.match(result.content[0].text, message);
  }
  assert.deepEqual(settings.getGlobalPlaceholders().Org, { format: 'markdown', text: 'TAMU' }, 'existing values are untouched');
});

test('agents draw every annotation type in screenshot pixels, added beside what is there', async (t) => {
  const { call, json, guide, first, second, store } = makeLibrary(t);
  const result = json(await call('add_annotations', {
    guide_id: guide.guideId,
    step_id: first.stepId,
    annotations: [
      { type: 'rect', x: 10, y: 2, width: 5, height: 4, color: '#2563EB' },
      { type: 'arrow', from: [0, 0], to: [15, 5] },
      { type: 'tooltip', x: 12, y: 1, width: 8, height: 3, text: 'Click here', tail: 'left' },
      { type: 'number', x: 16, y: 6, width: 3, height: 3, value: 2 },
      { type: 'oval', x: 15, y: -5, width: 100, height: 100 },
    ],
  }));
  assert.equal(result.annotations_on_step, 6, 'the existing blur stays');
  const saved = store.getStep(guide.guideId, first.stepId).annotations;
  assert.equal(saved[0].type, 'blur');
  const [rect, arrow, tip, badge, oval] = saved.slice(1);
  assert.deepEqual([rect.x, rect.y, rect.w, rect.h], [0.5, 0.2, 0.25, 0.4]);
  assert.equal(rect.style.stroke, '#2563EB');
  assert.deepEqual([arrow.x, arrow.y, arrow.w, arrow.h], [0, 0, 0.75, 0.5]);
  assert.equal(tip.text, 'Click here');
  assert.equal(tip.style.tail, 'left');
  assert.equal(badge.value, 2);
  // Partly outside the screenshot: clamped to its edges.
  assert.deepEqual([oval.x, oval.y, oval.w, oval.h], [0.75, 0, 0.25, 1]);

  for (const [annotations, message] of [
    [[{ type: 'star', x: 1, y: 1, width: 2, height: 2 }], /type must be one of/],
    [[{ type: 'arrow', from: [1, 1] }], /needs from: \[x, y\] and to/],
    [[{ type: 'rect', x: 1, y: 1 }], /needs x, y, width and height/],
    [[{ type: 'tooltip', x: 1, y: 1, width: 5, height: 5 }], /needs text/],
    [[{ type: 'number', x: 1, y: 1, width: 5, height: 5 }], /integer value/],
    [[{ type: 'rect', x: 1, y: 1, width: 5, height: 5, color: 'red' }], /color must look like/],
    [[{ type: 'oval', x: 40, y: 1, width: 5, height: 5 }], /outside the screenshot/],
  ]) {
    const bad = await call('add_annotations', { guide_id: guide.guideId, step_id: first.stepId, annotations });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0].text, message);
  }
  assert.match((await call('add_annotations', { guide_id: guide.guideId, step_id: second.stepId, annotations: [{ type: 'rect', x: 1, y: 1, width: 5, height: 5 }] })).content[0].text, /no screenshot/);
});

test('on Windows, `--mcp` reruns StepForge as plain Node so piped stdin works', () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(ROOT, 'app', 'boot.js'), 'utf8');
  const run = ({ platform, electron, runAsNode = undefined, argv = ['StepForge.exe', '--mcp'] }) => {
    const calls = { spawn: null, required: [] };
    const child = { on() { return child; } };
    const fakeRequire = (name) => {
      if (name === 'node:child_process') return { spawn: (...args) => { calls.spawn = args; return child; } };
      if (name === 'node:path') return path.win32;
      calls.required.push(name);
      return { main() {} };
    };
    const env = runAsNode ? { ELECTRON_RUN_AS_NODE: runAsNode } : {};
    vm.runInNewContext(source, {
      require: fakeRequire,
      __dirname: 'C:\\Program Files\\StepForge\\resources\\app.asar\\app',
      process: { argv, platform, env, execPath: 'C:\\Program Files\\StepForge\\StepForge.exe', versions: electron ? { electron: '41.10.7' } : {}, exit() {}, stderr: { write() {} } },
    });
    return calls;
  };
  const win = run({ platform: 'win32', electron: true });
  assert.equal(win.spawn[0], 'C:\\Program Files\\StepForge\\StepForge.exe');
  assert.deepEqual([...win.spawn[1]], ['C:\\Program Files\\StepForge\\resources\\app.asar\\app\\mcp.js']);
  assert.equal(win.spawn[2].stdio, 'inherit');
  assert.equal(win.spawn[2].env.ELECTRON_RUN_AS_NODE, '1');
  assert.deepEqual(win.required, []);
  // The Node-mode child, Linux, and plain Node serve directly; no --mcp starts the app.
  assert.deepEqual(run({ platform: 'win32', electron: true, runAsNode: '1' }).required, ['./mcp']);
  assert.deepEqual(run({ platform: 'linux', electron: true }).required, ['./mcp']);
  assert.deepEqual(run({ platform: 'win32', electron: false }).required, ['./mcp']);
  assert.deepEqual(run({ platform: 'win32', electron: true, argv: ['StepForge.exe'] }).required, ['./main']);
});

/** The guide's agent snapshots, oldest first. */
const agentSnapshots = (store, guideId) => listSnapshots(store, guideId).filter((name) => name.includes('before_agent_')).reverse();

/** A PNG file of `width` x `height` in `color`, in a fresh folder outside the library. */
function pngFile(t, width, height, color) {
  const dir = makeTmpDir('agent-png');
  t.after(() => rmrf(dir));
  const file = path.join(dir, 'shot.png');
  fs.writeFileSync(file, encodePng(createImage(width, height, color)));
  return file;
}

test('agents create guides and steps, nested where they land, with a snapshot before each step', async (t) => {
  const { call, json, store, changes } = makeLibrary(t);
  const made = json(await call('create_guide', { title: '  Reset a  password ', description: 'For **staff**.' }));
  assert.equal(made.title, 'Reset a password');
  assert.equal(store.getGuide(made.guide_id).descriptionHtml, '<p>For <strong>staff</strong>.</p>');
  assert.match((await call('create_guide', { title: ' ' })).content[0].text, /Give the guide a title/);

  const id = made.guide_id;
  const shot = pngFile(t, 30, 20, [0, 128, 0, 255]);
  const first = json(await call('create_step', { guide_id: id, title: 'Open Settings', image_path: shot }));
  assert.equal(first.number, '1');
  assert.deepEqual(first.screenshot_size, { width: 30, height: 20 });
  assert.ok(store.getStep(id, first.step_id).image, 'the PNG became the screenshot');
  assert.ok(decodePng(fs.readFileSync(store.stepImagePath(id, first.step_id, 'original'))).width === 30);
  const sub = json(await call('create_step', { guide_id: id, title: 'Choose Security', parent_step_id: first.step_id }));
  assert.equal(sub.number, '1.1');
  assert.equal(store.getStep(id, sub.step_id).kind, 'content', 'a text-only step');
  // Right after a step whose substeps follow, a new step goes under it.
  assert.equal(json(await call('create_step', { guide_id: id, title: 'Sign in', after_step_id: first.step_id })).number, '1.1');
  // After the last substep, it's another substep; at the top, a top-level step.
  assert.equal(json(await call('create_step', { guide_id: id, title: 'Save', after_step_id: sub.step_id })).number, '1.3');
  assert.equal(json(await call('create_step', { guide_id: id, title: 'Go to the portal', after_step_id: null })).number, '1');

  const broken = await call('create_step', { guide_id: id, title: 'x', after_step_id: null, parent_step_id: first.step_id });
  assert.match(broken.content[0].text, /break the step numbering/);
  assert.match((await call('create_step', { guide_id: id, title: 'x', image_path: 'shot.png' })).content[0].text, /full path/);
  const notPng = path.join(path.dirname(shot), 'notes.txt');
  fs.writeFileSync(notPng, 'hello');
  assert.match((await call('create_step', { guide_id: id, title: 'x', image_path: notPng })).content[0].text, /can't read .* as a PNG/);

  // One snapshot per step added, none for refused calls or the new guide.
  const snaps = agentSnapshots(store, id);
  assert.equal(snaps.length, 5);
  assert.ok(snaps.every((name) => name.endsWith('-before_agent_adds_a_step.snapshot')));
  restoreSnapshot(store, id, snaps[0]);
  assert.deepEqual(store.getGuide(id).stepsOrder, [], 'the first snapshot is the empty guide');
  assert.ok(changes.every((changed) => changed === id));
});

test('agents delete steps after a snapshot that brings them back, screenshot and all', async (t) => {
  const { call, guide, first, second, store, changes } = makeLibrary(t);
  const id = guide.guideId;
  const third = store.addStep(id, { title: 'Grandchild' });
  await call('update_step', { guide_id: id, step_id: second.stepId, parent_step_id: first.stepId });
  await call('update_step', { guide_id: id, step_id: third.stepId, parent_step_id: second.stepId });

  const result = await call('delete_step', { guide_id: id, step_id: second.stepId });
  assert.match(result.content[0].text, /Deleted "Paste the answer"\. StepForge saved a snapshot/);
  assert.deepEqual(store.getGuide(id).stepsOrder, [first.stepId, third.stepId]);
  assert.equal(store.getStep(id, third.stepId).parentStepId, first.stepId, 'its substep moves up one level, not to the top');

  await call('delete_step', { guide_id: id, step_id: first.stepId });
  assert.equal(fs.existsSync(store.stepDir(id, first.stepId)), false);
  const [beforeSecond, beforeFirst] = agentSnapshots(store, id);
  assert.match(beforeSecond, /before_agent_deletes_step_1_1\.snapshot$/);
  assert.match(beforeFirst, /before_agent_deletes_step_1\.snapshot$/);

  restoreSnapshot(store, id, beforeFirst);
  assert.deepEqual(store.getGuide(id).stepsOrder, [first.stepId, third.stepId]);
  assert.equal(store.getStep(id, first.stepId).title, 'Screen capture');
  assert.ok(fs.existsSync(store.stepImagePath(id, first.stepId, 'original')), 'the screenshot is back');
  assert.ok(changes.length >= 2);
});

test('agents move steps with their substeps, with a snapshot before each move', async (t) => {
  const { call, json, guide, first, second, store } = makeLibrary(t);
  const id = guide.guideId;
  const third = store.addStep(id, { title: 'Third' });
  await call('update_step', { guide_id: id, step_id: second.stepId, parent_step_id: first.stepId });

  // Step 1 (with 1.1) goes after step 2.
  const moved = json(await call('move_step', { guide_id: id, step_id: first.stepId, after_step_id: third.stepId }));
  assert.deepEqual(moved.steps.map((s) => [s.step_id, s.number]), [[third.stepId, '1'], [first.stepId, '2'], [second.stepId, '2.1']]);
  // A substep goes to the top, made top-level.
  json(await call('move_step', { guide_id: id, step_id: second.stepId, after_step_id: null, parent_step_id: null }));
  assert.deepEqual(store.getGuide(id).stepsOrder, [second.stepId, third.stepId, first.stepId]);
  assert.equal(store.getStep(id, second.stepId).parentStepId, null);

  assert.match((await call('move_step', { guide_id: id, step_id: first.stepId })).content[0].text, /Give after_step_id/);
  assert.match((await call('move_step', { guide_id: id, step_id: first.stepId, after_step_id: first.stepId })).content[0].text, /own substeps/);
  assert.match((await call('move_step', { guide_id: id, step_id: third.stepId, after_step_id: null, parent_step_id: first.stepId })).content[0].text, /break the step numbering/);

  const snaps = agentSnapshots(store, id);
  assert.equal(snaps.length, 2);
  restoreSnapshot(store, id, snaps[0]);
  assert.deepEqual(store.getGuide(id).stepsOrder, [first.stepId, second.stepId, third.stepId]);
  assert.equal(store.getStep(id, second.stepId).parentStepId, first.stepId);
});

test('agents replace and remove screenshots, and a snapshot gets the old one back', async (t) => {
  const { call, json, guide, first, second, store } = makeLibrary(t);
  const id = guide.guideId;
  const oldBytes = fs.readFileSync(store.stepImagePath(id, first.stepId, 'original'));
  await call('add_annotations', { guide_id: id, step_id: first.stepId, annotations: [{ type: 'rect', x: 12, y: 2, width: 4, height: 4 }] });

  const replaced = json(await call('set_screenshot', { guide_id: id, step_id: first.stepId, image_path: pngFile(t, 40, 30, [0, 0, 0, 255]) }));
  assert.deepEqual(replaced.screenshot_size, { width: 40, height: 30 });
  assert.equal(replaced.title, 'Screen capture', 'the text stays');
  assert.deepEqual(replaced.annotations.map((a) => a.type), ['blur', 'rect'], 'drawn annotations stay');
  // A step without a screenshot gets one.
  assert.equal(json(await call('set_screenshot', { guide_id: id, step_id: second.stepId, image_path: pngFile(t, 8, 8, [9, 9, 9, 255]) })).has_screenshot, true);
  assert.equal(store.getStep(id, second.stepId).kind, 'image');

  const removed = json(await call('remove_screenshot', { guide_id: id, step_id: first.stepId }));
  assert.equal(removed.has_screenshot, false);
  assert.equal(removed.annotations, undefined);
  const bare = store.getStep(id, first.stepId);
  assert.deepEqual([bare.image, bare.annotations, bare.kind], [null, [], 'content']);
  assert.deepEqual(fs.readdirSync(store.stepDir(id, first.stepId)), ['step.json']);
  assert.match((await call('remove_screenshot', { guide_id: id, step_id: first.stepId })).content[0].text, /no screenshot/);
  assert.match((await call('set_screenshot', { guide_id: id, step_id: first.stepId, image_path: '/no/such/file.png' })).content[0].text, /There's no file/);

  const snaps = agentSnapshots(store, id);
  assert.equal(snaps.length, 3);
  assert.match(snaps[2], /before_agent_removes_the_screenshot_of_step_1\.snapshot$/);
  restoreSnapshot(store, id, snaps[0]);
  const back = store.getStep(id, first.stepId);
  assert.ok(fs.readFileSync(store.stepImagePath(id, first.stepId, 'original')).equals(oldBytes));
  assert.deepEqual(back.annotations.map((a) => a.type), ['blur', 'rect']);
});

test('agents delete blocks and annotations, but never blurs, with a snapshot first', async (t) => {
  const { call, json, guide, first, store } = makeLibrary(t);
  const id = guide.guideId;
  await call('update_step', { guide_id: id, step_id: first.stepId, blocks: [{ kind: 'code', code: 'ls' }] });
  const drawn = json(await call('add_annotations', {
    guide_id: id, step_id: first.stepId,
    annotations: [{ type: 'rect', x: 12, y: 2, width: 4, height: 4 }, { type: 'arrow', from: [0, 0], to: [10, 5] }],
  })).added;
  const codeId = store.getStep(id, first.stepId).codeBlocks[0].id;

  const afterBlocks = json(await call('delete_blocks', { guide_id: id, step_id: first.stepId, block_ids: ['tb1'] }));
  assert.deepEqual(afterBlocks.blocks.map((b) => b.id), [codeId]);
  assert.match((await call('delete_blocks', { guide_id: id, step_id: first.stepId, block_ids: ['tb1'] })).content[0].text, /has no block "tb1"/);

  const blurRefused = await call('delete_annotations', { guide_id: id, step_id: first.stepId, annotation_ids: [drawn[0].id, 'b1'] });
  assert.equal(blurRefused.isError, true);
  assert.match(blurRefused.content[0].text, /"b1" is a blur/);
  assert.equal(store.getStep(id, first.stepId).annotations.length, 3, 'nothing is deleted when one is a blur');
  const afterAnnotations = json(await call('delete_annotations', { guide_id: id, step_id: first.stepId, annotation_ids: [drawn[0].id] }));
  assert.equal(afterAnnotations.annotations_on_step, 2);
  assert.deepEqual(store.getStep(id, first.stepId).annotations.map((a) => a.type), ['blur', 'arrow']);

  // Refused calls take no snapshot.
  const snaps = agentSnapshots(store, id);
  assert.equal(snaps.length, 2);
  restoreSnapshot(store, id, snaps[0]);
  const back = store.getStep(id, first.stepId);
  assert.deepEqual(back.textBlocks.map((b) => b.id), ['tb1']);
  assert.equal(back.annotations.length, 3);
});

test('agents move guides to the Trash with a snapshot, and the app hears about it', async (t) => {
  const { call, guide, store, changes } = makeLibrary(t);
  const result = await call('delete_guide', { guide_id: guide.guideId });
  assert.match(result.content[0].text, /Moved "Lab 5" to the Trash/);
  assert.equal(store.guideExists(guide.guideId), false);
  assert.deepEqual(changes, [guide.guideId]);
  const [trashed] = store.listTrash();
  assert.equal(store.restoreFromTrash(trashed), guide.guideId);
  assert.equal(agentSnapshots(store, guide.guideId).length, 1, 'the snapshot comes back with the guide');
  assert.equal(store.getGuide(guide.guideId).stepsOrder.length, 2);
  assert.match((await call('delete_guide', { guide_id: 'nope' })).content[0].text, /No guide with id/);
});

test('automatic pruning keeps agent snapshots, which keep their own newest 50', (t) => {
  const dir = makeTmpDir('agent-snapshots');
  t.after(() => rmrf(dir));
  const store = new GuideStore(dir);
  const { guideId } = store.createGuide({ title: 'G' });
  store.addStep(guideId, { title: 'S' }, TINY_PNG, { width: 1, height: 1 });
  createAgentSnapshot(store, guideId, 'deletes step 1');
  for (let i = 0; i < 3; i++) createSnapshot(store, guideId, { label: 'auto' });
  pruneSnapshots(store, guideId, 1);
  assert.equal(listSnapshots(store, guideId).length, 2, 'one automatic snapshot and the agent one');
  for (let i = 0; i < 55; i++) createAgentSnapshot(store, guideId, `deletes step ${i}`);
  const agents = agentSnapshots(store, guideId);
  assert.equal(agents.length, 50);
  assert.match(agents[0], /deletes_step_5\.snapshot$/, 'the oldest go first');
});
