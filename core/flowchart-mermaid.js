'use strict';

/**
 * Flowcharts as Mermaid text, both ways (the editor's Mermaid panel).
 *
 * toMermaid(graph) writes `flowchart TD` text with short node names (n1, n2,
 * …) and returns those names' node ids. fromMermaid(text, graph, ids) reads
 * Mermaid flowchart text back into a graph: nodes it already knew (by those
 * names) keep their place, size, colors, picture and step link; new nodes are
 * placed under the node that leads to them (or the whole chart is laid out
 * when it was empty).
 *
 * Read: node shapes ([ ], ( ), ([ ]), (( )), { }, {{ }}, [/ /], [/ \], [( )],
 * [[ ]], > ], and A@{ shape: …, label: … }), arrows (-->, ---, -.->, -.-, ==>,
 * <-->, ~~~), labels (-->|Yes| and -- Yes -->), chains (A --> B --> C) and
 * A & B --> C. Comments, styles, classes, clicks and subgraphs are skipped.
 */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./flowchart') : root.StepForgeFlowchart);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StepForgeFlowchartMermaid = api;
})(typeof window === 'object' ? window : globalThis, function (flow) {
  // StepForge shape → Mermaid bracket syntax, or a Mermaid v11 `@{ shape }` name.
  const BRACKETS = {
    process: ['(', ')'], rectangle: ['[', ']'], square: ['[', ']'], terminal: ['([', '])'], ellipse: ['((', '))'],
    circle: ['((', '))'], decision: ['{', '}'], hexagon: ['{{', '}}'], parallelogram: ['[/', '/]'], trapezoid: ['[/', '\\]'],
    cylinder: ['[(', ')]'], subprocess: ['[[', ']]'], step: ['>', ']'],
  };
  const NAMED = {
    document: 'doc', cloud: 'cloud', card: 'notch-rect', delay: 'delay', internalStorage: 'win-pane', display: 'curv-trap',
    tape: 'flag', dataStorage: 'bow-rect', triangle: 'tri', text: 'text', note: 'doc', callout: 'rect', cube: 'rect',
    actor: 'rect', container: 'rect', blockArrow: 'rect', doubleArrow: 'rect',
  };
  // Mermaid → StepForge, for reading.
  const FROM_BRACKET = [
    ['(((', ')))', 'circle'], ['((', '))', 'circle'], ['([', '])', 'terminal'], ['[(', ')]', 'cylinder'], ['[[', ']]', 'subprocess'],
    ['{{', '}}', 'hexagon'], ['[/', '/]', 'parallelogram'], ['[\\', '\\]', 'parallelogram'], ['[/', '\\]', 'trapezoid'],
    ['[\\', '/]', 'trapezoid'], ['(', ')', 'process'], ['[', ']', 'rectangle'], ['{', '}', 'decision'], ['>', ']', 'step'],
  ];
  const FROM_NAMED = {
    rect: 'rectangle', rounded: 'process', stadium: 'terminal', pill: 'terminal', circle: 'circle', circ: 'circle', 'sm-circ': 'circle',
    'fr-circ': 'circle', 'dbl-circ': 'circle', diam: 'decision', diamond: 'decision', decision: 'decision', hex: 'hexagon',
    hexagon: 'hexagon', prepare: 'hexagon', 'lean-r': 'parallelogram', 'lean-l': 'parallelogram', 'in-out': 'parallelogram',
    'trap-b': 'trapezoid', 'trap-t': 'trapezoid', cyl: 'cylinder', database: 'cylinder', db: 'cylinder', subproc: 'subprocess',
    subprocess: 'subprocess', doc: 'document', document: 'document', cloud: 'cloud', 'notch-rect': 'card', card: 'card',
    delay: 'delay', 'win-pane': 'internalStorage', 'internal-storage': 'internalStorage', 'curv-trap': 'display', display: 'display',
    flag: 'tape', 'paper-tape': 'tape', 'bow-rect': 'dataStorage', 'stored-data': 'dataStorage', tri: 'triangle', triangle: 'triangle',
    text: 'text', 'odd': 'step', start: 'circle', stop: 'circle', terminal: 'terminal', process: 'process', proc: 'process',
  };
  const ARROWS = { arrow: '-->', double: '<-->', line: '---', dashed: '-.->', dashedLine: '-.-', dotted: '-.-' };

  const quote = (label) => `"${String(label || '').replace(/"/g, '#quot;').replace(/\n/g, ' ')}"`;
  const unquote = (text) => {
    let s = String(text).trim();
    if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1);
    return s.replace(/#quot;/g, '"').replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim();
  };
  /** The Mermaid way a StepForge shape is written (for keeping shapes Mermaid can't name). */
  const mermaidShape = (shape) => (BRACKETS[shape] ? BRACKETS[shape].join('') : `@${NAMED[shape] || 'rect'}`);

  function toMermaid(raw) {
    const graph = flow.normalizeFlowchart(raw) || { nodes: [], edges: [] };
    const names = new Map(graph.nodes.map((n, i) => [n.id, `n${i + 1}`]));
    const lines = ['flowchart TD'];
    for (const n of graph.nodes) {
      const name = names.get(n.id);
      if (BRACKETS[n.shape]) {
        const [open, close] = BRACKETS[n.shape];
        lines.push(`  ${name}${open}${quote(n.label)}${close}`);
      } else {
        lines.push(`  ${name}@{ shape: ${NAMED[n.shape] || 'rect'}, label: ${quote(n.label)} }`);
      }
    }
    for (const e of graph.edges) {
      const label = !e.label ? '' : /^[\w ?!.,'-]+$/.test(e.label) ? `|${e.label}|` : `|${quote(e.label)}|`;
      lines.push(`  ${names.get(e.from)} ${ARROWS[e.style || 'arrow']}${label} ${names.get(e.to)}`);
    }
    return { text: `${lines.join('\n')}\n`, ids: new Map([...names].map(([id, name]) => [name, id])) };
  }

  class MermaidError extends Error {
    constructor(line, message) {
      super(`Line ${line}: ${message}`);
      this.line = line;
    }
  }

  /** Parse Mermaid flowchart text: { nodes: Map name → { shape, label, mermaid }, edges: [{ from, to, label, style }] }. */
  function parse(text) {
    const nodes = new Map();
    const order = [];
    const edges = [];
    const touch = (name) => {
      if (!nodes.has(name)) { nodes.set(name, { label: null, shape: null, mermaid: null }); order.push(name); }
      return nodes.get(name);
    };
    const statements = [];
    String(text || '').split('\n').forEach((line, i) => {
      const clean = line.replace(/%%.*$/, '');
      for (const part of clean.split(';')) if (part.trim()) statements.push({ text: part, line: i + 1 });
    });
    for (const { text: statement, line } of statements) {
      const s = statement.trim();
      if (/^(flowchart|graph)\b/i.test(s)) continue;
      if (/^subgraph\b/i.test(s)) continue;
      if (/^end$/i.test(s)) continue;
      if (/^(direction|classDef|class|style|linkStyle|click|accTitle|accDescr|title)\b/i.test(s)) continue;
      let pos = 0;
      const rest = () => statement.slice(pos);
      const space = () => { while (pos < statement.length && /\s/.test(statement[pos])) pos += 1; };

      const readNode = () => {
        space();
        const id = /^[A-Za-z0-9_][A-Za-z0-9_-]*/.exec(rest());
        if (!id) throw new MermaidError(line, 'expected a node name.');
        let name = id[0];
        // "A-->B": a name doesn't swallow the start of an arrow.
        const arrowInside = /-(?=[-.>])/.exec(name);
        if (arrowInside) name = name.slice(0, arrowInside.index);
        pos += name.length;
        const node = touch(name);
        if (rest().startsWith('@{')) {
          const end = statement.indexOf('}', pos);
          if (end < 0) throw new MermaidError(line, 'missing } after @{.');
          const body = statement.slice(pos + 2, end);
          const shape = /shape\s*:\s*([A-Za-z-]+)/.exec(body);
          const label = /label\s*:\s*("[^"]*"|[^,}]+)/.exec(body);
          if (shape) { node.shape = FROM_NAMED[shape[1]] || 'rectangle'; node.mermaid = `@${shape[1]}`; }
          if (label) node.label = unquote(label[1]);
          else if (node.label === null) node.label = name;
          pos = end + 1;
          return name;
        }
        for (const [open, close, shape] of FROM_BRACKET) {
          if (!rest().startsWith(open)) continue;
          let start = pos + open.length;
          let end;
          if (statement[start] === '"') {
            const q = statement.indexOf('"', start + 1);
            if (q < 0) throw new MermaidError(line, 'missing closing ".');
            end = statement.indexOf(close, q + 1);
          } else {
            end = statement.indexOf(close, start);
          }
          if (end < 0) continue;
          node.label = unquote(statement.slice(start, end));
          node.shape = shape;
          node.mermaid = `${open}${close}`;
          pos = end + close.length;
          return name;
        }
        if (node.label === null) node.label = name;
        return name;
      };
      const readGroup = () => {
        const names = [readNode()];
        for (;;) {
          space();
          if (statement[pos] !== '&') return names;
          pos += 1;
          names.push(readNode());
        }
      };
      const readArrow = () => {
        space();
        const r = rest();
        let m = /^(<?)(-{2,}>|={2,}>|-\.+->|-{3,}|={3,}|-\.+-|~{3,}|--[ox])(?:\|([^|]*)\|)?/.exec(r);
        if (m) {
          pos += m[0].length;
          return { style: arrowStyle(m[1], m[2]), label: m[3] ? unquote(m[3]) : '' };
        }
        m = /^(<?)(--|==|-\.)\s*([^-=.>|][^>]*?)\s*(-{2,}>|={2,}>|\.->|-{2,}|={2,}|\.-)(?![->])/.exec(r);
        if (m) {
          pos += m[0].length;
          return { style: arrowStyle(m[1], `${m[2]}${m[4]}`), label: unquote(m[3]) };
        }
        return null;
      };

      let from = readGroup();
      for (;;) {
        const arrow = readArrow();
        if (!arrow) break;
        const to = readGroup();
        for (const a of from) for (const b of to) if (a !== b) edges.push({ from: a, to: b, label: arrow.label, style: arrow.style });
        from = to;
      }
      space();
      if (pos < statement.length) throw new MermaidError(line, `StepForge can't read "${statement.slice(pos).trim().slice(0, 30)}".`);
    }
    return { nodes: new Map(order.map((n) => [n, nodes.get(n)])), edges };
  }

  function arrowStyle(back, body) {
    const dashed = body.includes('.');
    const head = body.endsWith('>');
    if (head && back) return 'double';
    if (dashed) return head ? 'dashed' : 'dashedLine';
    if (body.startsWith('~')) return 'line';
    return head ? 'arrow' : 'line';
  }

  /**
   * The graph Mermaid `text` describes. `graph` and `ids` (from the last
   * toMermaid) let nodes it already had keep everything Mermaid doesn't say.
   * Throws an Error naming the line it couldn't read.
   */
  function fromMermaid(text, graph, ids = new Map()) {
    const parsed = parse(text);
    const current = flow.normalizeFlowchart(graph) || { nodes: [], edges: [] };
    const byId = new Map(current.nodes.map((n) => [n.id, n]));
    const known = new Map();
    for (const [name, id] of ids) if (byId.has(id)) known.set(name, byId.get(id));
    const nodes = [];
    const nameToId = new Map();
    const fresh = [];
    for (const [name, p] of parsed.nodes) {
      const old = known.get(name);
      // Keep a shape Mermaid only approximates (a cube is written as rect).
      const shape = old && (!p.mermaid || p.mermaid === mermaidShape(old.shape)) ? old.shape : (p.shape || 'rectangle');
      const node = old
        ? { ...old, shape, label: p.label ?? old.label }
        : { id: flow.newId('node'), shape, label: p.label ?? name, x: 0, y: 0, stepId: null };
      if (!old) fresh.push(node);
      nodes.push(node);
      nameToId.set(name, node.id);
    }
    const oldEdges = new Map(current.edges.map((e) => [`${e.from}>${e.to}`, e]));
    const edges = parsed.edges.map((e) => {
      const from = nameToId.get(e.from);
      const to = nameToId.get(e.to);
      const old = oldEdges.get(`${from}>${to}`);
      return { id: old ? old.id : flow.newId('edge'), from, to, label: e.label, ...(e.style !== 'arrow' ? { style: e.style } : {}) };
    });
    const result = { nodes, edges };
    if (!fresh.length) return flow.normalizeFlowchart(result);
    if (fresh.length === nodes.length) return flow.arrange(result);
    // New nodes go under the node that leads to them (else under the chart),
    // moved right until they don't overlap a shape already placed.
    const placed = nodes.filter((n) => !fresh.includes(n));
    const overlaps = (node) => {
      const a = flow.nodeBox(node);
      return placed.some((other) => {
        const b = flow.nodeBox(other);
        return a.x < b.x + b.w + 20 && b.x < a.x + a.w + 20 && a.y < b.y + b.h + 20 && b.y < a.y + a.h + 20;
      });
    };
    const bottom = Math.max(...placed.map((n) => n.y + flow.nodeBox(n).h));
    const left = Math.min(...placed.map((n) => n.x));
    for (const node of fresh) {
      const parentEdge = edges.find((e) => e.to === node.id && placed.some((n) => n.id === e.from));
      const parent = parentEdge && placed.find((n) => n.id === parentEdge.from);
      node.x = parent ? parent.x : left;
      node.y = parent ? parent.y + flow.nodeBox(parent).h + 60 : bottom + 60;
      for (let i = 0; i < 50 && overlaps(node); i += 1) node.x += 220;
      placed.push(node);
    }
    return flow.normalizeFlowchart(result);
  }

  /**
   * Mermaid text cut into colored pieces for the editor: [{ text, kind }]
   * with kind one of keyword, direction, node, arrow, shape, string, label,
   * attr, comment, or null for plain text. Joined, the pieces are the text.
   */
  function tokens(text) {
    const out = [];
    const push = (piece, kind) => { if (piece) out.push({ text: piece, kind }); };
    const OPENERS = new Set(['[', '(', '{', '((', '(((', '([', '[(', '[[', '{{', '[/', '[\\', '>']);
    for (const [index, line] of String(text || '').split('\n').entries()) {
      if (index) push('\n', null);
      const comment = line.indexOf('%%');
      let code = comment >= 0 ? line.slice(0, comment) : line;
      let header = false;
      while (code) {
        let m;
        if ((m = /^\s+/.exec(code))) push(m[0], null);
        else if ((m = /^(flowchart|graph|subgraph|end|direction|classDef|class|style|linkStyle|click)\b/.exec(code))) {
          push(m[0], 'keyword');
          header = /^(flowchart|graph|direction)$/.test(m[0]);
        } else if (header && (m = /^(TD|TB|BT|RL|LR)\b/.exec(code))) push(m[0], 'direction');
        else if ((m = /^"[^"]*"?/.exec(code))) push(m[0], 'string');
        else if ((m = /^\|[^|]*\|?/.exec(code))) push(m[0], 'label');
        else if ((m = /^<?(?:-{2,}>|={2,}>|-\.+->|-{3,}|={3,}|-\.+-|~{3,}|--[ox]|\.->|\.-|--|==|-\.)/.exec(code))) push(m[0], 'arrow');
        else if ((m = /^(shape)(\s*:\s*)([A-Za-z-]+)/.exec(code))) { push(m[1], 'attr'); push(m[2], null); push(m[3], 'string'); }
        else if ((m = /^(label)(\s*:)/.exec(code))) { push(m[1], 'attr'); push(m[2], null); }
        else if ((m = /^(\(\(\(|\)\)\)|\(\[|\]\)|\[\(|\)\]|\[\[|\]\]|\{\{|\}\}|\[\/|\/\]|\[\\|\\\]|@\{|[[\](){}>&;,/\\])/.exec(code))) {
          push(m[0], 'shape');
          // An opening bracket's unquoted text, up to its closing bracket, is the label.
          if (OPENERS.has(m[0])) {
            code = code.slice(m[0].length);
            const label = /^[^"\])}/\\\n]+/.exec(code);
            if (label) { push(label[0], 'string'); code = code.slice(label[0].length); }
            continue;
          }
        } else if ((m = /^[A-Za-z0-9_]+(?:-(?![-.>])[A-Za-z0-9_]+)*/.exec(code))) push(m[0], 'node');
        else m = [code[0]], push(code[0], null);
        code = code.slice(m[0].length);
      }
      if (comment >= 0) push(line.slice(comment), 'comment');
    }
    return out;
  }

  return { toMermaid, fromMermaid, parse, tokens };
});
