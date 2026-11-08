# Flowcharts and Markdown descriptions

## Choose a placement

Select a step. At the right of the canvas toolbar, **Main visual** offers
**Image**, **Flowchart**, and **None**. Flowchart replaces the screenshot
tools with diagram tools. The screenshot and annotations stay saved;
choosing Image brings them back. You can also select Flowchart when adding
a step. Titles, descriptions and blocks work with either visual.

For a diagram alongside a screenshot, choose **+ Flowchart** in Blocks.
**Edit flowchart** opens that block in the large canvas; **Done** returns
to the main visual. The diagram toolbar's **Flowchart placement** selector
moves the diagram between **Main visual** and **Content block**. If another
main diagram exists, it is preserved in the old block rather than overwritten.
The dotted background and toolbars appear only in the app, never in exports.

## Edit a diagram

- **Add node**, **Decision**, **Start**, and **End** add shapes.
- Select a node to edit its label, shape, or **Go to step** destination.
- Drag nodes to move them. Keyboard users can Tab to a node, press Enter to
  select it, use arrows to move it, and Delete to remove it. Shift+Arrow
  moves farther.
- **Connect**, then select two nodes. Select a connection to edit its branch
  label or delete it. Connections may loop back.
- **Arrange** lays out the graph. **Undo** and **Redo** include graph and
  placement changes. **Mermaid source** shows generated source to copy.

Graphs support up to 100 nodes and 200 connections. Graph JSON is the
editable source; Mermaid is generated from it. Arbitrary Mermaid source
import/editing is not supported. No Mermaid server or network renderer is used.

## Generate with AI

Configure AI in Settings. Choose **Generate with AI…** in the diagram toolbar
or **AI → Generate flowchart…**. Describe the diagram or change, review its
branches, then choose **Apply**. Cancel preserves the existing diagram. A
draft cannot overwrite a diagram changed while AI was writing.

Requests use your configured Ollama or OpenAI-compatible server and include
step IDs, titles, descriptions, your request and the current graph, without
screenshots. Step references are validated before preview. A recording captures
one path, so review any suggested alternatives.

MCP agents can call `set_flowchart` with `placement: "main"` or `"block"`.
`get_step` includes diagrams and `delete_blocks` can remove diagram blocks.
Existing agent access controls apply; set_flowchart saves a snapshot first.

## Markdown and step links

Descriptions default to **Rich text**. The writing-mode dropdown offers
**Rich text** and **Markdown**. In Markdown mode, a **Preview** button next to
the dropdown shows the rendered description, highlights blue, and changes
to **Editor**; press it again to return to the source. Markdown
supports CommonMark headings, emphasis (including underscores), nested lists,
quotes, fenced/indented code, reference links, escapes and autolinks, plus
tables and strikethrough. Source is saved exactly and reused in Markdown
exports, including code fence languages. Legacy HTML-only descriptions stay
valid; merely opening them does not rewrite them. Editing Rich text uses
that edited HTML.

Raw HTML is displayed as text. Remote image syntax becomes an explicit link,
so opening a guide does not silently load third-party images. Use a step
screenshot for embedded pictures.

In Rich text, the **Step** button beside **Clear** inserts a link at the
cursor, with a destination selected by number/title. It immediately shows
the current number, such as **Step 2**, and retains the destination's permanent
ID. The Step button is available only in Rich text. Markdown source may also
contain `[Step](step:<permanent-id>)`; Preview shows the current number.
Custom labels work too, such as
`[Try signing in](step:step-eec6232c-51e4-481a-8c81-fe5653f8a0c7)`.
Click a link in Preview to navigate, or Ctrl/Cmd-click in Rich text.

Reordering steps changes displayed numbers, not references. Export numbering
is resolved after hidden/skipped filtering. Missing destinations are marked
unavailable without a broken link. Copying/importing a guide remaps references
to the new permanent IDs.

## Exports

HTML embeds SVG; Markdown and Wiki.js emit Mermaid fences. Word, PDF,
Confluence, clipboard, PowerPoint, GIF and image bundles include diagram images.
PowerPoint gives each diagram block its own slide; GIF adds a frame per block.
JSON includes graph data. Image exclusion options exclude raster diagrams too.
Step links navigate in HTML, Markdown, Confluence, PDF and Word; other formats
retain readable step numbers. Native formats retain existing description
layout limits, including PowerPoint's short text summary.

Export workers use shared graph geometry and the existing bundled Sharp SVG
renderer for system-font text. Direct synchronous core callers have a raster
fallback with the same character coverage as screenshot annotations.
