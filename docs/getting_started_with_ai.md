# AI-written steps with Ollama

StepForge can write step titles and descriptions for you using an AI model
that runs **on your own computer** through [Ollama](https://ollama.com). Your
screenshots and text never go to a cloud AI service.

AI is optional and **off by default**. StepForge already titles steps without
it, using on-device text recognition. AI adds fuller, more natural
descriptions on top.

> [!NOTE]
> AI support is in **beta**. Always read what it writes before you share a
> guide.

## 1. Install Ollama

Download and install Ollama from [ollama.com](https://ollama.com/download),
then check that it's running:

```bash
ollama --version
```

## 2. Download a model

Pick one from [Recommended models](#recommended-models) and download it, for
example:

```bash
ollama pull gemma3:4b
```

You can switch models at any time.

## 3. Connect StepForge

1. Open **Settings → AI**.
2. Turn on **Enable AI**.
3. Leave **Host** as `http://127.0.0.1:11434` unless you changed Ollama's
   address.
4. Set **Model** to the model you downloaded, for example `gemma3:4b`.
5. Choose **Test connection**. StepForge confirms it can reach Ollama and that
   the model is installed. If it isn't, StepForge lists the models you do
   have, and the **Model** box suggests them as you type.
6. **Save.**

## 4. Let AI write your guide

Open a guide and choose **AI ▾** in the toolbar, next to **More ▾**:

| Choose | AI writes |
| --- | --- |
| **Write the whole guide** | The title, description, and blocks of every step. Then it makes substeps where steps belong together and adds placeholders for values that repeat, and finally writes the guide's own title and description. |
| **Write the whole step** | The selected step's title, description, and blocks. |
| **Write the title** | The selected step's title. |
| **Write the description** | The selected step's description. |
| **Write the blocks** | The selected step's notes, warnings, tips, and code. It rewrites the blocks you have and adds at most two new ones when the step needs them. |

- **Your writing is kept.** If you already wrote a title or description, AI
  polishes your wording instead of replacing it with something new. It never
  deletes a block.
- **You can undo a whole-guide run.** Before writing the whole guide,
  StepForge saves a snapshot. To undo, choose **More → Backups & snapshots**
  and restore the snapshot labeled **before AI**. Global placeholders AI added
  live in **Settings → Placeholders** and stay after a restore.
- **AI uses your placeholders.** It sees your global placeholders and this
  guide's placeholders, and writes the `[[name]]` token wherever a
  placeholder's value would appear in a description or block. Titles keep
  plain words, so the step list stays readable. A paragraph that holds only a
  placeholder, such as `[[stepforge]]`, stays exactly where you put it.
- **AI can add placeholders.** When you write the whole guide, AI may add up to
  three placeholders for specific values that appear in two or more steps,
  such as a course code, product name, or web address. Most become guide
  placeholders (**More → Guide placeholders**); a value about your
  organization, such as its name, may become a global one
  (**Settings → Placeholders**). It never changes or removes a placeholder you
  already have.
- **AI can make substeps.** When you write the whole guide, AI may make a few
  steps substeps of the step that starts their task, such as the clicks inside
  a dialog that step opened. It never changes the order of your steps, and it
  only nests one level deep, like 3.1.
- **You can stop at any time.** While AI is writing, the button shows its
  progress, such as **AI · 3/12**. Choose it, then **Stop writing**.

**While you record.** Turn on **Settings → AI → Auto-document captures** and
StepForge writes a title and description for each new step in the
background.

Requests take a few seconds per step, longer on slower hardware. Closing the
guide stops any request that's still running.

## Recommended models

All of these are small enough for an ordinary computer. A model runs fastest
when its download fits in your graphics card's memory (VRAM); without a
graphics card, stick to models under about 3 GB.

### Models that can read screenshots

These see each step's screenshot, with your blurs already filled in, so they
describe what's actually on screen. Start here if your computer can run them.

| Model | Download | Size | Good for |
| --- | --- | --- | --- |
| **Gemma 3 4B** (start here) | `ollama pull gemma3:4b` | 3.4 GB | The best all-round choice for most computers |
| **Qwen3-VL 2B** | `ollama pull qwen3-vl:2b` | 1.9 GB | The smallest model that reads screenshots well |
| **Qwen3-VL 4B** | `ollama pull qwen3-vl:4b` | 3.3 GB | Reading small text and buttons in busy screenshots |
| **Qwen2.5-VL 3B** | `ollama pull qwen2.5vl:3b` | 3.2 GB | An alternative if Qwen3-VL is slow on your computer |
| **Granite 3.2 Vision 2B** | `ollama pull granite3.2-vision:2b` | 2.4 GB | Forms, tables, and document-style screens |
| **Gemma 3 12B** | `ollama pull gemma3:12b` | 8.2 GB | The most natural writing, with a graphics card that has 12 GB or more |

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

StepForge asks Ollama whether a model can read images, so any model that can
is used with screenshots automatically. Sizes are Ollama's downloads as of
October 2026; newer models appear in the
[Ollama library](https://ollama.com/library).

## Privacy

- StepForge only talks to Ollama on **this computer** (`127.0.0.1` or
  `localhost`) and refuses any other address by default.
- What's sent: the step screenshot (vision models only), the step text, and
  the capture details StepForge recorded, such as the window title and the
  text near your click.
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
| Model not found | Run `ollama list` and copy the model name exactly, including any tag like `:1b`. |
| The AI ▾ menu items are greyed out | Turn on **Settings → AI → Enable AI** and save, then select a step for the step actions. |
| Descriptions are vague | Try a model that reads screenshots from [Recommended models](#recommended-models), or a larger one if your computer can handle it. |
