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

const INDEX_VERSION = 2;

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
    // Per-guide source fingerprints so a startup reconcile can tell which
    // guides changed while the app was closed, without re-reading every step.
    this.fingerprints = {}; // guideId -> fingerprint string
    // Recovery status surfaced to the UI: 'ok' | 'reset' (missing/corrupt/
    // version mismatch) | 'reconciled' (rebuilt from the store at startup).
    this.status = 'ok';
    const fileExisted = require('node:fs').existsSync(this.file);
    const stored = readJsonIfExists(this.file, null);
    if (stored && stored.version === INDEX_VERSION && stored.docs && typeof stored.docs === 'object') {
      this.docs = stored.docs;
      this.fingerprints = stored.fingerprints || {};
    } else {
      // Missing, corrupt, or an older index version: start empty and mark it,
      // so reconcile() rebuilds from the store instead of silently staying
      // blank (which made search "work" but return nothing). A file that
      // existed but could not be used is a 'reset' (recovery-worthy); a
      // genuinely absent index on first run is just 'ok'.
      this.docs = {}; // docKey -> { guideId, stepId, title, text, updatedAt }
      this.status = fileExisted ? 'reset' : 'ok';
    }
  }

  persist() {
    writeJsonSync(this.file, {
      version: INDEX_VERSION,
      docs: this.docs,
      fingerprints: this.fingerprints,
    });
  }

  static fingerprint(guide) {
    return `${guide.updatedAt || ''}:${Number.isInteger(guide.revision) ? guide.revision : 0}`;
  }

  /**
   * Reconcile the index against the store at startup: reindex guides that are
   * new or changed (by fingerprint), and drop index entries for guides that no
   * longer exist. Returns a summary with a recovery status for the UI.
   */
  reconcile(store) {
    const guides = store.listGuides();
    const liveIds = new Set(guides.map((g) => g.guideId));
    let reindexed = 0;
    let removed = 0;

    // Drop docs/fingerprints for guides that are gone.
    for (const key of Object.keys(this.fingerprints)) {
      if (!liveIds.has(key)) {
        this.removeGuide(key, { persist: false });
        delete this.fingerprints[key];
        removed += 1;
      }
    }

    for (const guide of guides) {
      const fp = SearchIndex.fingerprint(guide);
      const indexed = this.fingerprints[guide.guideId];
      const hasDoc = Boolean(this.docs[`g:${guide.guideId}`]);
      if (indexed === fp && hasDoc) continue; // unchanged
      try {
        this.indexGuide(guide, store.listSteps(guide.guideId), { persist: false });
        reindexed += 1;
      } catch {
        // A single unreadable guide must not abort the whole reconcile.
      }
    }

    this.persist();
    if (this.status === 'reset' || reindexed > 0 || removed > 0) {
      this.status = this.status === 'reset' ? 'reset' : 'reconciled';
    }
    return { status: this.status, reindexed, removed, total: guides.length };
  }

  /** (Re)index one guide and all of its steps. */
  indexGuide(guide, stepsMap, { persist = true } = {}) {
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
    this.fingerprints[guide.guideId] = SearchIndex.fingerprint(guide);
    if (persist) this.persist();
  }

  removeGuide(guideId, { persist = true } = {}) {
    for (const key of Object.keys(this.docs)) {
      if (this.docs[key].guideId === guideId) delete this.docs[key];
    }
    delete this.fingerprints[guideId];
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
