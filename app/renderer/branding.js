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
  { value: 'html-rich', label: t('HTML (rich)') },
  { value: 'html-simple', label: t('HTML (simple)') },
  { value: 'pdf', label: 'PDF' },
  { value: 'docx', label: 'Word' },
  { value: 'pptx', label: 'PowerPoint' },
  { value: 'markdown', label: 'Markdown' },
  { value: 'gif', label: 'GIF' },
  { value: 'image-bundle', label: t('Image bundle') },
];

const BRAND_CSS_GUIDE_URL = 'https://github.com/Twest2/StepForge/blob/main/docs/BRANDING.md#advanced-css';

// Mirrors BRAND_CSS_REQUEST in app/text-intel.js: ai:cancel stops Write with AI by this id.
const BRAND_AI_REQUEST = 'branding-css';
// Mirrors MAX_REQUEST_CHARS in core/ai-brand-css.js.
const BRAND_AI_REQUEST_MAX_CHARS = 500;

// What a profile changes in each export (the issue's support table).
const BRAND_SUPPORT = [
  [t('HTML (simple and rich)'), t('Logo, banner, colors, fonts (uploaded fonts are embedded), cover style, footer text and your CSS.')],
  ['GitHub Pages', t('Everything the HTML exports get.')],
  ['PDF', t('Logo, banner, colors, the closest built-in fonts, cover style, page header and footer with page numbers.')],
  ['Word', t('Styles with your fonts and colors, logo and banner on the cover, page header and footer with page numbers.')],
  ['PowerPoint', t('A theme with your colors and fonts, a title slide in your cover style, logo, footer and slide numbers on every slide.')],
  ['Wiki.js', t('Logo, banner, header and footer text.')],
  ['Confluence', t('Logo, banner, header and footer text.')],
  ['Markdown', t('Logo, banner, header and footer text, and the accent bar color.')],
  [t('GIF and image bundle'), t('Logo on the title card, colors, and an optional logo watermark.')],
  ['JSON', t('Not branded: it keeps the raw guide data.')],
  [t('Editor'), t('If the profile turns on its own annotation colors: new shapes, number badges, tooltips and click markers.')],
];

const BRAND_COVER_STYLES = [
  { value: 'standard', label: t('Standard') },
  { value: 'centered', label: t('Centered') },
  { value: 'band', label: t('Brand color band') },
];

