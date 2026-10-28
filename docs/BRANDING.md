# Brand your exported guides

A **brand profile** puts your company's look on everything you export: your
logo and banner, colors, fonts, a cover style, header and footer text, and
extra CSS for web pages. Set it up once and every guide uses it.

## Make a brand profile

1. Open **Settings → Branding** and choose **Manage**.
2. Choose **New profile…** and fill in what you need. Everything except the
   name is optional:
   - **Profile name**: what the **Active brand profile** list shows.
   - **Company logo** and **Banner**: PNG, JPG or SVG, up to 10 MB each. The
     banner is a wide image across the top of covers and web pages.
   - **Brand colors**: **Primary** (title bars, step numbers, headings and
     accent lines), **Accent** (links and highlights) and **Text** (body text).
   - **Fonts**: one for headings and one for body text. Type any font name or
     pick a suggestion. **Upload font…** adds a font file (WOFF2, WOFF, TTF or
     OTF) that HTML exports carry with them, so the page looks right on
     computers that don't have the font.
   - **Cover style**: **Standard**, **Centered**, or **Brand color band**
     (the title on a block of your primary color).
   - **HTML color scheme**: **Always light**, or **Follow light or dark
     mode** to let web pages switch to dark colors when the reader's computer
     is in dark mode.
   - **Header text**, **Logo in page header**, **Footer text** and **Page
     numbers**.
   - **Watermark screenshots with the logo**, with its corner and opacity.
   - **Annotation colors**: off by default, so annotations keep StepForge's
     colors (red shapes, blue number badges, dark tooltips). Turn on **Use
     your own annotation colors** to pick colors for **Shapes** (rectangles,
     ovals, lines, arrows, text and magnifiers, and the marker on recorded
     clicks), **Number badges** and **Tooltips**. New annotations start in
     these colors; ones already drawn keep theirs, and you can still change
     any annotation's color in the editor. Highlights stay yellow.
   - **Advanced CSS**: see [below](#advanced-css).
3. Choose **Preview** at the bottom to see a sample guide with your changes,
   then **Save**.
4. Back in **Settings → Branding**, pick the profile under **Active brand
   profile** and choose **Save**.

**Design preview** in Settings → Branding exports a short sample guide with the
chosen profile, in the format you pick, and opens it.

In the **Export** dialog, the **Branding** row uses the active profile. You can
pick another profile, or **No branding**, for one export. Accent and caption
colors in the export options start at the profile's colors. A color you change
there, or one saved in an export template, takes their place.

## Where branding appears

| Export | What it gets |
| --- | --- |
| HTML (simple and rich) | Logo, banner, header text, colors, fonts (uploaded font files are built in), cover style, footer text and your [Advanced CSS](#advanced-css) |
| GitHub Pages | Everything the HTML exports get |
| PDF | Logo and banner on the cover in its style, colors, the closest built-in fonts, a header (logo and text) and footer (text and "Page 2 of 9") on every page after the cover |
| Word | Normal and Heading styles in your fonts and colors, logo and banner on the cover, a header and footer with page numbers on every page after the cover |
| PowerPoint | A theme with your colors and fonts, a title slide in your cover style, and the logo, footer text and slide numbers on every slide after it |
| Wiki.js, Confluence | Logo, banner, header and footer text. Publishing uploads the images too |
| Markdown | Logo, banner, header and footer text, and the color of the accent line |
| GIF, image bundle | Logo on the GIF title card, your colors, and the logo as a watermark if you turn it on |
| JSON | Nothing. JSON keeps the raw guide data |
| The editor | With **Use your own annotation colors** on: new shapes, number badges, tooltips and click markers start in the profile's colors |

A few things to know:

- **PDF** can't carry your font files, so it uses the closest of its built-in
  fonts: Helvetica for sans-serif fonts, Times for serif fonts such as Georgia,
  and Courier for monospaced ones.
- **Word and PowerPoint** use your fonts by name. People who open the file
  need those fonts installed; otherwise Office substitutes another.
- **PowerPoint** uses theme colors and fonts, so **Design → Variants** in
  PowerPoint can still change them later.
- A watermark picked in the Export dialog (image bundle) replaces the
  profile's.

## Advanced CSS

Advanced CSS styles the **HTML exports and GitHub Pages** only. Everything else
ignores it.

It's added after StepForge's own styles, so your rules win when they target
the same thing. The **Custom CSS** option in the Export dialog (or a saved
HTML template) is added after the profile's CSS, which makes it handy for a
one-off change to a single export.

Type CSS in the box or choose **Load .css file…**. Use **Preview** in the
profile editor to check it before saving.

### Variables you can use

| Variable | What it is |
| --- | --- |
| `--brand-primary`, `--brand-accent`, `--brand-text` | The profile's three colors |
| `--on-primary` | Black or white, whichever reads better on the primary color |
| `--accent`, `--accent-rgb` | The accent the page uses for step numbers, rules and the Contents highlight: the primary color, unless the Export dialog changed it. `--accent-rgb` is `r, g, b` for `rgba(var(--accent-rgb), .2)` |
| `--link` | Link color (the brand accent) |
| `--text`, `--muted`, `--bg`, `--soft`, `--border` | Body text, secondary text, page background, panel background, lines |
| `--info`, `--success`, `--warn`, `--error` | Note, Tip, Warning and Important callout colors; each has a `-bg` partner such as `--warn-bg` |
| `--code-bg`, `--code-fg` | Code blocks when the code theme is Plain |
| `--font-body`, `--font-heading` | Font lists for body text and headings |

Change a variable in a `:root` rule, for example
`:root { --link: #0B6E4F; }`. The exception is `--accent`: it's set on the
page itself, so change the profile's **Primary** color instead.

### What you can style

Both HTML exports are built the same way. The rich one adds a contents sidebar
with a progress bar, done toggles and a screenshot viewer.

| Selector | What it is |
| --- | --- |
| `.page` (`.page.rich` in the rich export) | The page's column. The rich one is a grid of `nav.toc` and `.content` |
| `.doc-header` | The top of the page; also `.cover-standard`, `.cover-centered` or `.cover-band` |
| `.brand-banner`, `.brand-bar`, `.brand-logo`, `.brand-tagline` | Banner image, the row with the logo and header text, the logo, the header text |
| `.doc-header .rule`, `.doc-header h1`, `.lede`, `.meta` | The accent line above the title, the guide title, its description, the line with the step count and author |
| `nav.contents` (simple), `nav.toc` (rich) | The contents list; entries are `.toc-list li.d0` (top level) to `li.d3`, each `a` holding `.num` and `.label` |
| `.toc-list a.active`, `.toc-list a.done` | Rich: the step being read, and finished steps |
| `.progress`, `.progress .bar`, `.progress .fill` | Rich: the "2 of 5 done" bar |
| `section.step` | One step; also `.depth-1` to `.depth-3` for substeps, `.skipped`, and `.done` once ticked (rich). Its `id` is `step-3`, or `step-3-1` for a substep |
| `.step-head`, `.step-num`, `.step-head h2` | The step's title row, its number badge, its title |
| `.pill` | The "Skipped" label |
| `.done-toggle` | Rich: the Done checkbox |
| `.step-body`, `.desc` | Everything under the title, and the step's description |
| `figure.shot img` | Screenshots |
| `aside.callout` | Notes and tips: `.callout-info` (Note), `.callout-success` (Tip), `.callout-warn` (Warning), `.callout-error` (Important), with `.callout-title` and `.callout-body` |
| `pre.code`, `.code-block`, `.copy-code` | Code blocks, their wrapper, and the copy button |
| `.table-wrap table`, `th`, `td` | Tables |
| `.doc-footer` | The footer line at the end |
| `.lightbox` | Rich: the full-size screenshot viewer |

### Examples

Color step titles with the primary color:

```css
.step-head h2 { color: var(--brand-primary); }
```

Square step numbers instead of round ones:

```css
.step-num { border-radius: 4px; }
```

A larger logo (the default limit is 64 px tall and 260 px wide):

```css
.brand-logo { max-height: 96px; max-width: 360px; }
```

A wider page:

```css
.page { max-width: 1040px; }
.page.rich { max-width: 1360px; }
```

Slightly smaller text:

```css
body { font-size: 15px; }
```

Screenshots without a frame or shadow:

```css
.shot img { border: 0; border-radius: 0; box-shadow: none; }
```

Your own colors for warnings (the callouts and the Skipped label):

```css
:root { --warn: #9A3412; --warn-bg: #FFF7ED; }
```

A plain band cover with square corners:

```css
.doc-header.cover-band { border-radius: 0; }
```

Hide the progress bar in the rich export and the footer line in both:

```css
.progress, .doc-footer { display: none; }
```

Leave the banner off printed copies:

```css
@media print { .brand-banner { display: none; } }
```

With **Follow light or dark mode**, change something only in dark mode:

```css
@media (prefers-color-scheme: dark) {
  .step-head h2 { color: var(--brand-accent); }
}
```

### Good to know

- **Fonts:** prefer **Upload font…** to `@import`ing a web font. An uploaded
  font travels inside the page. `@import` and `url(https://…)` make the page
  download from that site every time someone opens it, which needs a
  connection and tells that site the page was viewed. StepForge's own exports
  never reach the internet.
- **No scripts:** CSS is all this box takes. Text that would end the
  `<style>` element early is neutralized, so it can't add markup or scripts to
  the page.
- **Limit:** 200,000 characters.

## Share a profile

In **Manage**, **Share…** saves a profile as a `.sfbrand` file with its logo,
banner and font files. Teammates add it with **Import .sfbrand…**. Every image
and font in it is checked again as if it were uploaded, and SVG images are
cleaned of scripts, links and anything else that isn't drawing.

## Where profiles are kept

Profiles live in your data folder under `settings/branding/` (see
**Settings → About → Data folder**). Logos, banners and fonts are kept beside
them. An upload that no profile uses any more is deleted after a day.
