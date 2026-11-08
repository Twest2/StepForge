'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const flow = require('../../core/flowchart');
const { renderFlowchart } = require('../../core/flowchart-raster');
const { rendererI18n } = require('./helpers');

function editorFixture() {
  const context = { ...rendererI18n(), window: { StepForgeFlowchart: flow }, crypto: require('node:crypto') };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../app/renderer/flowchart-editor.js'), 'utf8'), context);
  const editor = Object.create(context.window.FlowchartEditor.prototype);
  let graph = flow.normalizeGraph({ nodes: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], edges: [] });
  const viewport = { clientWidth: 600, clientHeight: 400, scrollLeft: 0, scrollTop: 0, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  editor.surface = { parentElement: viewport, getBoundingClientRect: () => ({ left: 0, top: 0 }), setPointerCapture() {}, hasPointerCapture: () => false, querySelector: () => ({ focus() {} }) };
  editor.getGraph = () => graph;
  editor.change = value => { graph = flow.normalizeGraph(value); };
  editor.render = () => {};
  editor.onToast = message => { throw new Error(message); };
  editor.zoom = 1; editor.tool = 'select';
  return { editor, viewport };
}

test('common shapes, dimensions and sanitized styling round-trip through SVG, Mermaid and raster output', () => {
  const graph = flow.normalizeGraph({ nodes: flow.TYPES.map((type, i) => ({ id: `n${i}`, type, label: type, x: 40 + i % 4 * 280, y: 40 + Math.floor(i / 4) * 180, width: 240, height: 110,
    style: { fill: '#f4f4f4', stroke: '#404040', textColor: '#202020', fontSize: 14, strokeWidth: 2 } })),
  edges: [{ id: 'e', from: 'n0', to: 'n1', kind: 'double', routing: 'straight', dashed: true, color: '#606060' }] });
  assert.deepEqual(graph.nodes.map(n => n.type), flow.TYPES);
  assert.equal(flow.edgePoints(graph.edges[0], graph.nodes).length, 2);
  const svg = flow.toSvg(graph);
  assert.match(svg, /stroke-dasharray="7 5"/);
  assert.match(svg, /fill="#f4f4f4"/);
  const mermaid = flow.toMermaid(graph);
  assert.match(mermaid, /shape: cyl/); assert.match(mermaid, /shape: doc/); assert.match(mermaid, /shape: cloud/);
  const image = renderFlowchart(graph);
  assert.ok(image.width > 1000 && image.height > 600);
  assert.ok(image.data.some((v, i) => i % 4 !== 3 && v < 200), 'actual shape outlines and labels were rasterized');
  const unsafe = flow.normalizeGraph({ nodes: [{ id: 'x', label: '<script>', type: 'document', width: 999999, height: -100, style: { fill: 'url(https://example.com)', stroke: 'red' } }], edges: [] });
  assert.equal(unsafe.nodes[0].width, 600); assert.equal(unsafe.nodes[0].height, 40);
  assert.doesNotMatch(flow.toSvg(unsafe), /https:|<script>/);
});

test('placing/resizing shapes and completing connectors always return to Select', () => {
  const { editor } = editorFixture();
  editor.tool = 'document';
  const target = { closest: () => null, dataset: {} };
  editor.pointerDown({ button: 0, target, clientX: 100, clientY: 100, pointerId: 1, preventDefault() {} });
  editor.pointerMove({ clientX: 260, clientY: 220, pointerId: 1 });
  editor.pointerUp({ pointerId: 1 });
  const node = editor.getGraph().nodes.at(-1);
  assert.equal(node.type, 'document'); assert.equal(node.width, 160); assert.equal(node.height, 120);
  assert.equal(editor.tool, 'select');
  editor.tool = 'connect'; editor.connectionKind = 'line'; editor.connect('a'); editor.connect('b');
  assert.equal(editor.getGraph().edges[0].kind, 'line'); assert.equal(editor.tool, 'select'); assert.equal(editor.connectFrom, null);
  const handle = { closest: () => ({ dataset: { nodeId: node.id } }), dataset: { resize: 'se' } };
  editor.pointerDown({ button: 0, target: handle, clientX: 260, clientY: 220, pointerId: 2, preventDefault() {} });
  editor.pointerMove({ clientX: 300, clientY: 260, pointerId: 2 }); editor.pointerUp({ pointerId: 2 });
  assert.equal(editor.getGraph().nodes.at(-1).width, 200); assert.equal(editor.getGraph().nodes.at(-1).height, 160);
  assert.equal(editor.tool, 'select');
});

test('zoom preserves the pointer location and scales the diagram grid without changing saved coordinates', () => {
  const { editor, viewport } = editorFixture();
  const before = JSON.stringify(editor.getGraph());
  const button = { classList: { toggle() {} }, setAttribute() {} };
  Object.assign(editor, { placement: {}, doneButton: {}, toolButtons: new Map(), connectButton: button, lineButton: button, zoomLabel: {}, getSteps: () => [], renderProperties() {} });
  Object.assign(editor.surface, { style: {}, classList: { toggle() {} }, setAttribute() {}, querySelector: () => ({ style: {}, setAttribute() {} }) });
  editor.render = Object.getPrototypeOf(editor).render;
  editor.render(); assert.equal(editor.surface.style.backgroundSize, '20px 20px');
  editor.setZoom(2, { x: 200, y: 100 });
  assert.equal(editor.surface.style.backgroundSize, '40px 40px');
  assert.equal(viewport.scrollLeft, 200); assert.equal(viewport.scrollTop, 100);
  assert.equal(JSON.stringify(editor.getGraph()), before);
  editor.setZoom(999); assert.equal(editor.zoom, 4);
  editor.setZoom(0); assert.equal(editor.zoom, .1);
});
