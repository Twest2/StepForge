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
| See each step's screenshot, with your blurs already filled in | Change screenshots, blurs, or annotations |
| Rewrite a guide's title and description | Delete blocks |
| Rewrite each step's title, description, and blocks, and add notes, warnings, tips, and code | Read anything outside your StepForge library |

Every step comes from a real capture, so an agent works on the text around
your screenshots, not the screenshots themselves.

## 1. Turn on agent access

1. Open **Settings → AI**.
2. Under **AI agents (Claude, Codex)**, turn on **Let AI agents edit your
   guides**.
3. **Save.**

Leave **Agents can see screenshots** on so the agent can see what you clicked.
Turn it off to share step text only.

## 2. Connect your agent

The same card shows the exact setup for this computer. Choose **Copy** next to
the one you use, then:

**Claude Code:** paste the command into a terminal and run it once. It looks
like this:

```bash
claude mcp add --scope user stepforge -- "C:\Users\you\AppData\Local\Programs\StepForge\StepForge.exe" --mcp
```

**Codex:** paste the command into a terminal and run it once:

```bash
codex mcp add stepforge -- "C:\Users\you\AppData\Local\Programs\StepForge\StepForge.exe" --mcp
```

**Claude Desktop, Cursor, and other MCP apps:** paste the JSON into the app's
MCP server settings. For Claude Desktop, that's **Settings → Developer → Edit
Config**, then restart Claude Desktop.

On Linux the command also includes `--ozone-platform=headless`, so StepForge
starts without a display, for example when the agent runs over SSH.

## 3. Ask it to write a guide

Record a guide in StepForge as usual, then ask your agent, for example:

> Write the StepForge guide "Untitled guide": give every step a clear title and
> description, add a warning where something can go wrong, and finish with a
> title and short introduction for the guide.

The agent finds the guide, looks at each step's screenshot, and rewrites the
text. If the guide is open in StepForge, it updates on screen within a couple
of seconds. If you're typing in the same step at that moment, your edit wins.

Before you share the guide, read what the agent wrote. To undo a big rewrite,
use **More → Backups & snapshots**.

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
