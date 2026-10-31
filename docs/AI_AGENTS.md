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
new ones for values that repeat, such as a course code or product name.

If the guide is open in StepForge, it updates on screen within a couple of
seconds. If you and the agent change the same thing at the same moment, your
edit wins.

Read what the agent wrote before you share the guide.

## What an agent can and can't do

An agent can:

- list and read your guides, and see each step's screenshot with your blurs
  already filled in
- create guides, and move them to the Trash
- add, delete, reorder, and nest steps
- rewrite the guide's and each step's title, description, and blocks (notes,
  warnings, tips, and code)
- replace a step's screenshot with a PNG file you point it to, or remove it
- add guide and global placeholders
- draw on screenshots (shapes, arrows, text, callouts, numbered badges, blurs,
  highlights, magnifiers, and cursors), and delete annotations other than
  blurs
- if you allow it, set up your
  [brand profiles](BRANDING.md#let-an-ai-agent-set-up-your-brand)

An agent can't:

- delete blurs, or see what they hide
- change or delete a placeholder you already have
- delete a brand profile
- read files outside your StepForge library, except one you ask it to use as
  a screenshot, logo, or font

StepForge doesn't ask before each change: turning on agent access allows
everything above.

## Undoing what an agent did

Before an agent deletes, moves, or adds a step, replaces or removes a
screenshot, or deletes blocks or annotations, StepForge saves a snapshot of the
guide. Each one is named for what the agent was about to do, such as "before
agent deletes step 3".

To undo a change, open the guide, choose **More → Backups & snapshots**, and
**Restore** the snapshot from just before it. Restoring snapshots the guide
first, so a restore can be undone too.

Rewriting text, changing substeps, adding placeholders, and drawing
annotations don't make a snapshot. If you want a way back before those, create
a snapshot yourself first. Annotations an agent drew can be moved or deleted
like your own.

A guide an agent deletes goes to the Trash, like one you delete. If you have
it open at the time, StepForge takes you back to the library.

## Privacy

StepForge itself sends nothing anywhere. It hands your guides to the agent on
your computer, and **the agent sends what it reads, including screenshots, to
its AI provider**, such as Anthropic for Claude or OpenAI for Codex. Their
privacy terms apply to that data.

- Screenshots are shared with your blurs filled in, so the agent never sees
  what you hid. Replacing a screenshot keeps its blurs, and an agent can't
  swap in an unblurred copy from your library.
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
