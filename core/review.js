'use strict';

/**
 * Guide review dates: when a guide is due for another look, and whether it
 * is overdue ("May need review" in the library). The clock starts at the
 * later of the guide's last save and its Last verified date, so saving or
 * marking a guide verified resets it. Each guide can override the default
 * interval from Settings (metadata.reviewAfterDays: null = use the default,
 * 0 = never).
 */

(function attachReview(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  // The renderer (sandboxed, without require) loads this file with a script tag.
  if (root) {
    root.StepForgeReview = api;
  }
})(typeof window !== 'undefined' ? window : null, () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const DEFAULT_REVIEW_DAYS = 180;
  const REVIEW_INTERVALS = [
    { days: 30, label: '1 month' },
    { days: 90, label: '3 months' },
    { days: 180, label: '6 months' },
    { days: 365, label: '1 year' },
    { days: 730, label: '2 years' },
  ];
  const MAX_REVIEW_DAYS = 3650;

  /** A whole number of days (0 = off), or null for "use the default". */
  function normalizeReviewDays(value) {
    if (value === null || value === undefined || value === '') return null;
    const days = Number(value);
    if (!Number.isInteger(days) || days < 0) return null;
    return Math.min(days, MAX_REVIEW_DAYS);
  }

  /** "YYYY-MM-DD" for a valid calendar date string, else ''. */
  function normalizeDateOnly(value) {
    if (typeof value !== 'string') return '';
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
    if (!m) return '';
    const date = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (date.getMonth() !== Number(m[2]) - 1 || date.getDate() !== Number(m[3])) return '';
    return `${m[1]}-${m[2]}-${m[3]}`;
  }

  /** Local-time "YYYY-MM-DD" for a Date or millisecond time. */
  function toDateOnly(time) {
    const date = new Date(time);
    if (!Number.isFinite(date.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  /** Milliseconds for a "YYYY-MM-DD" (local midnight) or an ISO timestamp. */
  function parseTime(value) {
    const dateOnly = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? normalizeDateOnly(value) : '';
    if (dateOnly) {
      const [y, m, d] = dateOnly.split('-').map(Number);
      return new Date(y, m - 1, d).getTime();
    }
    const time = Date.parse(value);
    return Number.isFinite(time) ? time : NaN;
  }

  /** "6 months" for a known interval, else "N days". */
  function intervalLabel(days) {
    const known = REVIEW_INTERVALS.find((i) => i.days === days);
    return known ? known.label : `${days} day${days === 1 ? '' : 's'}`;
  }

  /**
   * Where a guide stands. Null when reviews are off for it. Otherwise
   * { days, fromGuide, since, sinceKind ('saved' | 'verified'), due, dueDate, overdue }.
   */
  function reviewStatus(guide, defaultDays = DEFAULT_REVIEW_DAYS, now = Date.now()) {
    if (!guide) return null;
    const own = normalizeReviewDays(guide.metadata?.reviewAfterDays);
    const fallback = normalizeReviewDays(defaultDays);
    const days = own ?? fallback ?? DEFAULT_REVIEW_DAYS;
    if (!(days > 0)) return null;
    const saved = parseTime(guide.updatedAt);
    const verified = parseTime(guide.metadata?.lastVerified || '');
    const candidates = [saved, verified].filter(Number.isFinite);
    if (!candidates.length) return null;
    const since = Math.max(...candidates);
    const due = since + days * DAY_MS;
    return {
      days,
      fromGuide: own !== null,
      since,
      sinceKind: Number.isFinite(verified) && verified >= since ? 'verified' : 'saved',
      due,
      dueDate: toDateOnly(due),
      overdue: now >= due,
    };
  }

  return {
    DAY_MS,
    DEFAULT_REVIEW_DAYS,
    REVIEW_INTERVALS,
    normalizeReviewDays,
    normalizeDateOnly,
    toDateOnly,
    parseTime,
    intervalLabel,
    reviewStatus,
  };
});
