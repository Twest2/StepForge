'use strict';

/*
 * Settings → Branding: the brand profile every export uses (core/branding.js),
 * a summary of it, a design preview, and Manage → Brand profiles, where
 * profiles are created, edited, shared as .sfbrand files and deleted.
 */

// Mirrors FONT_SUGGESTIONS in core/branding.js (a unit test keeps the two in step).
const BRAND_FONT_SUGGESTIONS = [
  'Arial', 'Calibri', 'Cambria', 'Candara', 'Century Gothic', 'Consolas', 'Constantia', 'Corbel', 'Franklin Gothic',
  'Garamond', 'Georgia', 'Helvetica', 'Inter', 'Lato', 'Montserrat', 'Noto Sans', 'Noto Serif', 'Open Sans',
  'Palatino Linotype', 'Roboto', 'Segoe UI', 'Source Sans 3', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana',
];

const BRAND_DEFAULT_COLORS = { primary: '#2563EB', accent: '#0EA5E9', text: '#18212B' };
// Mirrors DEFAULT_ANNOTATION_COLORS in core/branding.js: StepForge's own, used until a profile turns its own on.
const BRAND_DEFAULT_ANNOTATION_COLORS = { shapes: '#E5484D', numbers: '#1F6FEB', tooltips: '#111827' };

// Mirrors MAX_CSS_CHARS in core/branding.js (a unit test keeps the two in step).
const BRAND_CSS_MAX_CHARS = 200000;

// Formats Design preview can show, most useful first.
const BRAND_PREVIEW_FORMATS = [
  { value: 'html-rich', label: 'HTML (rich)' },
  { value: 'html-simple', label: 'HTML (simple)' },
  { value: 'pdf', label: 'PDF' },
  { value: 'docx', label: 'Word' },
  { value: 'pptx', label: 'PowerPoint' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'gif', label: 'GIF' },
  { value: 'image-bundle', label: 'Image bundle' },
];

const BRAND_CSS_GUIDE_URL = 'https://github.com/Twest2/StepForge/blob/main/docs/BRANDING.md#advanced-css';

// What a profile changes in each export (the issue's support table).
const BRAND_SUPPORT = [
  ['HTML (simple and rich)', 'Logo, banner, colors, fonts (uploaded fonts are embedded), cover style, footer text and your CSS.'],
  ['GitHub Pages', 'Everything the HTML exports get.'],
  ['PDF', 'Logo, banner, colors, the closest built-in fonts, cover style, page header and footer with page numbers.'],
  ['Word', 'Styles with your fonts and colors, logo and banner on the cover, page header and footer with page numbers.'],
  ['PowerPoint', 'A theme with your colors and fonts, a title slide in your cover style, logo, footer and slide numbers on every slide.'],
  ['Wiki.js', 'Logo, banner, header and footer text.'],
  ['Confluence', 'Logo, banner, header and footer text.'],
  ['Markdown', 'Logo, banner, header and footer text, and the accent bar color.'],
  ['GIF and image bundle', 'Logo on the title card, colors, and an optional logo watermark.'],
  ['JSON', 'Not branded: it keeps the raw guide data.'],
  ['Editor', 'If the profile turns on its own annotation colors: new shapes, number badges, tooltips and click markers.'],
];

const BRAND_COVER_STYLES = [
  { value: 'standard', label: 'Standard' },
  { value: 'centered', label: 'Centered' },
  { value: 'band', label: 'Brand color band' },
];

const BRAND_WATERMARK_POSITIONS = [
  { value: 'bottom-right', label: 'Bottom right' },
  { value: 'bottom-left', label: 'Bottom left' },
  { value: 'top-right', label: 'Top right' },
  { value: 'top-left', label: 'Top left' },
];

function brandSelect(value, options, attrs = {}) {
  return el('select', attrs, options.map((opt) => el('option', { value: opt.value, selected: opt.value === value }, opt.label)));
}

/**
 * Draw an SVG or JPG (or a PNG StepForge can't decode itself) to a PNG, for
 * the exports that can't use the original: SVGs at 1200–2400 px on the long
 * side so they stay sharp in print, photos at most 2400 px. Returns base64.
 */
