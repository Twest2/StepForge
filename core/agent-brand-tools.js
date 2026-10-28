'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  BrandingStore, normalizeProfile, checkFileSize, COVER_STYLES, WATERMARK_POSITIONS, COLOR_SCHEMES, MAX_CSS_CHARS,
} = require('./branding');
const { STYLE_REFERENCE } = require('./ai-brand-css');
const { Settings } = require('./settings');
const { decodePng, encodePng } = require('./png');
const { resize } = require('./raster');

/**
 * Brand profile tools for AI agents (core/agent-tools.js), behind their own
 * switch: Settings → AI → Let AI agents edit brand profiles, off by default.
 * Agents read, create and change profiles, add a logo, banner or font file
 * from this computer, and choose the active profile. They can't delete one.
 */

const HEX = /^#[0-9a-fA-F]{6}$/;
// The logo get_brand_profile shows is at most this many pixels on its long side.
const LOGO_PREVIEW_EDGE = 512;
// set_brand_file slots and the kind of file each takes.
const FILE_SLOTS = { logo: 'image', banner: 'image', heading_font: 'font', body_font: 'font' };
const IMAGE_FORMATS = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/svg+xml': 'svg' };

const BRAND_INSTRUCTIONS = [
  'If the user allows it (Settings → AI → Let AI agents edit brand profiles), you can also manage brand profiles: the logo, banner, colors, fonts, cover style, header, footer and CSS that exported guides use.',
  'Use list_brand_profiles and get_brand_profile to read them, create_brand_profile and update_brand_profile to change them, set_brand_file to add a logo, banner or font file from this computer, and set_active_brand_profile to choose the one exports use. You can\'t delete brand profiles.',
];

