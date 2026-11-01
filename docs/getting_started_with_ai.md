# AI-written guides with Ollama

StepForge can write your guides for you, a whole guide, one step, or a single
field, using an AI model that runs **on your own computer** through
[Ollama](https://ollama.com). Your screenshots and text never go to a cloud AI
service.

Prefer Claude or Codex? They can write your guides too: see
[Let Claude or Codex write your guides](AI_AGENTS.md).

AI is optional and **off by default**. StepForge already titles steps without
it, using on-device text recognition. AI adds fuller, more natural
descriptions on top.

> [!NOTE]
> AI can get things wrong. Always read what it writes before you share a
> guide.

## 1. Install Ollama

Download and install Ollama from [ollama.com](https://ollama.com/download),
then check that it's running:

```bash
ollama --version
```

Already have Ollama? Update it to the latest version first. Newer models need
a recent Ollama: Gemma 4 needs version 0.30.9 or newer, and an older Ollama
fails with "unable to load model".

## 2. Download a model

Pick one from [Recommended models](#recommended-models) and download it, for
example:

```bash
ollama pull gemma4:e4b
```

You can switch models at any time.

## 3. Connect StepForge

1. Open **Settings → AI**.
2. Turn on **Enable AI**.
3. Leave **Host** as `http://127.0.0.1:11434` unless you changed Ollama's
   address.
4. Set **Model** to the model you downloaded, for example `gemma4:e4b`.
5. Choose **Test connection**. StepForge confirms it can reach Ollama and that
   the model is installed. If it isn't, StepForge lists the models you do
   have, and the **Model** box suggests them as you type.
6. **Save.**

## 4. Let AI write your guide

Open a guide and choose **AI ▾** in the toolbar, next to **More ▾**:

| Choose | AI writes |
| --- | --- |
| **Write the whole guide** | Every step's title, description, and blocks, then the guide's own title and description. It can also group steps into substeps and add placeholders for repeated values. |
| **Write the whole step** | The selected step's title, description, and blocks. |
| **Write the title** | The selected step's title. |
| **Write the description** | The selected step's description. |
| **Write the blocks** | The selected step's notes, warnings, tips, and code. It rewrites the blocks you have and may add up to two more. |

- **Your writing is kept.** If you already wrote a title or description, AI
  polishes your wording instead of replacing it. It never deletes a block.
- **You can undo it.** After AI writes one step, press **Ctrl+Z**. Before it
  writes the whole guide, StepForge saves a snapshot: to undo, open
  **More → Backups & snapshots** and restore the one labeled **before AI**.
  Global placeholders it added stay in **Settings → Placeholders**.
- **It uses your placeholders.** Where a placeholder's value would appear in a
  description or block, AI writes `[[name]]` instead. Step titles keep plain
  words.
- **It can add placeholders and substeps** when it writes the whole guide: up
  to three placeholders for values that repeat, such as a product name or web
  address, and one level of substeps for clicks that belong together. It never
  reorders your steps or changes a placeholder you already have.
- **You can stop at any time.** While AI is writing, the button shows its
  progress, such as **AI · 3/12**. Choose it, then **Stop writing**.

**While you record.** Turn on **Settings → AI → Auto-document captures** and
StepForge writes a title and description for each new step in the
background.

Requests take a few seconds per step, longer on slower hardware. Closing the
guide stops any request that's still running.

**Brand CSS.** With AI on, **Settings → Branding → Manage → Advanced CSS** also
has **Write with AI…**: describe a change to how your HTML exports look, and
the model writes the CSS for you to review. See
[Write CSS with AI](BRANDING.md#write-css-with-ai).

## Recommended models

All of these are small enough for an ordinary computer. A model runs fastest
when its download fits in your graphics card's memory (VRAM); without a
graphics card, stick to models under about 3 GB.

### Models that can read screenshots

These see each step's screenshot, with your blurs already filled in, so they
describe what's actually on screen. Start here if your computer can run them.

| Model | Download | Size | Good for |
| --- | --- | --- | --- |
| **Gemma 4 E4B** (start here) | `ollama pull gemma4:e4b` | 6.6 GB | The best all-round choice, with a graphics card that has 8 GB or more |
| **Gemma 4 E2B** | `ollama pull gemma4:e2b` | 4.6 GB | Gemma 4 on a computer with less graphics memory |
| **Gemma 4 12B** | `ollama pull gemma4:12b` | 8.0 GB | The most natural writing, with a graphics card that has 12 GB or more |
| **Gemma 3 4B** | `ollama pull gemma3:4b` | 3.4 GB | A lighter choice for modest computers |
| **Qwen3-VL 2B** | `ollama pull qwen3-vl:2b` | 1.9 GB | The smallest model that reads screenshots well |
| **Qwen3-VL 4B** | `ollama pull qwen3-vl:4b` | 3.3 GB | Reading small text and buttons in busy screenshots |
| **Qwen2.5-VL 3B** | `ollama pull qwen2.5vl:3b` | 3.2 GB | An alternative if Qwen3-VL is slow on your computer |
| **Granite 3.2 Vision 2B** | `ollama pull granite3.2-vision:2b` | 2.4 GB | Forms, tables, and document-style screens |

### Text-only models

These don't see screenshots. They write from the step's title, the window it
happened in, and the text read around your click, so their descriptions are
less specific. Choose one when your computer is too slow for the models above.

| Model | Download | Size | Good for |
| --- | --- | --- | --- |
| **Llama 3.2 3B** (start here) | `ollama pull llama3.2:3b` | 2.0 GB | Clear writing on modest hardware |
| **Phi-4 Mini** | `ollama pull phi4-mini` | 2.5 GB | Careful, accurate wording |
| **Llama 3.2 1B** | `ollama pull llama3.2:1b` | 1.3 GB | Older or slower computers |
| **Gemma 3 1B** | `ollama pull gemma3:1b` | 0.8 GB | The smallest and fastest, with simpler writing |

Gemma 4 has no text-only version: even its smallest model reads screenshots.

StepForge asks Ollama whether a model can read images, so any model that can
is used with screenshots automatically. Sizes are Ollama's downloads as of
October 2026; newer models appear in the
[Ollama library](https://ollama.com/library).

## Privacy

- StepForge only talks to Ollama on **this computer** (`127.0.0.1` or
  `localhost`) and refuses any other address by default.
- What's sent: the step screenshot (vision models only), the step text, and
  the capture details StepForge recorded, such as the window title and the
  text near your click. For **Write with AI** in a brand profile: your
  description, the brand colors and fonts, and the profile's CSS.
- Screenshots are sent with your blurs already filled in, so the model never
  sees what you hid. For steps with blurs, the text near your click isn't
  sent either.
- To keep requests text-only even with a vision model, turn off
  **Settings → AI → Let the model see screenshots**.

**Running Ollama on another machine?** Add `"allowRemoteHost": true` to the
`ai` section of `settings/app-settings.json` in your
[data folder](GETTING_STARTED.md#troubleshooting), then set **Host** to that
machine's address. Only do this for a host you trust: your screenshots and
text are sent to it, and StepForge can't control what it does with them.

The [privacy policy](PRIVACY.md#optional-ai) has the full details.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Test connection can't reach Ollama | Make sure Ollama is running (`ollama list` should respond) and the host is correct. |
| "unable to load model" | Update Ollama to the latest version. Gemma 4 needs 0.30.9 or newer, and Gemma 3 needs 0.30.0 or newer. |
| Model not found | Run `ollama list` and copy the model name exactly, including any tag like `:1b`. |
| The AI ▾ menu items are greyed out | Turn on **Settings → AI → Enable AI** and save, then select a step for the step actions. |
| Descriptions are vague | Try a model that reads screenshots from [Recommended models](#recommended-models), or a larger one if your computer can handle it. |
