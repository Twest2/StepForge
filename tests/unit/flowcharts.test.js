'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { makeTmpDir, rmrf } = require('./helpers');
const { GuideStore } = require('../../core/store');
const { Settings } = require('../../core/settings');
const { encodePng } = require('../../core/png');
const { createImage } = require('../../core/raster');
const flow = require('../../core/flowchart');
const { parseFlowchart } = require('../../core/ai-flowchart');
const { prepareExportImages, flowchartImageKey } = require('../../core/image-format');
const { buildRenderAst } = require('../../core/renderast');
const { runExport } = require('../../exporters');
const { createAgentTools } = require('../../core/agent-tools');

const CHART = {
  nodes: [
    { id: 'a', shape: 'terminal', label: 'Start', x: 40, y: 40 },
    { id: 'b', shape: 'decision', label: 'Have an account?', x: 40, y: 140 },
    { id: 'c', shape: 'process', label: 'Sign in', x: 40, y: 300 },
  ],
  edges: [{ id: 'e1', from: 'a', to: 'b' }, { id: 'e2', from: 'b', to: 'c', label: 'Yes' }],
};

function library(t) {
  // shot: a step with a screenshot; second: a text-only step.
  const dir = makeTmpDir('flowcharts');
  t.after(() => rmrf(dir));
  const store = new GuideStore(dir);
  const guide = store.createGuide({ title: 'Accounts' });
  const shot = store.addStep(guide.guideId, { title: 'Open the site' }, encodePng(createImage(40, 20, [200, 200, 200, 255])), { width: 40, height: 20 });
  const second = store.addStep(guide.guideId, { title: 'Sign in' });
  return { dir, store, guide, shot, second };
}

test('a stored flowchart is cleaned: bad shapes, duplicate ids and dangling arrows are fixed or dropped', () => {
  const g = flow.normalizeFlowchart({
    nodes: [{ id: 'a', shape: 'star', label: 'One' }, { id: 'a', label: 'Two' }, { id: 'c', label: 'x'.repeat(500), stepId: '../bad' }],
    edges: [{ from: 'a', to: 'c' }, { from: 'a', to: 'missing' }, { from: 'c', to: 'c' }],
  });
  assert.equal(g.nodes.length, 3);
  assert.equal(g.nodes[0].shape, 'process');
  assert.notEqual(g.nodes[1].id, 'a');
  assert.equal(g.nodes[2].label.length, 300);
  assert.equal(g.nodes[2].stepId, null);
  assert.equal(g.edges.length, 1);
  assert.equal(flow.normalizeFlowchart(null), null);
});

test('arrange puts each node one row below the node that leads to it, without overlaps', () => {
  const g = flow.arrange({
    nodes: [{ id: 'd', shape: 'decision', label: 'Q?' }, { id: 'y', label: 'Yes path' }, { id: 'n', label: 'No path' }],
    edges: [{ from: 'd', to: 'y' }, { from: 'd', to: 'n' }],
  });
  const [d, y, n] = g.nodes;
  assert.ok(y.y > d.y && n.y === y.y);
  assert.ok(Math.abs(y.x - n.x) >= flow.nodeBox(y).w);
});

test('the SVG escapes labels and shows a linked node’s current step number', () => {
  const svg = flow.toSvg({ nodes: [{ id: 'a', label: '<script>&', stepId: 's2' }], edges: [] }, { steps: [{ stepId: 's2', number: '4' }] });
  assert.match(svg, /&lt;script&gt;&amp;/);
  assert.doesNotMatch(svg, /<script/);
  assert.match(svg, /→ Step 4/);
});

test('AI output becomes a laid-out flowchart; unknown step ids are dropped and "type" is read as the shape', () => {
  const g = parseFlowchart({ nodes: [{ id: 'n1', type: 'decision', label: 'Q', stepId: 'nope' }, { id: 'n2', label: 'Do it', stepId: 's1' }], edges: [{ from: 'n1', to: 'n2', label: 'Yes' }] }, [{ stepId: 's1' }]);
  assert.equal(g.nodes[0].shape, 'decision');
  assert.equal(g.nodes[0].stepId, null);
  assert.equal(g.nodes[1].stepId, 's1');
  assert.throws(() => parseFlowchart({ nodes: [] }, []), /did not return a flowchart/);
});