async function rasterizeBrandImage(asset) {
  const img = new Image();
  img.src = asset.dataUrl;
  await img.decode();
  const width = asset.width || img.naturalWidth || 512;
  const height = asset.height || img.naturalHeight || 512;
  const long = Math.max(width, height);
  const target = asset.mime === 'image/svg+xml' ? Math.min(2400, Math.max(1200, long)) : Math.min(2400, long);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round((width * target) / long));
  canvas.height = Math.max(1, Math.round((height * target) / long));
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png').split(',')[1];
}

/** Make sure an image asset has its PNG copy; returns the updated description. */
async function ensureBrandRaster(api, asset) {
  if (!asset || asset.kind !== 'image' || !asset.needsRaster) return asset;
  const png = await rasterizeBrandImage(asset);
  return { ...(await api.branding.setRaster({ id: asset.id, png })), dataUrl: asset.dataUrl };
}

/** Open the sample guide exported with a profile (saved `id`, or the `profile` being edited). */
async function openBrandPreview(api, { id = '', profile = null, format }) {
  const result = await api.branding.preview(profile ? { profile, format } : { id, format });
  if (result?.file) await api.shell.openProduced({ target: result.file });
}

/** An error line shown under one part of the editor, so it appears beside what was clicked. */
function brandRowMessage() {
  const node = el('p.setting-desc.error.brand-row-error', { role: 'alert', hidden: true });
  return {
    node,
    show(err) { node.textContent = err?.message || String(err); node.hidden = false; },
    clear() { node.textContent = ''; node.hidden = true; },
  };
}

function brandThumb(asset, label) {
  return el('div.brand-thumb', {},
    asset?.dataUrl ? el('img', { src: asset.dataUrl, alt: label }) : el('span.brand-thumb-empty', { 'aria-hidden': 'true' }, '—'));
}

/** The read-only summary of a profile under the Active brand profile list. */
function brandSummary(data) {
  if (!data) {
    return [el('p.setting-desc.brand-none', {},
      'Exports use StepForge’s own look. Choose Manage to make a brand profile with your logo, colors and fonts.')];
  }
  const { profile, assets } = data;
  const sections = [];
  const section = (title, ...children) => el('section.brand-section', {}, el('h4', {}, title), ...children);
  const asset = (id) => (id ? assets[id] : null);
  const assetRow = (title, desc, id) => el('div.brand-asset-row', {},
    brandThumb(asset(id), title),
    el('div.setting-text', {}, el('div.setting-title', {}, title), el('div.setting-desc', {}, desc)),
    el('span.setting-desc', {}, asset(id)?.name || 'None'));
  sections.push(section('Brand assets',
    assetRow('Company logo', 'PNG, JPG, or sanitized SVG', profile.logo),
    assetRow('Banner', 'A wide image across the top of covers and pages', profile.banner)));
  sections.push(section('Brand colors', el('div.brand-swatches', {},
    ...[['Primary', profile.colors.primary], ['Accent', profile.colors.accent], ['Text', profile.colors.text]].map(([label, color]) => el('div.brand-swatch', {},
      el('span.brand-swatch-color', { style: { background: color } }),
      el('strong', {}, label),
      el('code', {}, color))))));
  const font = (role) => {
    const f = profile.fonts[role];
    const file = asset(f.asset);
    return f.name ? `${f.name}${file ? ' (font file embedded in HTML)' : ''}` : 'StepForge default';
  };
  const cover = BRAND_COVER_STYLES.find((c) => c.value === profile.cover)?.label || 'Standard';
  sections.push(section('Fonts and layout', el('dl.brand-facts', {},
    el('dt', {}, 'Headings'), el('dd', {}, font('heading')),
    el('dt', {}, 'Body text'), el('dd', {}, font('body')),
    el('dt', {}, 'Cover style'), el('dd', {}, cover),
    el('dt', {}, 'Header'), el('dd', {}, [profile.header.logo && profile.logo ? 'Logo' : '', profile.header.text].filter(Boolean).join(' · ') || 'None'),
    el('dt', {}, 'Footer'), el('dd', {}, [profile.footer.text, profile.footer.pageNumbers ? 'Page numbers' : ''].filter(Boolean).join(' · ') || 'None'),
    el('dt', {}, 'Watermark'), el('dd', {}, profile.watermark.enabled ? `Logo, ${BRAND_WATERMARK_POSITIONS.find((p) => p.value === profile.watermark.position)?.label.toLowerCase()}` : 'Off'),
    el('dt', {}, 'Annotations'), el('dd', {}, profile.annotations?.custom
      ? `Shapes ${profile.annotations.shapes} · Number badges ${profile.annotations.numbers} · Tooltips ${profile.annotations.tooltips}`
      : 'StepForge’s colors'))));
  sections.push(section('Advanced CSS',
    el('p.setting-desc', {}, 'Used for HTML and GitHub Pages outputs only.'),
    profile.html.css.trim() ? el('pre.brand-css', {}, profile.html.css) : el('p.setting-desc', {}, 'None.')));
  return sections;
}