const BRAND_WATERMARK_POSITIONS = [
  { value: 'bottom-right', label: t('Bottom right') },
  { value: 'bottom-left', label: t('Bottom left') },
  { value: 'top-right', label: t('Top right') },
  { value: 'top-left', label: t('Top left') },
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

/** Draw the PNG copies that images an AI agent added (or an import brought) still need. */
async function ensurePendingBrandRasters(api) {
  const pending = await api.branding.pendingRasters().catch(() => []);
  // A failure is quiet: the next start, or opening the profile, tries again.
  for (const asset of pending) await ensureBrandRaster(api, asset).catch(() => {});
}

/** A logo's brand colors (core/brand-palette.js), or null when it has none to use. */
async function brandColorsFromLogo(asset) {
  const img = new Image();
  img.src = asset.dataUrl;
  await img.decode();
  const width = asset.width || img.naturalWidth || 256;
  const height = asset.height || img.naturalHeight || 256;
  // A small drawing has the same colors and is quick to read.
  const scale = Math.min(1, 160 / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return StepForgeBrandPalette.colorsFromPixels(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
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
      t('Exports use StepForge’s own look. Choose Manage to make a brand profile with your logo, colors and fonts.'))];
  }
  const { profile, assets } = data;
  const sections = [];
  const section = (title, ...children) => el('section.brand-section', {}, el('h4', {}, title), ...children);
  const asset = (id) => (id ? assets[id] : null);
  const assetRow = (title, desc, id) => el('div.brand-asset-row', {},
    brandThumb(asset(id), title),
    el('div.setting-text', {}, el('div.setting-title', {}, title), el('div.setting-desc', {}, desc)),
    el('span.setting-desc', {}, asset(id)?.name || t('None')));
  sections.push(section(t('Brand assets'),
    assetRow(t('Company logo'), t('PNG, JPG, or sanitized SVG'), profile.logo),
    assetRow(t('Banner'), t('A wide image across the top of covers and pages'), profile.banner)));
  sections.push(section(t('Brand colors'), el('div.brand-swatches', {},
    ...[[t('Primary'), profile.colors.primary], [t('Accent'), profile.colors.accent], [t('Text'), profile.colors.text]].map(([label, color]) => el('div.brand-swatch', {},
      el('span.brand-swatch-color', { style: { background: color } }),
      el('strong', {}, label),
      el('code', {}, color))))));
  const font = (role) => {
    const f = profile.fonts[role];
    const file = asset(f.asset);
    return f.name ? (file ? t('{font} (font file embedded in HTML)', { font: f.name }) : f.name) : t('StepForge default');
  };
  const cover = BRAND_COVER_STYLES.find((c) => c.value === profile.cover)?.label || t('Standard');
  sections.push(section(t('Fonts and layout'), el('dl.brand-facts', {},
    el('dt', {}, t('Headings')), el('dd', {}, font('heading')),
    el('dt', {}, t('Body text')), el('dd', {}, font('body')),
    el('dt', {}, t('Cover style')), el('dd', {}, cover),
    el('dt', {}, t('Header')), el('dd', {}, [profile.header.logo && profile.logo ? t('Logo') : '', profile.header.text].filter(Boolean).join(' · ') || t('None')),
    el('dt', {}, t('Footer')), el('dd', {}, [profile.footer.text, profile.footer.pageNumbers ? t('Page numbers') : ''].filter(Boolean).join(' · ') || t('None')),
    el('dt', {}, t('Watermark')), el('dd', {}, profile.watermark.enabled ? t('Logo, {position}', { position: BRAND_WATERMARK_POSITIONS.find((p) => p.value === profile.watermark.position)?.label.toLowerCase() }) : t('Off')),
    el('dt', {}, t('Annotations')), el('dd', {}, profile.annotations?.custom
      ? t('Shapes {shapes} · Number badges {numbers} · Tooltips {tooltips}', profile.annotations)
      : t('StepForge’s colors')))));
  sections.push(section(t('Advanced CSS'),
    el('p.setting-desc', {}, t('Used for HTML and GitHub Pages outputs only.')),
    profile.html.css.trim() ? el('pre.brand-css', {}, profile.html.css) : el('p.setting-desc', {}, t('None.'))));
  return sections;
}

/**
 * Settings → Branding. `value()` is the chosen profile id ('' for no
 * branding), saved with the rest of Settings.
 */
