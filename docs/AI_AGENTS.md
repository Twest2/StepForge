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
| List and read your guides | Create or delete guides or steps |
| See each step's screenshot, with your blurs already filled in | Reorder steps |
| Rewrite a guide's title and description | Change or delete screenshots |
| Rewrite each step's title, description, and blocks, and add notes, warnings, tips, and code | Delete blocks, annotations, or placeholders |
| Make a step a substep of an earlier step | Change a placeholder you already have |
| Add guide and global placeholders, and use them as `[[Name]]` | Read anything outside your StepForge library |
| Draw on screenshots: rectangles, ovals, lines, arrows, text, callouts, numbered badges, blurs, highlights, magnifiers, and cursors | |

Every step comes from a real capture, so an agent works around your
screenshots: it writes the text, organizes the steps, and adds annotations on
top, but the screenshots themselves never change.

## 1. Turn on agent access

1. Open **Settings → AI**.
2. Under **AI agents (Claude, Codex)**, turn on **Let AI agents edit your
   guides**.
3. **Save.**

Leave **Agents can see screenshots** on so the agent can see what you clicked.
Turn it off to share step text only.

## 2. Connect your agent

Use the setup shown in **Settings → AI → AI agents**. It's made for this
computer, with StepForge's exact location. Choose **Copy** next to the agent
you use, then:

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
new ones for values that repeat, such as a course code or product name. If the guide is open in StepForge, it updates on screen within a couple
of seconds. If you're typing in the same step at that moment, your edit wins.

Before you share the guide, read what the agent wrote. To undo a big rewrite,
use **More → Backups & snapshots**. Annotations an agent drew can be moved or
deleted like your own.

## Privacy

StepForge itself sends nothing anywhere. It hands your guides to the agent on
your computer, and **the agent sends what it reads, including screenshots, to
its AI provider**, such as Anthropic for Claude or OpenAI for Codex. Their
privacy terms apply to that data.

- Screenshots are shared with your blurs filled in, so the agent never sees
  what you hid.
- Agents never get the text you typed while recording, field values, or the
  text StepForge read from the screen.
- Turning off **Let AI agents edit your guides** cuts off every connected
  agent at its next request. No restart is needed.

The [privacy policy](PRIVACY.md#optional-ai-agents) has the full details.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| The agent says StepForge has agent access turned off | Turn on **Settings → AI → Let AI agents edit your guides** and save. |
| The agent can't find StepForge's tools | Run the setup command again, then restart the agent. In Claude Code, `claude mcp list` shows whether `stepforge` is connected. |
| The agent can't see screenshots | Turn on **Agents can see screenshots**, and use a model that can read images. |
| The guide on screen didn't change | Close and reopen the guide. Changes appear within a couple of seconds when the guide is open. |
| You moved or reinstalled StepForge | Copy the setup command again: it contains StepForge's location. |