/**
 * Settings → Branding. `value()` is the chosen profile id ('' for no
 * branding), saved with the rest of Settings.
 */
function makeBrandingSettings(api, { activeProfileId = '' } = {}) {
  let profiles = [];
  let active = activeProfileId || '';
  const select = el('select#brand-active', { 'aria-label': 'Active brand profile' });
  const summary = el('div.brand-summary');
  const status = el('p.setting-desc', { role: 'status' });
  const previewFormat = brandSelect('html-rich', BRAND_PREVIEW_FORMATS, { 'aria-label': 'Preview format' });
  const previewBtn = el('button', { type: 'button' }, 'Design preview');
  let loadToken = 0;

  const showSummary = async () => {
    const token = ++loadToken;
    const data = active ? await api.branding.get({ id: active }).catch(() => null) : null;
    if (token !== loadToken) return;
    summary.replaceChildren(...brandSummary(data));
  };

  const fillSelect = () => {
    if (active && !profiles.some((p) => p.id === active)) active = '';
    select.replaceChildren(el('option', { value: '', selected: !active }, 'No branding'),
      ...profiles.map((p) => el('option', { value: p.id, selected: p.id === active }, p.name)));
  };

  const refresh = async () => {
    try {
      profiles = await api.branding.list();
    } catch (err) {
      status.textContent = `StepForge couldn’t load your brand profiles: ${err.message || err}`;
    }
    fillSelect();
    await showSummary();
  };

  select.addEventListener('change', () => { active = select.value; void showSummary(); });
  const manageBtn = el('button', {
    type: 'button',
    onClick: async () => {
      const { created } = await showBrandProfiles(api);
      profiles = await api.branding.list();
      // A first profile made from "No branding" is probably the one to use.
      if (!active && created.length) active = created[created.length - 1];
      fillSelect();
      await showSummary();
    },
  }, 'Manage');
  previewBtn.addEventListener('click', async () => {
    setButtonLoading(previewBtn, true, 'Preparing…');
    status.textContent = '';
    try {
      await openBrandPreview(api, { id: active, format: previewFormat.value });
    } catch (err) {
      status.textContent = `The preview couldn’t be made: ${err.message || err}`;
    } finally {
      setButtonLoading(previewBtn, false);
    }
  });

  const node = el('div.brand-settings', {},
    settingsCard(null,
      el('div.brand-active', {},
        el('label', { htmlFor: 'brand-active' }, 'Active brand profile'),
        el('div.brand-active-row', {}, select, manageBtn)),
      summary,
      el('div.brand-preview-row', {},
        el('div.setting-text', {}, el('div.setting-title', {}, 'Preview generated output'),
          el('div.setting-desc', {}, 'Exports a short sample guide with this profile and opens it.')),
        el('div.row', {}, previewFormat, previewBtn)),
      status),
    settingsCard(null,
      el('h4.brand-card-heading', {}, 'Where branding appears'),
      el('dl.brand-support', {}, ...BRAND_SUPPORT.flatMap(([format, what]) => [el('dt', {}, format), el('dd', {}, what)])),
      el('p.setting-desc', {}, 'The Export dialog can pick a different profile, or none, for one export.')));
  void refresh();
  // The choice, not the list: the list is empty until the profiles load.
  return { node, value: () => active };
}

/**
 * Manage → Brand profiles: the list, with New profile, Import, and per-row
 * Edit, Duplicate, Share and Delete. Resolves { created } with the ids of
 * profiles made here.
 */
