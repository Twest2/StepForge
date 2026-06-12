'use strict';

const path = require('node:path');
const { writeJsonSync, readJsonIfExists, htmlToText } = require('./util');
const { blockText } = require('./blocks');

/**
 * Local full-text search over guide titles, descriptions, step titles/
 * descriptions, text blocks, code blocks, annotation texts, and placeholder
 * values. Pure-JS inverted index persisted as JSON under library/index/
 * (fallback for SQLite FTS5 — see build/agent_audit.md).
 *
 * Documents are guide-level and step-level, so results can deep-link to a
 * specific step in the editor.
 */

const INDEX_VERSION = 1;

function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length >= 2);
}

class SearchIndex {
  constructor(indexDir) {
    this.file = path.join(indexDir, 'search-index.json');
    const stored = readJsonIfExists(this.file, null);
    if (stored && stored.version === INDEX_VERSION) {
      this.docs = stored.docs;
    } else {
      this.docs = {}; // docKey -> { guideId, stepId, title, text, updatedAt }
    }
  }

  persist() {
    writeJsonSync(this.file, { version: INDEX_VERSION, docs: this.docs });
  }

  /** (Re)index one guide and all of its steps. */
  indexGuide(guide, stepsMap) {
    this.removeGuide(guide.guideId, { persist: false });

    const placeholderText = Object.entries(guide.placeholders || {})
      .map(([k, v]) => `${k} ${v}`).join(' ');
    this.docs[`g:${guide.guideId}`] = {
      guideId: guide.guideId,
      stepId: null,
      title: guide.title,
      text: [htmlToText(guide.descriptionHtml), placeholderText].filter(Boolean).join('\n'),
      updatedAt: guide.updatedAt,
    };

    const steps = stepsMap instanceof Map ? [...stepsMap.values()] : stepsMap || [];
    for (const step of steps) {
      const parts = [
        htmlToText(step.descriptionHtml),
        ...(step.textBlocks || []).map((tb) => `${tb.title} ${htmlToText(tb.descriptionHtml)}`),
        ...(step.codeBlocks || []).map((cb) => blockText(cb)),
        ...(step.annotations || []).map((a) => a.text || ''),
      ];
      this.docs[`s:${guide.guideId}:${step.stepId}`] = {
        guideId: guide.guideId,
        stepId: step.stepId,
        title: step.title || '',
        text: parts.filter(Boolean).join('\n'),
        updatedAt: guide.updatedAt,
      };
    }
    this.persist();
  }

  removeGuide(guideId, { persist = true } = {}) {
    for (const key of Object.keys(this.docs)) {
      if (this.docs[key].guideId === guideId) delete this.docs[key];
    }
    if (persist) this.persist();
  }

  /**
   * Ranked search. Every query token must match (AND); the final token also
   * matches as a prefix so search-as-you-type works. Title hits rank above
   * body hits; guide docs rank above step docs on ties.
   */
  search(query, { limit = 30, guideId = null } = {}) {
    const qTokens = tokenize(query);
    if (qTokens.length === 0) return [];
    const results = [];

    for (const [key, doc] of Object.entries(this.docs)) {
      if (guideId && doc.guideId !== guideId) continue;
      const titleTokens = tokenize(doc.title);
      const textTokens = tokenize(doc.text);
      let score = 0;
      let matchedAll = true;

      for (let i = 0; i < qTokens.length; i++) {
        const q = qTokens[i];
        const prefixOk = i === qTokens.length - 1;
        const inTitle = titleTokens.filter((t) => t === q || (prefixOk && t.startsWith(q))).length;
        const inText = textTokens.filter((t) => t === q || (prefixOk && t.startsWith(q))).length;
        if (inTitle + inText === 0) { matchedAll = false; break; }
        score += inTitle * 10 + inText;
      }
      if (!matchedAll) continue;
      if (doc.stepId === null) score += 2;
      results.push({
        guideId: doc.guideId,
        stepId: doc.stepId,
        title: doc.title,
        snippet: makeSnippet(doc.text, qTokens),
        score,
      });
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /** Title-only search used by the library list filter. */
  searchTitles(query, { limit = 50 } = {}) {
    return this.search(query, { limit: limit * 4 })
      .filter((r) => r.stepId === null)
      .slice(0, limit);
  }
}

function makeSnippet(text, qTokens, span = 90) {
  if (!text) return '';
  const lower = text.toLowerCase();
  let at = -1;
  for (const q of qTokens) {
    at = lower.indexOf(q);
    if (at >= 0) break;
  }
  if (at < 0) return text.slice(0, span);
  const start = Math.max(0, at - span / 3);
  const out = text.slice(start, start + span).replace(/\s+/g, ' ').trim();
  return (start > 0 ? '…' : '') + out + (start + span < text.length ? '…' : '');
}

module.exports = { SearchIndex, tokenize };
