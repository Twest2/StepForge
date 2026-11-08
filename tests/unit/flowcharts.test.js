'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeTmpDir, rmrf } = require('./helpers');
const { GuideStore } = require('../../core/store');
const { Settings } = require('../../core/settings');
const { createAgentTools } = require('../../core/agent-tools');
const { TextIntelService } = require('../../app/text-intel');
const { buildRenderAst, renderStepImage, renderDiagramImage } = require('../../core/renderast');
const { prepareExportImages } = require('../../core/image-format');
const { runExport } = require('../../exporters');
const { exportGuideArchive, importGuideArchive } = require('../../core/archive');
const { createImage } = require('../../core/raster');
const { encodePng } = require('../../core/png');
const { unzipSync } = require('../../core/zip');
const { mergeValue } = require('../../core/guide-merge');
const flow = require('../../core/flowchart');

function setup(t) {
  const dir = makeTmpDir('flowcharts'); t.after(() => rmrf(dir));
  const store = new GuideStore(dir), guide = store.createGuide({ title: 'Account paths' });
  const first = store.addStep(guide.guideId, { title: 'Open website' }, encodePng(createImage(80, 60, [220, 30, 30, 255])), { width: 80, height: 60 });
  const target = store.addStep(guide.guideId, { title: 'Sign in' });
  const graph = flow.arrangeGraph({ nodes: [{ id: 'decision', type: 'decision', label: 'Have an account?' }, { id: 'signin', label: 'Sign in', stepId: target.stepId }], edges: [{ id: 'yes', from: 'decision', to: 'signin', label: 'Yes' }] });
  return { dir, store, guide, first, target, graph };
}

test('flowcharts and Markdown survive disk, archives, duplication and visual switching without changing screenshot bytes', t => {
  const { dir, store, guide, first, target, graph } = setup(t);
  const screenshot = fs.readFileSync(store.stepImagePath(guide.guideId, first.stepId));
  const source = '# Overview\n\n_Italic_ and **bold**\n\n[Go to Step](step:' + target.stepId + ')\n\n```js\nconst x = 1;\n```';
  store.saveStep(guide.guideId, { ...first, mainVisual: 'flowchart', flowchart: graph, descriptionMarkdown: source,
    flowchartBlocks: [{ id: 'branch', order: 1, graph }] });
  const reopened = new GuideStore(dir).getStep(guide.guideId, first.stepId);
  assert.equal(reopened.descriptionMarkdown, source);
  assert.match(reopened.descriptionHtml, /<em>Italic<\/em>/);
  assert.deepEqual(reopened.flowchart, graph);
  store.saveStep(guide.guideId, { ...reopened, mainVisual: 'image' });
  assert.deepEqual(store.getStep(guide.guideId, first.stepId).flowchart, graph);
  assert.deepEqual(fs.readFileSync(store.stepImagePath(guide.guideId, first.stepId)), screenshot);
  const file = path.join(dir, 'guide.sfgz'); exportGuideArchive(store, guide.guideId, file);
  const imported = new GuideStore(path.join(dir, 'imported'));
  const importedGuide = importGuideArchive(imported, file);
  const importedStep = imported.getStep(importedGuide.guideId, importedGuide.stepsOrder[0]);
  assert.equal(importedStep.descriptionMarkdown, source.replace(target.stepId, importedGuide.stepsOrder[1]));
  assert.equal(importedStep.flowchartBlocks[0].graph.nodes[1].stepId, importedGuide.stepsOrder[1]);
  const duplicate = store.duplicateGuide(guide.guideId), copied = store.getStep(duplicate.guideId, duplicate.stepsOrder[0]);
  assert.equal(copied.flowchart.nodes[1].stepId, duplicate.stepsOrder[1]);
  assert.equal(copied.flowchartBlocks[0].graph.nodes[1].stepId, duplicate.stepsOrder[1]);
  assert.match(copied.descriptionMarkdown, new RegExp(duplicate.stepsOrder[1]));
});

