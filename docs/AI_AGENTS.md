# Let Claude or Codex write your guides

AI agents such as Claude Code, Codex, and Claude Desktop can connect to
StepForge and write your guides for you. You record the steps; the agent looks
at each screenshot and writes the titles, descriptions, notes, and tips.

Agents connect through the [Model Context Protocol](https://modelcontextprotocol.io)
(MCP). StepForge starts a small MCP server when the agent asks for it. No
window opens, and nothing runs when no agent is connected.

> [!NOTE]
> This is separate from the AI ▾ menu in the guide toolbar, which uses a model
> on your own computer through Ollama. See
> [AI-written guides with Ollama](getting_started_with_ai.md).

## What an agent can and can't do

| An agent can | An agent can't |
| --- | --- |
| List and read your guides | Change a placeholder you already have, or delete one |
| See each step's screenshot, with your blurs already filled in | Delete blurs, or see what they hide |
| Create guides, and move them to the Trash | Delete brand profiles |
| Rewrite a guide's title and description | Read anything outside your StepForge library, except a PNG you ask it to use as a screenshot, or an image or font file you ask it to add to a brand profile |
| Add, delete, and reorder steps, and make a step a substep of an earlier step | |
| Rewrite each step's title, description, and blocks, add notes, warnings, tips, and code, and delete blocks | |
| Replace a step's screenshot with a PNG file you point it to, or remove the screenshot | |
| Add guide and global placeholders, and use them as `[[Name]]` | |
| Draw on screenshots: rectangles, ovals, lines, arrows, text, callouts, numbered badges, blurs, highlights, magnifiers, and cursors. Delete what's drawn, except blurs | |
| If you allow it: make and change [brand profiles](BRANDING.md#let-an-ai-agent-set-up-your-brand), add a logo, banner or font file you point it to, and choose the active profile | |

Most of the time an agent works around your screenshots: it writes the text,
organizes the steps, and adds annotations on top. When it does more than that,
StepForge keeps a way back.

### Undoing what an agent did

Before an agent deletes, moves, or adds a step, replaces or removes a
screenshot, or deletes blocks or annotations, StepForge saves a snapshot of the
guide. To undo the change, open the guide and choose **More → Backups &
snapshots**. Each agent snapshot is named for what the agent was about to do,
for example "before agent deletes step 3". **Restore** the one from just before
the change you want to undo. Restoring snapshots the guide first, so a restore
can be undone too.

Automatic backups don't push agent snapshots out. StepForge keeps the newest 50
agent snapshots of each guide. Text rewrites, changing substep nesting with
`update_step`, adding placeholders and drawing annotations do not create agent
snapshots; create a manual snapshot first if you want a recovery point before
those edits.

A guide an agent deletes goes to the Trash, like one you delete. Restore it
from there. Its snapshot and Trash copy contain saved content; unsaved edits
in an open editor are not included when the agent deletes the guide. The
agent-access switch permits all the guide tools listed above; it is not a
separate approval for each deletion.

## 1. Turn on agent access

1. Open **Settings → AI**.
2. Under **AI agents (Claude, Codex)**, turn on **Let AI agents edit your
   guides**.
3. **Save.**

Leave **Agents can see screenshots** on so the agent can see what you clicked.
Turn it off to share step text only.

To let agents set up your brand as well, turn on **Let AI agents edit brand
profiles**. It's off by default. See
[Let an AI agent set up your brand](BRANDING.md#let-an-ai-agent-set-up-your-brand).

## 2. Connect your agent

Use the setup shown in **Settings → AI → AI agents**. It's made for this
computer, with StepForge's exact location. (From the
[Microsoft Store](windows/microsoft-store.md), it uses the `stepforge.exe`
command instead, which stays the same when the Store updates StepForge.)
Choose **Copy** next to the agent you use, then:

- **Claude Code or Codex:** paste the command into a terminal and run it once.
- **Claude Desktop, Cursor, and other MCP apps:** paste the JSON into the
  app's MCP server settings, then restart the app. In Claude Desktop, that's
  **Settings → Developer → Edit Config**.

## 3. Ask it to write a guide

Record a guide in StepForge as usual, then ask your agent, for example:

> Write the StepForge guide "Untitled guide": give every step a clear title and
> description, add a warning where something can go wrong, group the steps
> that belong together as substeps, put an arrow on anything easy to miss, and
> finish with a title and short introduction for the guide.

The agent finds the guide, looks at each step's screenshot, and rewrites the
text. It uses your placeholders where their values would appear, and can add
new ones for values that repeat, such as a course code or product name. If
the guide is open in StepForge, it updates on screen within a couple of
seconds. If you're typing in the same step at that moment, your edit wins. If
the agent deleted that step, StepForge drops its pending save and shows the
remaining steps instead of recreating it. For a surviving step, changes to
different fields, blocks or annotations combine; your edit wins when both
sides changed the same field.

Before you share the guide, read what the agent wrote. To undo a big rewrite,
use **More → Backups & snapshots**. Annotations an agent drew can be moved or
deleted like your own. If you have the guide open when an agent moves it to
the Trash, StepForge takes you back to the library.

## Privacy

StepForge itself sends nothing anywhere. It hands your guides to the agent on
your computer, and **the agent sends what it reads, including screenshots, to
its AI provider**, such as Anthropic for Claude or OpenAI for Codex. Their
privacy terms apply to that data.

- Screenshots are shared with your blurs filled in, so the agent never sees
  what you hid. Agents can't delete blurs. Screenshot imports must come from
  outside the library; raw originals, Trash and snapshot files cannot be
  imported to bypass the blurs. Replacing a screenshot keeps its blurs,
  including those added by Find private details.
- An agent reads a file outside your library only when it uses one as a
  screenshot or adds one to a brand profile, and only the file it names.
- Agents never get the text you typed while recording, field values, or the
  text StepForge read from the screen.
- Turning off **Let AI agents edit your guides** cuts off every connected
  agent at its next request. No restart is needed.

The [privacy policy](PRIVACY.md#optional-ai-agents) has the full details.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| The agent says StepForge has agent access turned off | Turn on **Settings → AI → Let AI agents edit your guides** and save. |
| The agent says it can't edit brand profiles | Turn on **Settings → AI → Let AI agents edit brand profiles** and save. |
| The agent can't find StepForge's tools | Run the setup command again, then restart the agent. In Claude Code, `claude mcp list` shows whether `stepforge` is connected. |
| The agent can't see screenshots | Turn on **Agents can see screenshots**, and use a model that can read images. |
| The guide on screen didn't change | Close and reopen the guide. Changes appear within a couple of seconds when the guide is open. |
| You moved or reinstalled StepForge | Copy the setup command again: it contains StepForge's location. |