const colorSchema = { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' };
const PROFILE_FIELDS = {
  name: { type: 'string', maxLength: 80, description: 'What the Active brand profile list in Settings shows.' },
  colors: {
    type: 'object',
    description: 'primary: title bars, step numbers, headings and accent lines. accent: links and highlights. text: body text. Each is #RRGGBB.',
    properties: { primary: colorSchema, accent: colorSchema, text: colorSchema },
    additionalProperties: false,
  },
  fonts: {
    type: 'object',
    description: 'Heading and body font names. Word and PowerPoint use them by name; PDF uses the closest of Helvetica, Times or Courier. Add a font file with set_brand_file.',
    properties: {
      heading: { type: 'object', properties: { name: { type: 'string', maxLength: 80 } }, additionalProperties: false },
      body: { type: 'object', properties: { name: { type: 'string', maxLength: 80 } }, additionalProperties: false },
    },
    additionalProperties: false,
  },
  cover: { type: 'string', enum: COVER_STYLES, description: 'Title page style. band puts the title on a block of the primary color.' },
  html_color_scheme: { type: 'string', enum: COLOR_SCHEMES, description: 'light: HTML exports are always light. auto: they follow the reader\'s light or dark mode.' },
  header: {
    type: 'object',
    description: 'text: top of every PDF and Word page, and under the logo on web pages. logo: the logo in PDF and Word page headers.',
    properties: { text: { type: 'string', maxLength: 160 }, logo: { type: 'boolean' } },
    additionalProperties: false,
  },
  footer: {
    type: 'object',
    description: 'text: bottom of every page and slide, and the end of web pages. page_numbers: PDF and Word pages, PowerPoint slides.',
    properties: { text: { type: 'string', maxLength: 200 }, page_numbers: { type: 'boolean' } },
    additionalProperties: false,
  },
  watermark: {
    type: 'object',
    description: 'The logo on GIF and image bundle screenshots.',
    properties: {
      enabled: { type: 'boolean' },
      position: { type: 'string', enum: WATERMARK_POSITIONS },
      opacity: { type: 'number', minimum: 0.05, maximum: 1 },
    },
    additionalProperties: false,
  },
  annotation_colors: {
    type: 'object',
    description: 'Colors new annotations start in, used only when custom is true; otherwise StepForge\'s (red shapes, blue number badges, dark tooltips).',
    properties: { custom: { type: 'boolean' }, shapes: colorSchema, numbers: colorSchema, tooltips: colorSchema },
    additionalProperties: false,
  },
  css: {
    type: 'string',
    maxLength: MAX_CSS_CHARS,
    description: 'Advanced CSS for HTML exports and GitHub Pages, added after StepForge\'s styles. This replaces the profile\'s CSS: '
      + 'read it with get_brand_profile first (which also lists the selectors and variables) and send all of it.',
  },
};

function createBrandTools({ settingsDir, requireEnabled, agentSettings, onChange = () => {}, AgentError, text }) {
  const store = new BrandingStore(settingsDir);
  const fail = (message) => { throw new AgentError(message); };
  const requireBranding = () => {
    requireEnabled();
    if (!agentSettings()?.branding) {
      fail('StepForge doesn\'t let AI agents edit brand profiles. Ask the user to turn on Settings → AI → Let AI agents edit brand profiles, then try again.');
    }
  };
  const activeId = () => new Settings(settingsDir).get('branding.activeProfileId') || '';
  const loadProfile = (id) => store.get(id) || fail(`No brand profile with id "${id}". Call list_brand_profiles to find it.`);

  const imageInfo = (asset) => {
    const meta = asset ? store.assetMeta(asset) : null;
    return meta ? { file_name: meta.name, format: IMAGE_FORMATS[meta.mime] || meta.ext, width: meta.width, height: meta.height } : null;
  };
  const fontFile = (asset) => {
    const meta = asset ? store.assetMeta(asset) : null;
    return meta ? { file_name: meta.name, family: meta.family } : null;
  };
  const forAgent = (profile) => ({
    profile_id: profile.id,
    name: profile.name,
    active: profile.id === activeId(),
    colors: profile.colors,
    fonts: {
      heading: { name: profile.fonts.heading.name, file: fontFile(profile.fonts.heading.asset) },
      body: { name: profile.fonts.body.name, file: fontFile(profile.fonts.body.asset) },
    },
    logo: imageInfo(profile.logo),
    banner: imageInfo(profile.banner),
    cover: profile.cover,
    html_color_scheme: profile.html.colorScheme,
    header: profile.header,
    footer: { text: profile.footer.text, page_numbers: profile.footer.pageNumbers },
    watermark: profile.watermark,
    annotation_colors: profile.annotations,
    css: profile.html.css,
    updated_at: profile.updatedAt,
  });

  /** The profile with the agent's fields applied. Anything invalid is refused, not dropped. */
  const applyFields = (profile, fields) => {
    const next = JSON.parse(JSON.stringify(profile));
    const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined;
    const object = (value, what, keys) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${what} must be an object.`);
      const unknown = Object.keys(value).find((k) => !keys.includes(k));
      if (unknown) fail(`${what} has no field "${unknown}". It takes ${keys.join(', ')}.`);
      return value;
    };
    const str = (value, max, what) => {
      if (typeof value !== 'string') fail(`${what} must be text.`);
      if (value.length > max) fail(`${what} is too long: at most ${max.toLocaleString('en-US')} characters.`);
      return value;
    };
    const bool = (value, what) => (typeof value === 'boolean' ? value : fail(`${what} must be true or false.`));
    const color = (value, what) => (typeof value === 'string' && HEX.test(value) ? value.toUpperCase() : fail(`${what} must be a color like #1F6FEB.`));
    const choice = (value, values, what) => (values.includes(value) ? value : fail(`${what} must be one of: ${values.join(', ')}.`));

    if (has(fields, 'name')) next.name = str(fields.name, 80, 'name').trim() || fail('name can\'t be empty.');
    if (has(fields, 'colors')) {
      const colors = object(fields.colors, 'colors', ['primary', 'accent', 'text']);
      for (const key of Object.keys(colors)) if (has(colors, key)) next.colors[key] = color(colors[key], `colors.${key}`);
    }
    if (has(fields, 'fonts')) {
      const fonts = object(fields.fonts, 'fonts', ['heading', 'body']);
      for (const role of Object.keys(fonts)) {
        const font = object(fonts[role], `fonts.${role}`, ['name']);
        if (has(font, 'name')) next.fonts[role].name = str(font.name, 80, `fonts.${role}.name`);
      }
    }
    if (has(fields, 'cover')) next.cover = choice(fields.cover, COVER_STYLES, 'cover');
    if (has(fields, 'html_color_scheme')) next.html.colorScheme = choice(fields.html_color_scheme, COLOR_SCHEMES, 'html_color_scheme');
    if (has(fields, 'header')) {
      const header = object(fields.header, 'header', ['text', 'logo']);
      if (has(header, 'text')) next.header.text = str(header.text, 160, 'header.text');
      if (has(header, 'logo')) next.header.logo = bool(header.logo, 'header.logo');
    }
    if (has(fields, 'footer')) {
      const footer = object(fields.footer, 'footer', ['text', 'page_numbers']);
      if (has(footer, 'text')) next.footer.text = str(footer.text, 200, 'footer.text');
      if (has(footer, 'page_numbers')) next.footer.pageNumbers = bool(footer.page_numbers, 'footer.page_numbers');
    }
    if (has(fields, 'watermark')) {
      const watermark = object(fields.watermark, 'watermark', ['enabled', 'position', 'opacity']);
      if (has(watermark, 'enabled')) next.watermark.enabled = bool(watermark.enabled, 'watermark.enabled');
      if (has(watermark, 'position')) next.watermark.position = choice(watermark.position, WATERMARK_POSITIONS, 'watermark.position');
      if (has(watermark, 'opacity')) {
        const opacity = watermark.opacity;
        if (typeof opacity !== 'number' || !(opacity >= 0.05 && opacity <= 1)) fail('watermark.opacity must be a number from 0.05 to 1.');
        next.watermark.opacity = opacity;
      }
    }
    if (has(fields, 'annotation_colors')) {
      const annotations = object(fields.annotation_colors, 'annotation_colors', ['custom', 'shapes', 'numbers', 'tooltips']);
      if (has(annotations, 'custom')) next.annotations.custom = bool(annotations.custom, 'annotation_colors.custom');
      for (const key of ['shapes', 'numbers', 'tooltips']) {
        if (has(annotations, key)) next.annotations[key] = color(annotations[key], `annotation_colors.${key}`);
      }
    }
    if (has(fields, 'css')) next.html.css = str(fields.css, MAX_CSS_CHARS, 'css');
    return next;
  };

  /** The logo as a small PNG for the agent to look at, or null before StepForge has drawn it. */
  const logoPreview = (profile) => {
    const raster = store.resolveProfile(profile).logo?.raster;
    if (!raster) return null;
    try {
      let img = decodePng(fs.readFileSync(raster.file));
      const scale = Math.min(1, LOGO_PREVIEW_EDGE / Math.max(img.width, img.height));
      if (scale < 1) img = resize(img, Math.max(1, Math.round(img.width * scale)), Math.max(1, Math.round(img.height * scale)));
      return encodePng(img).toString('base64');
    } catch {
      return null;
    }
  };

  const fieldNames = Object.keys(PROFILE_FIELDS);
  const onlyKnown = (args, extra) => {
    const unknown = Object.keys(args).find((k) => !fieldNames.includes(k) && !extra.includes(k));
    if (unknown) fail(`Unknown field "${unknown}".`);
  };

  return [
    {
      name: 'list_brand_profiles',
      description: 'List the brand profiles and which one exports use (the active one).',
      annotations: { readOnlyHint: true },
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler() {
        requireBranding();
        const active = activeId();
        const profiles = store.list().map((p) => ({ profile_id: p.id, name: p.name, active: p.id === active, updated_at: p.updatedAt }));
        return {
          content: [text(profiles.length
            ? { active_profile_id: profiles.some((p) => p.active) ? active : null, profiles }
            : 'No brand profiles yet. Make one with create_brand_profile.')],
        };
      },
    },
    {
      name: 'get_brand_profile',
      description: 'Read a brand profile, see its logo, and get the selectors and variables its CSS can use.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          profile_id: { type: 'string' },
          include_logo: { type: 'boolean', description: 'Attach the logo as an image (default true).' },
        },
        required: ['profile_id'],
        additionalProperties: false,
      },
      handler({ profile_id: id, include_logo: includeLogo = true } = {}) {
        requireBranding();
        const profile = loadProfile(id);
        const content = [text({ ...forAgent(profile), css_reference: STYLE_REFERENCE })];
        if (includeLogo && profile.logo) {
          const png = logoPreview(profile);
          if (png) content.push({ type: 'image', data: png, mimeType: 'image/png' });
          else content.push(text('StepForge hasn\'t drawn this logo as PNG yet, so it can\'t be shown. It will once StepForge is open.'));
        }
        return { content };
      },
    },
    {
      name: 'create_brand_profile',
      description: 'Make a brand profile. Only name is required; leave out the rest to keep StepForge\'s defaults. '
        + 'Add the logo, banner and font files afterwards with set_brand_file.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      inputSchema: { type: 'object', properties: PROFILE_FIELDS, required: ['name'], additionalProperties: false },
      handler(args = {}) {
        requireBranding();
        onlyKnown(args, []);
        if (typeof args.name !== 'string' || !args.name.trim()) fail('Give the profile a name.');
        const { id: _id, createdAt, updatedAt, ...defaults } = normalizeProfile({});
        const saved = store.save(applyFields(defaults, args));
        onChange({});
        return { content: [text(forAgent(saved))] };
      },
    },
    {
      name: 'update_brand_profile',
      description: 'Change a brand profile. Leave a field out to keep it; in colors, fonts, header, footer, watermark and annotation_colors, '
        + 'only the keys you send change.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: { profile_id: { type: 'string' }, ...PROFILE_FIELDS },
        required: ['profile_id'],
        additionalProperties: false,
      },
      handler({ profile_id: id, ...fields } = {}) {
        requireBranding();
        onlyKnown(fields, []);
        const profile = loadProfile(id);
        if (!Object.values(fields).some((v) => v !== undefined)) fail('Give at least one field to change.');
        const saved = store.save(applyFields(profile, fields));
        onChange({});
        return { content: [text(forAgent(saved))] };
      },
    },
    {
      name: 'set_brand_file',
      description: 'Add a logo or banner (PNG, JPG or SVG) or a heading or body font file (WOFF2, WOFF, TTF or OTF) to a brand profile from a file on this computer, '
        + 'or remove one. Files up to 10 MB. SVGs are cleaned of scripts and outside links.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          profile_id: { type: 'string' },
          slot: { type: 'string', enum: Object.keys(FILE_SLOTS) },
          file_path: { type: 'string', description: 'The file\'s full path.' },
          remove: { type: 'boolean', description: 'true to take the file out of the profile instead.' },
        },
        required: ['profile_id', 'slot'],
        additionalProperties: false,
      },
      handler({ profile_id: id, slot, file_path: filePath, remove = false } = {}) {
        requireBranding();
        const profile = loadProfile(id);
        if (!Object.hasOwn(FILE_SLOTS, slot)) fail(`slot must be one of: ${Object.keys(FILE_SLOTS).join(', ')}.`);
        const kind = FILE_SLOTS[slot];
        if (typeof remove !== 'boolean') fail('remove must be true or false.');
        const role = slot === 'heading_font' ? 'heading' : 'body';
        const next = JSON.parse(JSON.stringify(profile));
        const put = (asset) => { if (kind === 'image') next[slot] = asset; else next.fonts[role].asset = asset; };
        if (remove === true) {
          if (filePath !== undefined) fail('Give file_path or remove, not both.');
          put(null);
          const saved = store.save(next);
          onChange({});
          return { content: [text(forAgent(saved))] };
        }
        if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) fail('file_path must be the full path to a file on this computer.');
        let stat;
        try { stat = fs.statSync(filePath); } catch { fail(`There's no file at ${filePath}.`); }
        if (!stat.isFile()) fail(`${filePath} isn't a file.`);
        let asset;
        try {
          checkFileSize(kind, stat.size);
          asset = store.addAsset(fs.readFileSync(filePath), { kind, fileName: path.basename(filePath) });
        } catch (err) {
          fail(err.message);
        }
        put(asset.id);
        // Like the profile editor: the file's own family name, unless one is set.
        if (kind === 'font' && !next.fonts[role].name.trim()) next.fonts[role].name = asset.family;
        const saved = store.save(next);
        onChange({});
        const result = [text(forAgent(saved))];
        if (asset.needsRaster) {
          result.push(text('HTML exports use this image now. StepForge draws it as PNG for the other exports '
            + 'within a few seconds while it\'s open, or the next time it starts.'));
        }
        return { content: result };
      },
    },
    {
      name: 'set_active_brand_profile',
      description: 'Choose the brand profile every export uses, or "" for no branding (StepForge\'s own look).',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      inputSchema: {
        type: 'object',
        properties: { profile_id: { type: 'string', description: 'A profile id, or "" for no branding.' } },
        required: ['profile_id'],
        additionalProperties: false,
      },
      handler({ profile_id: id } = {}) {
        requireBranding();
        if (id !== '') loadProfile(id);
        new Settings(settingsDir).set('branding.activeProfileId', id);
        onChange({ activeProfileId: id });
        return { content: [text(id ? `Exports now use “${store.get(id).name}”.` : 'Exports now use no branding.')] };
      },
    },
  ];
}

module.exports = { createBrandTools, BRAND_INSTRUCTIONS };