test('step references resolve after reorder, filtering and preview limits, using export numbers', t => {
  const { store, guide, first, target, graph } = setup(t);
  store.saveStep(guide.guideId, { ...first, mainVisual: 'flowchart', flowchart: graph, descriptionMarkdown: `[Go to Step](step:${target.stepId})` });
  let ast = buildRenderAst(store, guide.guideId);
  assert.match(ast.steps[0].descriptionHtml, /Go to Step 2/);
  assert.match(ast.steps[0].flowchart.mermaid, /Step 2: Sign in/);
  const g = store.getGuide(guide.guideId); g.stepsOrder.reverse(); store.saveGuide(g);
  ast = buildRenderAst(store, guide.guideId);
  assert.match(ast.steps[1].descriptionHtml, /Go to Step 1/);
  assert.match(ast.steps[1].flowchart.svg, /Step 1: Sign in/);
  store.saveStep(guide.guideId, { ...target, hidden: true });
  ast = buildRenderAst(store, guide.guideId);
  assert.match(ast.steps[0].descriptionText, /unavailable/);
  assert.doesNotMatch(ast.steps[0].descriptionHtml, /href="step:/);
  assert.match(ast.steps[0].flowchart.mermaid, /unavailable/);
});

test('flowcharts export as actual graphics in documents and Mermaid in Markdown, with no editor grid', async t => {
  const { dir, store, guide, first, target, graph } = setup(t);
  store.saveStep(guide.guideId, { ...first, mainVisual: 'flowchart', flowchart: graph,
    descriptionMarkdown: `\`\`\`javascript\nconst markup = "<b>";\n\`\`\`\n\n[Go to Step](step:${target.stepId})`, flowchartBlocks: [{ id: 'branch', graph, order: 1 }] });
  const images = await prepareExportImages(store, guide.guideId), ast = buildRenderAst(store, guide.guideId, { images });
  assert.ok(images.has(`flow:${first.stepId}:main`));
  assert.ok(renderStepImage(ast.steps[0]).width >= 560);
  assert.ok(renderDiagramImage(ast.steps[0].flowchartBlocks[0]).width >= 560);
  for (const format of ['html-simple', 'html-rich', 'markdown', 'wikijs', 'json', 'docx', 'pdf', 'pptx', 'confluence', 'clipboard', 'image-bundle']) {
    const result = runExport(format, ast, path.join(dir, format), { includeToc: false });
    if (format.startsWith('html')) {
      const html = fs.readFileSync(result.file, 'utf8');
      assert.match(html, /Have an account\?/); assert.match(html, /<svg/);
      assert.doesNotMatch(html, /radial-gradient|flowchart-toolbar|data-tool=/);
    } else if (format === 'markdown' || format === 'wikijs') {
      const md = fs.readFileSync(result.file, 'utf8');
      assert.equal((md.match(/```mermaid/g) || []).length, 2);
      assert.match(md, /```javascript\nconst markup = "<b>";/);
    } else if (format === 'docx' || format === 'pptx') {
      const zip = unzipSync(fs.readFileSync(result.file));
      assert.ok(zip.filter(e => /\/media\/image.*\.png$/.test(e.name)).length >= 2, format);
      if (format === 'docx') assert.match(zip.find(e => e.name === 'word/document.xml').data.toString(), /w:hyperlink w:anchor="toc_2"/);
    } else if (format === 'pdf') {
      assert.ok(fs.readFileSync(result.file).includes(Buffer.from('/Subtype /Image')));
      assert.ok(fs.readFileSync(result.file).includes(Buffer.from('/Subtype /Link')), 'step link works without a contents page');
    }
    else if (format === 'json') {
      const doc = JSON.parse(fs.readFileSync(result.file));
      assert.deepEqual(doc.steps[0].flowchart.graph, graph);
      assert.equal(doc.steps[0].blocks[0].graph.nodes.length, 2);
      assert.equal(doc.steps[0].blocks[0].png, undefined);
    }
  }
});

test('copying Markdown remaps inline and reference-style step links while leaving code examples intact', () => {
  const { remapStepReferences } = require('../../core/step-references');
  const source = '[next](step:old)\n\n[next-ref]: <step:old>\n\n`[code](step:old)`\n\n~~~md\n[example](step:old)\n~~~';
  const step = { descriptionMarkdown: source, descriptionHtml: '<a href="step:old">next</a>' };
  remapStepReferences(step, new Map([['old', 'new']]));
  assert.match(step.descriptionMarkdown, /\[next\]\(step:new\)/);
  assert.match(step.descriptionMarkdown, /\[next-ref\]: <step:new>/);
  assert.match(step.descriptionMarkdown, /`\[code\]\(step:old\)`/);
  assert.match(step.descriptionMarkdown, /~~~md\n\[example\]\(step:old\)\n~~~/);
});

test('committing a node drag preserves concurrent label edits on another node', () => {
  const vm = require('node:vm');
  const context = { window: { StepForgeFlowchart: flow }, crypto: require('node:crypto') };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/flowchart-editor.js'), 'utf8'), context);
  const editor = Object.create(context.window.FlowchartEditor.prototype);
  const graph = flow.normalizeGraph({ nodes: [{ id: 'a', label: 'First' }, { id: 'b', label: 'Agent edited this' }], edges: [] });
  editor.selected = 'a'; editor.getGraph = () => graph;
  editor.drag = { node: { id: 'a', x: 160, y: 200 }, x: 40, y: 40, pointerId: 1 };
  editor.surface = { hasPointerCapture: () => false, querySelector: () => ({ focus() {} }) };
  let saved;
  editor.change = value => { saved = value; };
  editor.pointerUp({ pointerId: 1 });
  assert.equal(saved.nodes[0].x, 160);
  assert.equal(saved.nodes[1].label, 'Agent edited this');
});

test('graph validation rejects duplicate/dangling references and SVG/Mermaid output escapes labels', () => {
  assert.throws(() => flow.validateGraph({ nodes: [{ id: 'a' }, { id: 'a' }], edges: [] }), /unique/);
  assert.throws(() => flow.validateGraph({ nodes: [{ id: 'a' }], edges: [{ from: 'a', to: 'b' }] }), /existing/);
  assert.throws(() => flow.validateGraph({ nodes: [{ id: 'a', stepId: 'missing' }], edges: [] }, new Set()), /not in this guide/);
  const graph = { nodes: [{ id: 'a', label: '<script>alert("x")</script> [x] #"', type: 'decision' }], edges: [] };
  assert.doesNotMatch(flow.toSvg(graph), /<script>/);
  assert.match(flow.toSvg(graph), /&lt;script&gt;/);
  assert.doesNotMatch(flow.toMermaid(graph), /<script>|\[x\]/);
  const cycle = flow.arrangeGraph({ nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] });
  assert.notEqual(cycle.nodes[0].y, cycle.nodes[1].y);
});

test('AI generation uses the configured provider and returns a validated draft without saving it', async t => {
  const { dir, store, guide, first, graph } = setup(t);
  for (const provider of ['ollama', 'openai']) {
    const settings = new Settings(store.settingsDir); settings.set('ai.enabled', true);
    settings.set('ai.provider', provider); settings.set('ai.ollama', { host: 'http://127.0.0.1:11434', model: 'test' });
    settings.set('ai.openai', { baseUrl: 'http://127.0.0.1:1234/v1', model: 'test' });
    const service = new TextIntelService({ store, settings, dataDir: dir });
    service.callOllama = async args => {
      assert.equal(args.provider, provider); assert.equal(args.guideId, guide.guideId);
      assert.match(args.prompt, /Open website/); return JSON.stringify(graph);
    };
    const result = await service.generateFlowchart({ guideId: guide.guideId, request: 'Create a guide overview' });
    assert.equal(result.ok, true, result.reason); assert.equal(result.graph.nodes.length, 2);
    assert.equal(store.getStep(guide.guideId, first.stepId).flowchart, null);
    service.callOllama = async () => '{"nodes":[{"id":"x","stepId":"missing"}],"edges":[]}';
    assert.equal((await service.generateFlowchart({ guideId: guide.guideId, request: 'Test' })).ok, false);
  }
});

test('MCP agents create both placements with snapshots and cannot write dangling step references', async t => {
  const { store, guide, first, graph } = setup(t);
  const settings = new Settings(store.settingsDir); settings.set('ai.agents.enabled', true);
  const tools = createAgentTools({ store, settings, agentSettings: () => settings.get('ai.agents'), onChange: () => {} });
  const set = tools.find(t => t.name === 'set_flowchart');
  for (const placement of ['main', 'block']) {
    const result = await set.handler({ guide_id: guide.guideId, step_id: first.stepId, placement, graph });
    assert.equal(result.isError, undefined);
    assert.match(result.content[1].text, /snapshot/);
  }
  const saved = store.getStep(guide.guideId, first.stepId);
  assert.deepEqual(saved.flowchart, graph); assert.equal(saved.flowchartBlocks.length, 1); assert.ok(saved.image);
  const error = await set.handler({ guide_id: guide.guideId, step_id: first.stepId, placement: 'main', graph: { nodes: [{ id: 'a', stepId: 'missing' }], edges: [] } });
  assert.equal(error.isError, true);
});

test('Markdown descriptions support CommonMark structure and keep source and HTML together in merges', () => {
  const { createStep } = require('../../core/schema');
  const source = '###### Heading\n\n_Italic_ and ~~old~~\n\n> - **nested**\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n[ref][docs]\n\n[docs]: https://example.com\n\n<script>alert(1)</script>\n\n![alt](https://example.com/image.png)';
  const step = createStep({ descriptionMarkdown: source });
  assert.match(step.descriptionHtml, /<h6>Heading<\/h6>/);
  assert.match(step.descriptionHtml, /<em>Italic<\/em>/);
  assert.match(step.descriptionHtml, /<s>old<\/s>/);
  assert.match(step.descriptionHtml, /<table>/);
  assert.match(step.descriptionHtml, /href="https:\/\/example.com"/);
  assert.doesNotMatch(step.descriptionHtml, /<script>|<img/);
  const base = { descriptionMarkdown: 'A', descriptionHtml: '<p>A</p>', title: 'A' };
  const local = { ...base, title: 'New title' };
  const agent = { title: 'A', descriptionHtml: '<p>Agent rewrite</p>' };
  const merged = mergeValue(base, [local, agent], { conflicts: 0 });
  assert.equal(merged.title, 'New title');
  assert.equal(merged.descriptionMarkdown, undefined);
  assert.equal(merged.descriptionHtml, '<p>Agent rewrite</p>');
});