function makeBrandingSettings(api, { activeProfileId = '' } = {}) {
  let profiles = [];
  let active = activeProfileId || '';
  const select = el('select#brand-active', { 'aria-label': t('Active brand profile') });
  const summary = el('div.brand-summary');
  const status = el('p.setting-desc', { role: 'status' });
  const previewFormat = brandSelect('html-rich', BRAND_PREVIEW_FORMATS, { 'aria-label': t('Preview format') });
  const previewBtn = el('button', { type: 'button' }, t('Design preview'));
  let loadToken = 0;

  const showSummary = async () => {
    const token = ++loadToken;
    const data = active ? await api.branding.get({ id: active }).catch(() => null) : null;
    if (token !== loadToken) return;
    summary.replaceChildren(...brandSummary(data));
  };

  const fillSelect = () => {
    if (active && !profiles.some((p) => p.id === active)) active = '';
    select.replaceChildren(el('option', { value: '', selected: !active }, t('No branding')),
      ...profiles.map((p) => el('option', { value: p.id, selected: p.id === active }, p.name)));
  };

  const refresh = async () => {
    try {
      profiles = await api.branding.list();
    } catch (err) {
      status.textContent = t('StepForge couldn’t load your brand profiles: {error}', { error: err.message || err });
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
  }, t('Manage'));
  previewBtn.addEventListener('click', async () => {
    setButtonLoading(previewBtn, true, t('Preparing…'));
    status.textContent = '';
    try {
      await openBrandPreview(api, { id: active, format: previewFormat.value });
    } catch (err) {
      status.textContent = t('The preview couldn’t be made: {error}', { error: err.message || err });
    } finally {
      setButtonLoading(previewBtn, false);
    }
  });

  const node = el('div.brand-settings', {},
    settingsCard(null,
      el('div.brand-active', {},
        el('label', { htmlFor: 'brand-active' }, t('Active brand profile')),
        el('div.brand-active-row', {}, select, manageBtn)),
      summary,
      el('div.brand-preview-row', {},
        el('div.setting-text', {}, el('div.setting-title', {}, t('Preview generated output')),
          el('div.setting-desc', {}, t('Exports a short sample guide with this profile and opens it.'))),
        el('div.row', {}, previewFormat, previewBtn)),
      status),
    settingsCard(t('Where branding appears'),
      el('dl.brand-support', {}, ...BRAND_SUPPORT.flatMap(([format, what]) => [el('dt', {}, format), el('dd', {}, what)])),
      el('p.setting-desc', {}, t('The Export dialog can pick a different profile, or none, for one export.'))));
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
        rows.replaceChildren(el('div.muted', {}, t('No brand profiles yet. Choose New profile to make one.')));
        return;
      }
      rows.replaceChildren(...list.map((p) => el('div.row.brand-profile-row', {},
        el('span.brand-profile-name', {}, p.name),
        el('div.row', {},
          el('button', { type: 'button', onClick: () => edit(p.id).catch(fail) }, t('Edit')),
          el('button', { type: 'button', onClick: async () => {
            try { created.push((await api.branding.duplicate({ id: p.id })).profile.id); await reload(); } catch (err) { fail(err); }
          } }, t('Duplicate')),
          el('button', { type: 'button', onClick: async () => {
            try { const res = await api.branding.export({ id: p.id }); if (res?.ok) toast(t('“{name}” saved as a .sfbrand file.', { name: p.name })); } catch (err) { fail(err); }
          } }, t('Share…')),
          el('button.danger', { type: 'button', onClick: async () => {
            if (!await confirmDialog(t('Delete the brand profile “{name}”? Exports that use it go back to no branding.', { name: p.name }), { danger: true, okLabel: t('Delete') })) return;
            try { list = await api.branding.delete({ id: p.id }); render(); } catch (err) { fail(err); }
          } }, t('Delete'))))));
    }

    const { close } = openModal({
      title: t('Brand profiles'),
      body: el('div.brand-profiles', {},
        el('div.row', { style: { marginBottom: '10px' } },
          el('button.primary', { type: 'button', onClick: () => edit(null).catch(fail) }, t('New profile…')),
          el('button', { type: 'button', onClick: async () => {
            try {
              const res = await api.branding.import();
              if (!res?.ok) return;
              created.push(res.profile.id);
              toast(t('Imported “{name}”.', { name: res.profile.name }));
              await reload();
            } catch (err) { fail(err); }
          } }, t('Import .sfbrand…')),
          el('span.muted', {}, t('Profiles are shareable as .sfbrand files.'))),
        rows,
        status),
      footer: [el('button.primary', { type: 'button', onClick: () => { close(); resolve({ created }); } }, t('Done'))],
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
    const name = el('input', { type: 'text', value: draft.name, maxLength: 80, placeholder: t('Company Default'), 'aria-label': t('Profile name') });
    const nameMessage = brandRowMessage();
    name.addEventListener('input', () => { draft.name = name.value; name.classList.remove('invalid'); nameMessage.clear(); });

    // Images
    const imageMessages = {};
    const imageRow = (key, title, desc, onChange = () => {}) => {
      const thumb = el('div');
      const fileName = el('span.setting-desc');
      const message = brandRowMessage();
      imageMessages[key] = message;
      const remove = el('button', { type: 'button', onClick: () => { draft[key] = null; message.clear(); show(); onChange(); } }, t('Remove'));
      const choose = el('button', { type: 'button' }, t('Choose…'));
      const show = () => {
        const asset = draft[key] ? assets[draft[key]] : null;
        thumb.replaceChildren(brandThumb(asset, title));
        fileName.textContent = asset?.name || t('None');
        remove.disabled = !asset;
      };
      choose.addEventListener('click', async () => {
        setButtonLoading(choose, true, t('Adding…'));
        try {
          const picked = await api.branding.chooseAsset({ kind: 'image' });
          if (!picked) return;
          message.clear();
          const asset = await ensureBrandRaster(api, picked);
          assets[asset.id] = asset;
          draft[key] = asset.id;
          show();
          onChange();
        } catch (err) { message.show(err); } finally { setButtonLoading(choose, false); }
      });
      show();
      return el('div.brand-asset-row', {}, thumb,
        el('div.setting-text', {}, el('div.setting-title', {}, title), el('div.setting-desc', {}, desc), fileName, message.node),
        el('div.row', {}, choose, remove));
    };

    // Colors: a color picker and its hex code, kept in step, editing colors[key].
    // `setters[key]` sets both from code; `onInput` hears the user change it.
    const colorRow = (colors, key, title, desc, { setters = null, onInput = () => {} } = {}) => {
      const picker = el('input', { type: 'color', value: colors[key].toLowerCase(), 'aria-label': t('{name} color', { name: title }) });
      const hex = el('input.brand-hex', { type: 'text', value: colors[key], maxLength: 7, spellcheck: false, 'aria-label': t('{name} color code', { name: title }) });
      picker.addEventListener('input', () => { colors[key] = picker.value.toUpperCase(); hex.value = colors[key]; onInput(); });
      hex.addEventListener('input', () => {
        const v = hex.value.trim();
        const ok = /^#?[0-9a-f]{6}$/i.test(v);
        hex.classList.toggle('invalid', !ok);
        if (ok) { colors[key] = `#${v.replace('#', '')}`.toUpperCase(); picker.value = colors[key].toLowerCase(); onInput(); }
      });
      if (setters) {
        setters[key] = (value) => {
          colors[key] = value;
          picker.value = value.toLowerCase();
          hex.value = value;
          hex.classList.remove('invalid');
        };
      }
      return settingRow(title, desc, el('div.row', {}, picker, hex));
    };

    // Match the logo: set the brand colors from the logo's own, with Undo.
    // Offered only while the profile has a logo.
    const colorSetters = {};
    let colorsBeforePick = null;
    const pickMessage = brandRowMessage();
    const pickStatus = el('p.setting-desc.brand-pick-status', { role: 'status', hidden: true });
    const forgetPick = () => { colorsBeforePick = null; pickStatus.hidden = true; };
    const setBrandColors = (colors) => { for (const key of ['primary', 'accent', 'text']) colorSetters[key](colors[key]); };
    const undoPick = el('button.link', { type: 'button', onClick: () => { if (colorsBeforePick) setBrandColors(colorsBeforePick); forgetPick(); } }, t('Undo'));
    const pickBtn = el('button', { type: 'button' }, t('Pick from logo'));
    pickBtn.addEventListener('click', async () => {
      const logo = draft.logo ? assets[draft.logo] : null;
      if (!logo?.dataUrl) return;
      pickMessage.clear();
      setButtonLoading(pickBtn, true, t('Picking…'));
      try {
        const picked = await brandColorsFromLogo(logo);
        if (!picked) {
          pickMessage.show(t('This logo is white or light gray, so there are no colors to pick. Set them above.'));
          return;
        }
        const before = { ...draft.colors };
        setBrandColors(picked);
        colorsBeforePick = before;
        pickStatus.replaceChildren(t('Colors picked from the logo.'), ' ', undoPick);
        pickStatus.hidden = false;
      } catch (err) {
        pickMessage.show(t('StepForge couldn’t read the logo’s colors: {error}', { error: err.message || err }));
      } finally {
        setButtonLoading(pickBtn, false);
      }
    });
    const pickRow = el('div', {},
      settingRow(t('Match the logo'), t('Set Primary, Accent and Text from your logo’s colors. Accent and Text are darkened if needed so they’re easy to read.'), pickBtn),
      pickStatus, pickMessage.node);
    const syncLogoTools = () => {
      pickRow.hidden = !draft.logo;
      if (!draft.logo) { forgetPick(); pickMessage.clear(); }
    };
    syncLogoTools();

    // Annotation colors: StepForge's unless the profile turns its own on.
    const ownAnnotations = el('input', { type: 'checkbox', checked: draft.annotations.custom });
    const annotationRows = el('div', { hidden: !draft.annotations.custom },
      colorRow(draft.annotations, 'shapes', t('Shapes'), t('Rectangles, ovals, lines, arrows, text and magnifiers, and the marker on recorded clicks.')),
      colorRow(draft.annotations, 'numbers', t('Number badges'), t('Numbered step markers.')),
      colorRow(draft.annotations, 'tooltips', t('Tooltips'), t('The tooltip bubble. Its text turns black or white to stay readable.')));
    ownAnnotations.addEventListener('change', () => { draft.annotations.custom = ownAnnotations.checked; annotationRows.hidden = !ownAnnotations.checked; });

    // Fonts
    const fontList = el('datalist', { id: 'brand-font-list' }, BRAND_FONT_SUGGESTIONS.map((f) => el('option', { value: f })));
    const fontRow = (role, title, desc) => {
      const f = draft.fonts[role];
      const input = el('input', { type: 'text', value: f.name, maxLength: 80, placeholder: t('StepForge default'), list: 'brand-font-list', 'aria-label': t('{role} font', { role: title }) });
      const file = el('span.setting-desc');
      const message = brandRowMessage();
      const remove = el('button', { type: 'button', onClick: () => { f.asset = null; message.clear(); show(); } }, t('Remove file'));
      const upload = el('button', { type: 'button' }, t('Upload font…'));
      const show = () => {
        const asset = f.asset ? assets[f.asset] : null;
        file.textContent = asset ? t('Font file: {name} (embedded in HTML exports)', { name: asset.name || asset.family }) : t('No font file: readers need the font installed.');
        remove.hidden = !asset;
      };
      input.addEventListener('input', () => { f.name = input.value; });
      upload.addEventListener('click', async () => {
        setButtonLoading(upload, true, t('Adding…'));
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
    const cover = brandSelect(draft.cover, BRAND_COVER_STYLES, { 'aria-label': t('Cover style') });
    cover.addEventListener('change', () => { draft.cover = cover.value; });
    const scheme = brandSelect(draft.html.colorScheme, [
      { value: 'light', label: t('Always light') },
      { value: 'auto', label: t('Follow light or dark mode') },
    ], { 'aria-label': t('HTML color scheme') });
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
    const position = brandSelect(draft.watermark.position, BRAND_WATERMARK_POSITIONS, { 'aria-label': t('Watermark position') });
    position.addEventListener('change', () => { draft.watermark.position = position.value; });
    const opacity = el('input', { type: 'range', min: 0.1, max: 1, step: 0.05, value: draft.watermark.opacity, 'aria-label': t('Watermark opacity') });
    const opacityLabel = el('output', {}, `${Math.round(draft.watermark.opacity * 100)}%`);
    opacity.addEventListener('input', () => { draft.watermark.opacity = Number(opacity.value); opacityLabel.textContent = `${Math.round(draft.watermark.opacity * 100)}%`; });

    // Advanced CSS
    const css = el('textarea.brand-css-input', { rows: 7, spellcheck: false, placeholder: '.doc-header { padding: 2rem; }\n.step-head h2 { color: var(--brand-primary); }', 'aria-label': t('Advanced CSS') });
    css.value = draft.html.css;
    const cssMessage = brandRowMessage();
    // Over the limit is said as it's typed or pasted, and stops Save, rather than being cut short.
    const cssFits = () => {
      if (css.value.length <= BRAND_CSS_MAX_CHARS) { cssMessage.clear(); return true; }
      cssMessage.show(t('This CSS is {count} characters long. A profile can hold {max}.', { count: css.value.length.toLocaleString(dateLocale || 'en-US'), max: BRAND_CSS_MAX_CHARS.toLocaleString(dateLocale || 'en-US') }));
      return false;
    };
    const cssNote = el('p.setting-desc.brand-css-note', { role: 'status', hidden: true });
    css.addEventListener('input', () => { draft.html.css = css.value; cssNote.hidden = true; cssFits(); });
    const loadCss = el('button', { type: 'button', onClick: async () => {
      try {
        const picked = await api.branding.chooseAsset({ kind: 'css' });
        if (!picked) return;
        css.value = picked.css;
        draft.html.css = picked.css;
        cssNote.hidden = true;
        cssFits();
      } catch (err) { cssMessage.show(err); }
    } }, t('Load .css file…'));

    // Write with AI: the local model (Settings → AI) writes CSS from a
    // description, shown for review before it's added. Offered only when AI
    // is on and Ollama has the chosen model.
    const aiBtn = el('button', { type: 'button', hidden: true }, t('Write with AI…'));
    const aiRequest = el('textarea#brand-ai-request.brand-ai-request', {
      rows: 2, maxLength: BRAND_AI_REQUEST_MAX_CHARS, spellcheck: true,
      placeholder: t('For example: square step numbers, and step titles in the primary color'),
    });
    const aiModel = el('span.setting-desc.brand-ai-model');
    const aiMessage = brandRowMessage();
    const aiResult = el('pre.brand-css.brand-ai-result', { hidden: true, 'aria-label': t('Suggested CSS') });
    const aiCancel = el('button', { type: 'button' }, t('Cancel'));
    const aiWrite = el('button.primary', { type: 'button', disabled: true }, t('Write CSS'));
    const aiDiscard = el('button', { type: 'button' }, t('Discard'));
    const aiRetry = el('button', { type: 'button' }, t('Try again'));
    const aiAdd = el('button.primary', { type: 'button' }, t('Add to CSS'));
    const aiPanel = el('div.brand-ai', { hidden: true },
      el('label.setting-title', { htmlFor: 'brand-ai-request' }, t('Describe the change')),
      aiRequest, aiMessage.node, aiResult,
      el('div.brand-ai-actions', {}, aiModel, el('div.row', {}, aiCancel, aiDiscard, aiRetry, aiWrite, aiAdd)));
    let aiWriting = false;
    let aiRun = 0;
    let aiSuggestion = null;
    // idle: describing; writing: waiting for the model; result: a suggestion to add or discard.
    const aiState = (state) => {
      aiWriting = state === 'writing';
      aiRequest.disabled = aiWriting;
      aiResult.hidden = state !== 'result';
      aiCancel.hidden = state === 'result';
      aiCancel.textContent = aiWriting ? t('Stop') : t('Cancel');
      aiWrite.hidden = state === 'result';
      if (aiWriting) setButtonLoading(aiWrite, true, t('Writing…'));
      else if (aiWrite.classList.contains('loading')) setButtonLoading(aiWrite, false);
      aiWrite.disabled = aiWriting || !aiRequest.value.trim();
      for (const btn of [aiDiscard, aiRetry, aiAdd]) btn.hidden = state !== 'result';
    };
    const stopAi = () => {
      aiRun += 1;
      if (aiWriting) void api.ai.cancel({ guideId: BRAND_AI_REQUEST }).catch(() => {});
      aiState('idle');
    };
    const closeAi = () => {
      stopAi();
      aiSuggestion = null;
      aiMessage.clear();
      aiPanel.hidden = true;
      aiBtn.hidden = false;
    };
    const writeCss = async () => {
      const request = aiRequest.value.trim();
      if (!request || aiWriting) return;
      const run = ++aiRun;
      aiMessage.clear();
      aiState('writing');
      try {
        const result = await api.ai.brandCss({
          request,
          css: css.value.slice(0, BRAND_CSS_MAX_CHARS),
          profile: { colors: { ...draft.colors }, fonts: { heading: { name: draft.fonts.heading.name }, body: { name: draft.fonts.body.name } } },
        });
        if (run !== aiRun) return; // stopped, or the editor closed
        if (!result?.ok) {
          aiMessage.show(result?.reason || t('AI couldn’t write the CSS.'));
          aiState('idle');
          return;
        }
        aiSuggestion = { request, css: result.css };
        aiResult.textContent = result.css;
        aiState('result');
      } catch (err) {
        if (run !== aiRun) return;
        aiMessage.show(err);
        aiState('idle');
      }
    };
    aiBtn.addEventListener('click', () => {
      aiBtn.hidden = true;
      aiPanel.hidden = false;
      aiState('idle');
      aiRequest.focus();
    });
    aiRequest.addEventListener('input', () => { if (!aiWriting) aiWrite.disabled = !aiRequest.value.trim(); });
    aiRequest.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void writeCss(); }
    });
    aiCancel.addEventListener('click', () => { if (aiWriting) stopAi(); else closeAi(); });
    aiWrite.addEventListener('click', () => void writeCss());
    aiRetry.addEventListener('click', () => void writeCss());
    aiDiscard.addEventListener('click', () => { aiSuggestion = null; aiState('idle'); aiRequest.focus(); });
    aiAdd.addEventListener('click', () => {
      if (!aiSuggestion) return;
      // The request, as a comment, says what the added rules are for.
      const label = aiSuggestion.request.replace(/\s+/g, ' ').replace(/\*\//g, '* /').slice(0, 120);
      const existing = css.value.replace(/\s+$/, '');
      css.value = `${existing ? `${existing}\n\n` : ''}/* ${label} */\n${aiSuggestion.css}\n`;
      draft.html.css = css.value;
      aiRequest.value = '';
      closeAi();
      if (cssFits()) {
        cssNote.textContent = t('Added to your CSS. Choose Preview to see it.');
        cssNote.hidden = false;
      }
      css.scrollTop = css.scrollHeight;
    });
    api.ai.status().then((status) => {
      if (!status?.ready) return;
      aiModel.textContent = t('Written by {model} through Ollama.', { model: status.model });
      aiBtn.hidden = false;
    }).catch(() => {});

    const body = el('div.brand-editor', {},
      settingsCard(null, settingRow(t('Profile name'), t('Shown in the Active brand profile list.'), name), nameMessage.node),
      settingsCard(t('Brand assets'),
        imageRow('logo', t('Company logo'), t('PNG, JPG, or SVG (scripts and outside links are removed). On covers, page headers and slides.'), syncLogoTools),
        imageRow('banner', t('Banner'), t('Optional. A wide image across the top of covers, web pages and wiki pages.'))),
      settingsCard(t('Brand colors'),
        colorRow(draft.colors, 'primary', t('Primary'), t('Title bars, step numbers, headings and accent lines.'), { setters: colorSetters, onInput: forgetPick }),
        colorRow(draft.colors, 'accent', t('Accent'), t('Links and highlights.'), { setters: colorSetters, onInput: forgetPick }),
        colorRow(draft.colors, 'text', t('Text'), t('Body text.'), { setters: colorSetters, onInput: forgetPick }),
        pickRow),
      settingsCard(t('Annotation colors'),
        settingRow(t('Use your own annotation colors'), t('Off keeps StepForge’s: red shapes, blue number badges, dark tooltips. New annotations start in these colors; ones already drawn keep theirs.'),
          makeSwitch(ownAnnotations, t('Use your own annotation colors'))),
        annotationRows),
      settingsCard(t('Fonts'),
        fontRow('heading', t('Headings'), t('Titles and step headings.')),
        fontRow('body', t('Body text'), t('Everything else.')),
        el('p.setting-desc', {}, t('Word and PowerPoint use these fonts by name. HTML embeds an uploaded font file. PDF uses the closest built-in font: Helvetica, Times or Courier.')),
        fontList),
      settingsCard(t('Layout'),
        settingRow(t('Cover style'), t('The title page of PDF, Word and PowerPoint, the top of HTML pages and the GIF title card.'), cover),
        settingRow(t('HTML color scheme'), t('Brand colors are usually picked for light pages.'), scheme)),
      settingsCard(t('Header and footer'),
        settingRow(t('Header text'), t('Top of every PDF and Word page; under the logo in HTML and wiki pages.'), textInput(draft.header, 'text', t('Acme Corp · IT Service Desk'), 160)),
        settingRow(t('Logo in page header'), t('PDF and Word pages after the cover.'), toggle(draft.header, 'logo', t('Logo in page header'))),
        settingRow(t('Footer text'), t('Bottom of every page and slide, and the end of HTML, Markdown and wiki pages.'), textInput(draft.footer, 'text', t('© Acme Corp. Internal use only.'), 200)),
        settingRow(t('Page numbers'), t('PDF and Word pages, and PowerPoint slides.'), toggle(draft.footer, 'pageNumbers', t('Page numbers')))),
      settingsCard(t('Watermark'),
        settingRow(t('Watermark screenshots with the logo'), t('GIF and image bundle exports.'), toggle(draft.watermark, 'enabled', t('Watermark screenshots with the logo'))),
        settingRow(t('Position'), null, position),
        settingRow(t('Opacity'), null, el('div.row.settings-range', {}, opacity, opacityLabel))),
      settingsCard(t('Advanced CSS'),
        el('p.setting-desc', {}, ...fillNodes(t('Used for HTML and GitHub Pages outputs only. Added after StepForge’s styles, so it wins. var(--brand-primary), var(--brand-accent) and var(--brand-text) hold your colors. {link}.'), {
          link: el('a', { href: BRAND_CSS_GUIDE_URL, onClick: (e) => { e.preventDefault(); void api.shell.openExternal({ url: BRAND_CSS_GUIDE_URL }).catch(() => {}); } }, t('What you can style')),
        })),
        css,
        cssMessage.node,
        cssNote,
        el('div.settings-actions', {}, loadCss, aiBtn),
        aiPanel));

    const previewFormat = brandSelect('html-rich', BRAND_PREVIEW_FORMATS, { 'aria-label': t('Preview format') });
    const previewBtn = el('button', { type: 'button' }, t('Preview'));
    previewBtn.addEventListener('click', async () => {
      if (!cssFits()) { css.focus(); return; }
      footerStatus.textContent = '';
      setButtonLoading(previewBtn, true, t('Preparing…'));
      try { await openBrandPreview(api, { profile: draft, format: previewFormat.value }); } catch (err) { fail(err); } finally { setButtonLoading(previewBtn, false); }
    });
    const saveBtn = el('button.primary', { type: 'button' }, t('Save'));
    saveBtn.addEventListener('click', async () => {
      if (!draft.name.trim()) {
        name.classList.add('invalid');
        nameMessage.show(t('Give the profile a name.'));
        name.focus();
        return;
      }
      if (!cssFits()) { css.focus(); return; }
      footerStatus.textContent = '';
      setButtonLoading(saveBtn, true, t('Saving…'));
      try {
        const saved = await api.branding.save({ profile: draft });
        stopAi();
        close();
        resolve(saved);
      } catch (err) {
        fail(err);
        setButtonLoading(saveBtn, false);
      }
    });

    // Edits to the draft (any field, colors, images, CSS) count as unsaved until Save.
    const isDraftDirty = unsavedChanges(() => draft);
    const { close, requestDismiss } = openModal({
      title: base ? t('Edit brand profile') : t('New brand profile'),
      body,
      footer: [previewFormat, previewBtn, footerStatus,
        el('button', { type: 'button', onClick: () => requestDismiss() }, t('Cancel')), saveBtn],
      wide: true,
      isDirty: isDraftDirty,
      onClose: () => { stopAi(); resolve(null); },
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