test('steps save their flowchart and where it goes', (t) => {
  const { store, guide, second } = library(t);
  store.saveStep(guide.guideId, { ...store.getStep(guide.guideId, second.stepId), flowchart: CHART, flowchartPlacement: 'block' });
  const saved = store.getStep(guide.guideId, second.stepId);
  assert.deepEqual(saved.flowchart.nodes.map((n) => n.id), ['a', 'b', 'c']);
  assert.equal(saved.flowchartPlacement, 'block');
});

test('exports: a main-visual flowchart replaces the screenshot; a block flowchart follows the step text', async (t) => {
  const { dir, store, guide, shot, second } = library(t);
  store.saveStep(guide.guideId, { ...store.getStep(guide.guideId, shot.stepId), flowchart: CHART, flowchartPlacement: 'visual' });
  store.saveStep(guide.guideId, { ...store.getStep(guide.guideId, second.stepId), flowchart: CHART, flowchartPlacement: 'block' });
  const images = await prepareExportImages(store, guide.guideId);
  assert.ok(images.get(flowchartImageKey(shot.stepId)).length > 1000);
  const ast = buildRenderAst(store, guide.guideId, { images });
  const [first, next] = ast.steps;
  assert.equal(first.image.flowchart, true);
  assert.deepEqual(first.annotations, []);
  assert.match(first.altText, /^Flowchart for step 1/);
  assert.equal(next.image, null);
  assert.equal(next.blocks.at(-1).kind, 'flowchart');
  assert.ok(next.flowchartImage.png);

  const out = path.join(dir, 'out');
  fs.mkdirSync(out);
  const html = fs.readFileSync(runExport('html-simple', ast, out).file, 'utf8');
  assert.equal((html.match(/data:image\/png;base64/g) || []).length, 2);
  assert.match(html, /alt="Flowchart for step 2/);
  const md = fs.readFileSync(runExport('markdown', ast, out).file, 'utf8');
  assert.match(md, /-flowchart\.png\)/);
  for (const format of ['pdf', 'docx', 'json']) assert.ok(fs.statSync(runExport(format, ast, out).file).size > 0, format);
});

test('description step links show the target’s number in the export, after steps move', (t) => {
  const { store, guide, shot, second } = library(t);
  store.saveStep(guide.guideId, {
    ...store.getStep(guide.guideId, shot.stepId),
    descriptionHtml: `<p>Then see <a href="step:${second.stepId}" data-step-id="${second.stepId}">Step 2</a>.</p>`,
  });
  const g = store.getGuide(guide.guideId);
  store.saveGuide({ ...g, stepsOrder: [second.stepId, shot.stepId] });
  const ast = buildRenderAst(store, guide.guideId);
  const linking = ast.steps.find((s) => s.stepId === shot.stepId);
  assert.match(linking.descriptionHtml, />Step 1<\/a>/);
  assert.match(linking.descriptionText, /Step 1/);
});

test('MCP set_flowchart lays out, saves and removes a step’s flowchart', async (t) => {
  const { store, guide, shot, second } = library(t);
  new Settings(store.settingsDir).set('ai.agents', { enabled: true, screenshots: true });
  const tools = createAgentTools({ store, agentSettings: () => new Settings(store.settingsDir).get('ai.agents') });
  const call = (args) => tools.find((tool) => tool.name === 'set_flowchart').handler(args);
  await call({
    guide_id: guide.guideId, step_id: shot.stepId,
    nodes: [{ id: 's', shape: 'terminal', label: 'Start' }, { id: 'x', label: 'Sign in', step_id: second.stepId }],
    edges: [{ from: 's', to: 'x' }],
  });
  const saved = store.getStep(guide.guideId, shot.stepId);
  assert.equal(saved.flowchart.nodes[1].stepId, second.stepId);
  assert.ok(saved.flowchart.nodes[1].y > saved.flowchart.nodes[0].y);
  assert.equal(saved.flowchartPlacement, 'block', 'a step with a screenshot keeps it by default');
  assert.ok(saved.image, 'the screenshot is kept');
  const bad = await call({ guide_id: guide.guideId, step_id: shot.stepId, nodes: [{ id: 's', label: 'A' }], edges: [{ from: 's', to: 'zz' }] });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /edge/);
  await call({ guide_id: guide.guideId, step_id: shot.stepId, nodes: [] });
  assert.equal(store.getStep(guide.guideId, shot.stepId).flowchart, null);
});