function showBrandProfiles(api) {
  return new Promise((resolve) => {
    let list = [];
    const created = [];
    const rows = el('div.card-list.brand-profile-list');
    const status = el('p.setting-desc', { role: 'status' });
    const fail = (err) => { status.textContent = err.message || String(err); status.classList.add('error'); };

    const reload = async () => {
      list = await api.branding.list();
      render();
    };
    const edit = async (id) => {
      const data = id ? await api.branding.get({ id }) : null;
      const saved = await showBrandProfileEditor(api, data);
      if (saved && !id) created.push(saved.profile.id);
      await reload();
    };
    function render() {
      if (!list.length) {
        rows.replaceChildren(el('div.muted', {}, 'No brand profiles yet. Choose New profile to make one.'));
        return;
      }
      rows.replaceChildren(...list.map((p) => el('div.row.brand-profile-row', {},
        el('span.brand-profile-name', {}, p.name),
        el('div.row', {},
          el('button', { type: 'button', onClick: () => edit(p.id).catch(fail) }, 'Edit'),
          el('button', { type: 'button', onClick: async () => {
            try { created.push((await api.branding.duplicate({ id: p.id })).profile.id); await reload(); } catch (err) { fail(err); }
          } }, 'Duplicate'),
          el('button', { type: 'button', onClick: async () => {
            try { const res = await api.branding.export({ id: p.id }); if (res?.ok) toast(`“${p.name}” saved as a .sfbrand file.`); } catch (err) { fail(err); }
          } }, 'Share…'),
          el('button.danger', { type: 'button', onClick: async () => {
            if (!await confirmDialog(`Delete the brand profile “${p.name}”? Exports that use it go back to no branding.`, { danger: true, okLabel: 'Delete' })) return;
            try { list = await api.branding.delete({ id: p.id }); render(); } catch (err) { fail(err); }
          } }, 'Delete')))));
    }

    const { close } = openModal({
      title: 'Brand profiles',
      body: el('div.brand-profiles', {},
        el('div.row', { style: { marginBottom: '10px' } },
          el('button.primary', { type: 'button', onClick: () => edit(null).catch(fail) }, 'New profile…'),
          el('button', { type: 'button', onClick: async () => {
            try {
              const res = await api.branding.import();
              if (!res?.ok) return;
              created.push(res.profile.id);
              toast(`Imported “${res.profile.name}”.`);
              await reload();
            } catch (err) { fail(err); }
          } }, 'Import .sfbrand…'),
          el('span.muted', {}, 'Profiles are shareable as .sfbrand files.')),
        rows,
        status),
      footer: [el('button.primary', { type: 'button', onClick: () => { close(); resolve({ created }); } }, 'Done')],
      wide: true,
      onClose: () => resolve({ created }),
    });
    reload().catch(fail);
  });
}

/**
 * New or edit a brand profile. `data` is { profile, assets } for an existing
 * one. Resolves with the saved { profile, assets }, or null when cancelled.
 */
