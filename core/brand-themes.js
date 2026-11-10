'use strict';

const { t } = require('./ui-text');

/**
 * Built-in brand themes: ready-made profiles that come with StepForge, so an
 * export can look finished without making a profile first. They're
 * read-only and have no files (logo, banner, fonts); Customize in Settings →
 * Branding saves an editable copy as an ordinary profile.
 *
 * Their ids fit the profile id pattern (brand-…), so the active profile,
 * the Export dialog's choice and settings sync treat them like any other.
 */

const THEME_PREFIX = 'brand-theme-';

const isThemeId = (id) => typeof id === 'string' && id.startsWith(THEME_PREFIX);

// Fixed timestamps: a theme never changes on its own.
const STAMP = '2026-11-09T00:00:00.000Z';

/** The themes in the interface language: [{ id, name, description, ...profile fields }]. */
function brandThemes() {
  const border = (borderColor, extra = {}) => ({ align: 'center', border: true, borderColor, layout: 'stacked', ...extra });
  return [
    {
      key: 'slate', name: t('Slate'), description: t('Quiet grays for internal docs. Centered screenshots with a thin border.'),
      colors: { primary: '#334155', accent: '#0EA5E9', text: '#0F172A' },
      screenshots: border('#CBD5E1'),
    },
    {
      key: 'ocean', name: t('Ocean'), description: t('A blue band across the cover, with blue accents.'),
      colors: { primary: '#1D4ED8', accent: '#38BDF8', text: '#0F172A' },
      cover: 'band',
      screenshots: border('#BFDBFE'),
    },
    {
      key: 'forest', name: t('Forest'), description: t('Green accents and a centered cover.'),
      colors: { primary: '#166534', accent: '#65A30D', text: '#14201A' },
      cover: 'centered',
      screenshots: border('#CFE3D3'),
    },
    {
      key: 'sunset', name: t('Sunset'), description: t('A warm orange band across the cover.'),
      colors: { primary: '#C2410C', accent: '#F59E0B', text: '#1C1917' },
      cover: 'band',
      screenshots: border('#FED7AA'),
    },
    {
      key: 'compact', name: t('Compact'), description: t('Each screenshot beside its text, for shorter PDF and Word documents.'),
      colors: { primary: '#0F766E', accent: '#14B8A6', text: '#111827' },
      screenshots: border('#D0D5DD', { layout: 'side-by-side' }),
    },
    {
      key: 'midnight', name: t('Midnight'), description: t('Purple accents. HTML pages follow the reader’s dark mode.'),
      colors: { primary: '#6D28D9', accent: '#22D3EE', text: '#111827' },
      cover: 'band',
      html: { css: '', colorScheme: 'auto' },
      screenshots: border('#DDD6FE'),
    },
    {
      key: 'classic', name: t('Classic'), description: t('Serif headings and a centered cover, made for printing.'),
      colors: { primary: '#111827', accent: '#B45309', text: '#1F2937' },
      fonts: { heading: { name: 'Georgia' }, body: { name: '' } },
      cover: 'centered',
      screenshots: border('#D1D5DB'),
    },
  ].map(({ key, ...theme }) => ({ id: `${THEME_PREFIX}${key}`, createdAt: STAMP, updatedAt: STAMP, ...theme }));
}

function brandTheme(id) {
  return isThemeId(id) ? brandThemes().find((theme) => theme.id === id) || null : null;
}

module.exports = { THEME_PREFIX, isThemeId, brandThemes, brandTheme };