function showBrandProfileEditor(api, data = null) {
  return new Promise((resolve) => {
    const base = data?.profile;
    const assets = { ...(data?.assets || {}) };
    const draft = {
      id: base?.id,
      name: base?.name || '',
      colors: { ...BRAND_DEFAULT_COLORS, ...(base?.colors || {}) },
      fonts: { heading: { name: '', asset: null, ...(base?.fonts?.heading || {}) }, body: { name: '', asset: null, ...(base?.fonts?.body || {}) } },
      logo: base?.logo || null,
      banner: base?.banner || null,
      header: { text: '', logo: true, ...(base?.header || {}) },
      footer: { text: '', pageNumbers: true, ...(base?.footer || {}) },
      cover: base?.cover || 'standard',
      html: { css: '', colorScheme: 'light', ...(base?.html || {}) },
      watermark: { enabled: false, position: 'bottom-right', opacity: 0.6, ...(base?.watermark || {}) },
      annotations: { custom: false, ...BRAND_DEFAULT_ANNOTATION_COLORS, ...(base?.annotations || {}) },
    };
    // Errors from Preview and Save show in the footer beside those buttons.
    const footerStatus = el('span.brand-footer-status.error', { role: 'alert' });
    const fail = (err) => { footerStatus.textContent = err.message || String(err); footerStatus.title = footerStatus.textContent; };

    // Name
    const name = el('input', { type: 'text', value: draft.name, maxLength: 80, placeholder: 'Company Default', 'aria-label': 'Profile name' });
    const nameMessage = brandRowMessage();
    name.addEventListener('input', () => { draft.name = name.value; name.classList.remove('invalid'); nameMessage.clear(); });

    // Images
    const imageMessages = {};
    const imageRow = (key, title, desc) => {
      const thumb = el('div');
      const fileName = el('span.setting-desc');
      const message = brandRowMessage();
      imageMessages[key] = message;
      const remove = el('button', { type: 'button', onClick: () => { draft[key] = null; message.clear(); show(); } }, 'Remove');
      const choose = el('button', { type: 'button' }, 'Choose…');
      const show = () => {
        const asset = draft[key] ? assets[draft[key]] : null;
        thumb.replaceChildren(brandThumb(asset, title));
        fileName.textContent = asset?.name || 'None';
        remove.disabled = !asset;
      };
      choose.addEventListener('click', async () => {
        setButtonLoading(choose, true, 'Adding…');
        try {
          const picked = await api.branding.chooseAsset({ kind: 'image' });
          if (!picked) return;
          message.clear();
          const asset = await ensureBrandRaster(api, picked);
          assets[asset.id] = asset;
          draft[key] = asset.id;
          show();
        } catch (err) { message.show(err); } finally { setButtonLoading(choose, false); }
      });
      show();
      return el('div.brand-asset-row', {}, thumb,
        el('div.setting-text', {}, el('div.setting-title', {}, title), el('div.setting-desc', {}, desc), fileName, message.node),
        el('div.row', {}, choose, remove));
    };

    // Colors: a color picker and its hex code, kept in step, editing colors[key].
    const colorRow = (colors, key, title, desc) => {
      const picker = el('input', { type: 'color', value: colors[key].toLowerCase(), 'aria-label': `${title} color` });
      const hex = el('input.brand-hex', { type: 'text', value: colors[key], maxLength: 7, spellcheck: false, 'aria-label': `${title} color code` });
      picker.addEventListener('input', () => { colors[key] = picker.value.toUpperCase(); hex.value = colors[key]; });
      hex.addEventListener('input', () => {
        const v = hex.value.trim();
        const ok = /^#?[0-9a-f]{6}$/i.test(v);
        hex.classList.toggle('invalid', !ok);
        if (ok) { colors[key] = `#${v.replace('#', '')}`.toUpperCase(); picker.value = colors[key].toLowerCase(); }
      });
      return settingRow(title, desc, el('div.row', {}, picker, hex));
    };

    // Annotation colors: StepForge's unless the profile turns its own on.
    const ownAnnotations = el('input', { type: 'checkbox', checked: draft.annotations.custom });
    const annotationRows = el('div', { hidden: !draft.annotations.custom },
      colorRow(draft.annotations, 'shapes', 'Shapes', 'Rectangles, ovals, lines, arrows, text and magnifiers, and the marker on recorded clicks.'),
      colorRow(draft.annotations, 'numbers', 'Number badges', 'Numbered step markers.'),
      colorRow(draft.annotations, 'tooltips', 'Tooltips', 'The tooltip bubble. Its text turns black or white to stay readable.'));
    ownAnnotations.addEventListener('change', () => { draft.annotations.custom = ownAnnotations.checked; annotationRows.hidden = !ownAnnotations.checked; });

    // Fonts
    const fontList = el('datalist', { id: 'brand-font-list' }, BRAND_FONT_SUGGESTIONS.map((f) => el('option', { value: f })));
    const fontRow = (role, title, desc) => {
      const f = draft.fonts[role];
      const input = el('input', { type: 'text', value: f.name, maxLength: 80, placeholder: 'StepForge default', list: 'brand-font-list', 'aria-label': `${title} font` });
      const file = el('span.setting-desc');
      const message = brandRowMessage();
      const remove = el('button', { type: 'button', onClick: () => { f.asset = null; message.clear(); show(); } }, 'Remove file');
      const upload = el('button', { type: 'button' }, 'Upload font…');
      const show = () => {
        const asset = f.asset ? assets[f.asset] : null;
        file.textContent = asset ? `Font file: ${asset.name || asset.family} (embedded in HTML exports)` : 'No font file: readers need the font installed.';
        remove.hidden = !asset;
      };
      input.addEventListener('input', () => { f.name = input.value; });
      upload.addEventListener('click', async () => {
        setButtonLoading(upload, true, 'Adding…');
        try {
          const picked = await api.branding.chooseAsset({ kind: 'font' });
          if (!picked) return;
          message.clear();
          assets[picked.id] = picked;
          f.asset = picked.id;
          // The file's own family name, unless one was typed on purpose.
          if (!f.name.trim() || BRAND_FONT_SUGGESTIONS.includes(f.name.trim())) { f.name = picked.family; input.value = picked.family; }
          show();
        } catch (err) { message.show(err); } finally { setButtonLoading(upload, false); }
      });
      show();
      return el('div.brand-font-row', {},
        settingRow(title, desc, input),
        el('div.brand-font-file', {}, el('div', {}, file, message.node), el('div.row', {}, upload, remove)));
    };

    // Layout
    const cover = brandSelect(draft.cover, BRAND_COVER_STYLES, { 'aria-label': 'Cover style' });
    cover.addEventListener('change', () => { draft.cover = cover.value; });
    const scheme = brandSelect(draft.html.colorScheme, [
      { value: 'light', label: 'Always light' },
      { value: 'auto', label: 'Follow light or dark mode' },
    ], { 'aria-label': 'HTML color scheme' });
    scheme.addEventListener('change', () => { draft.html.colorScheme = scheme.value; });

    // Header & footer
    const textInput = (obj, key, placeholder, max) => {
      const input = el('input', { type: 'text', value: obj[key], maxLength: max, placeholder, 'aria-label': placeholder });
      input.addEventListener('input', () => { obj[key] = input.value; });
      return input;
    };
    const toggle = (obj, key, label) => {
      const input = el('input', { type: 'checkbox', checked: Boolean(obj[key]) });
      input.addEventListener('change', () => { obj[key] = input.checked; });
      return makeSwitch(input, label);
    };

    // Watermark
    const position = brandSelect(draft.watermark.position, BRAND_WATERMARK_POSITIONS, { 'aria-label': 'Watermark position' });
    position.addEventListener('change', () => { draft.watermark.position = position.value; });
    const opacity = el('input', { type: 'range', min: 0.1, max: 1, step: 0.05, value: draft.watermark.opacity, 'aria-label': 'Watermark opacity' });
    const opacityLabel = el('output', {}, `${Math.round(draft.watermark.opacity * 100)}%`);
    opacity.addEventListener('input', () => { draft.watermark.opacity = Number(opacity.value); opacityLabel.textContent = `${Math.round(draft.watermark.opacity * 100)}%`; });

    // Advanced CSS
    const css = el('textarea.brand-css-input', { rows: 7, spellcheck: false, placeholder: '.doc-header { padding: 2rem; }\n.step-head h2 { color: var(--brand-primary); }', 'aria-label': 'Advanced CSS' });
    css.value = draft.html.css;
    const cssMessage = brandRowMessage();
    // Over the limit is said as it's typed or pasted, and stops Save, rather than being cut short.
    const cssFits = () => {
      if (css.value.length <= BRAND_CSS_MAX_CHARS) { cssMessage.clear(); return true; }
      cssMessage.show(`This CSS is ${css.value.length.toLocaleString('en-US')} characters long. A profile can hold 200,000.`);
      return false;
    };
    css.addEventListener('input', () => { draft.html.css = css.value; cssFits(); });
    const loadCss = el('button', { type: 'button', onClick: async () => {
      try {
        const picked = await api.branding.chooseAsset({ kind: 'css' });
        if (!picked) return;
        css.value = picked.css;
        draft.html.css = picked.css;
        cssFits();
      } catch (err) { cssMessage.show(err); }
    } }, 'Load .css file…');

    const body = el('div.brand-editor', {},
      settingsCard(null, settingRow('Profile name', 'Shown in the Active brand profile list.', name), nameMessage.node),
      settingsCard('Brand assets',
        imageRow('logo', 'Company logo', 'PNG, JPG, or SVG (scripts and outside links are removed). On covers, page headers and slides.'),
        imageRow('banner', 'Banner', 'Optional. A wide image across the top of covers, web pages and wiki pages.')),
      settingsCard('Brand colors',
        colorRow(draft.colors, 'primary', 'Primary', 'Title bars, step numbers, headings and accent lines.'),
        colorRow(draft.colors, 'accent', 'Accent', 'Links and highlights.'),
        colorRow(draft.colors, 'text', 'Text', 'Body text.')),
      settingsCard('Annotation colors',
        settingRow('Use your own annotation colors', 'Off keeps StepForge’s: red shapes, blue number badges, dark tooltips. New annotations start in these colors; ones already drawn keep theirs.',
          makeSwitch(ownAnnotations, 'Use your own annotation colors')),
        annotationRows),
      settingsCard('Fonts',
        fontRow('heading', 'Headings', 'Titles and step headings.'),
        fontRow('body', 'Body text', 'Everything else.'),
        el('p.setting-desc', {}, 'Word and PowerPoint use these fonts by name. HTML embeds an uploaded font file. PDF uses the closest built-in font: Helvetica, Times or Courier.'),
        fontList),
      settingsCard('Layout',
        settingRow('Cover style', 'The title page of PDF, Word and PowerPoint, the top of HTML pages and the GIF title card.', cover),
        settingRow('HTML color scheme', 'Brand colors are usually picked for light pages.', scheme)),
      settingsCard('Header and footer',
        settingRow('Header text', 'Top of every PDF and Word page; under the logo in HTML and wiki pages.', textInput(draft.header, 'text', 'Acme Corp · IT Service Desk', 160)),
        settingRow('Logo in page header', 'PDF and Word pages after the cover.', toggle(draft.header, 'logo', 'Logo in page header')),
        settingRow('Footer text', 'Bottom of every page and slide, and the end of HTML, Markdown and wiki pages.', textInput(draft.footer, 'text', '© Acme Corp. Internal use only.', 200)),
        settingRow('Page numbers', 'PDF and Word pages, and PowerPoint slides.', toggle(draft.footer, 'pageNumbers', 'Page numbers'))),
      settingsCard('Watermark',
        settingRow('Watermark screenshots with the logo', 'GIF and image bundle exports.', toggle(draft.watermark, 'enabled', 'Watermark screenshots with the logo')),
        settingRow('Position', null, position),
        settingRow('Opacity', null, el('div.row.settings-range', {}, opacity, opacityLabel))),
      settingsCard('Advanced CSS',
        el('p.setting-desc', {}, 'Used for HTML and GitHub Pages outputs only. Added after StepForge’s styles, so it wins. var(--brand-primary), var(--brand-accent) and var(--brand-text) hold your colors. ',
          el('a', { href: BRAND_CSS_GUIDE_URL, onClick: (e) => { e.preventDefault(); void api.shell.openExternal({ url: BRAND_CSS_GUIDE_URL }).catch(() => {}); } }, 'What you can style'), '.'),
        css,
        cssMessage.node,
        el('div.settings-actions', {}, loadCss)));

    const previewFormat = brandSelect('html-rich', BRAND_PREVIEW_FORMATS, { 'aria-label': 'Preview format' });
    const previewBtn = el('button', { type: 'button' }, 'Preview');
    previewBtn.addEventListener('click', async () => {
      if (!cssFits()) { css.focus(); return; }
      footerStatus.textContent = '';
      setButtonLoading(previewBtn, true, 'Preparing…');
      try { await openBrandPreview(api, { profile: draft, format: previewFormat.value }); } catch (err) { fail(err); } finally { setButtonLoading(previewBtn, false); }
    });
    const saveBtn = el('button.primary', { type: 'button' }, 'Save');
    saveBtn.addEventListener('click', async () => {
      if (!draft.name.trim()) {
        name.classList.add('invalid');
        nameMessage.show('Give the profile a name.');
        name.focus();
        return;
      }
      if (!cssFits()) { css.focus(); return; }
      footerStatus.textContent = '';
      setButtonLoading(saveBtn, true, 'Saving…');
      try {
        const saved = await api.branding.save({ profile: draft });
        close();
        resolve(saved);
      } catch (err) {
        fail(err);
        setButtonLoading(saveBtn, false);
      }
    });

    const { close } = openModal({
      title: base ? 'Edit brand profile' : 'New brand profile',
      body,
      footer: [previewFormat, previewBtn, footerStatus,
        el('button', { type: 'button', onClick: () => { close(); resolve(null); } }, 'Cancel'), saveBtn],
      wide: true,
      onClose: () => resolve(null),
    });
    // A profile imported before its images were drawn as PNG gets them now.
    for (const key of ['logo', 'banner']) {
      const id = draft[key];
      if (id && assets[id]?.needsRaster) {
        ensureBrandRaster(api, assets[id]).then((asset) => { assets[id] = asset; }).catch((err) => imageMessages[key].show(err));
      }
    }
    name.focus();
  });
}
