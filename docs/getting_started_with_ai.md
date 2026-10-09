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

Choose one to start with. You can switch at any time.

| Model | Download | Why pick it |
| --- | --- | --- |
| **Gemma 3** (recommended) | `ollama pull gemma3` | Can *see* screenshots, so it describes what's actually on screen |
| **Llama 3.2 1B** | `ollama pull llama3.2:1b` | Small and quick on modest hardware; works from text only |
| **Qwen 3 0.6B** | `ollama pull qwen3:0.6b` | Even lighter, with simpler writing |

Models that can read images (such as Gemma 3, LLaVA, and Llama 3.2 Vision)
are detected automatically, and StepForge includes the screenshot in its
request. Text-only models get the step's title, the text read around your
click, and the window it happened in.

## 3. Connect StepForge

1. Open **Settings → AI**.
2. Turn on **Enable AI**.
3. Leave **Host** as `http://127.0.0.1:11434` unless you changed Ollama's
   address.
4. Set **Model** to the model you downloaded, for example `gemma3`.
5. Choose **Test connection**. StepForge confirms it can reach Ollama and that
   the model is installed. If it isn't, StepForge lists the models you do
   have, and the **Model** box suggests them as you type.
6. **Save.**

## 4. Let AI write your guide

Open a guide and choose **AI ▾** in the toolbar, next to **More ▾**:

| Choose | AI writes |
| --- | --- |
| **Write the whole guide** | The title, description, and blocks of every step, then the guide's own title and description. |
| **Write the whole step** | The selected step's title, description, and blocks. |
| **Write the title** | The selected step's title. |
| **Write the description** | The selected step's description. |
| **Write the blocks** | The selected step's notes, warnings, tips, and code. It rewrites the blocks you have and adds at most two new ones when the step needs them. |

- **Your writing is kept.** If you already wrote a title or description, AI
  polishes your wording instead of replacing it with something new. It never
  deletes a block.
- **You can undo a whole-guide run.** Before writing the whole guide,
  StepForge saves a snapshot. To undo, choose **More → Backups & snapshots**
  and restore the snapshot labeled **before AI**.
- **Placeholders stay put.** A paragraph that holds only a placeholder, such
  as `[[stepforge]]`, stays exactly where you put it.
- **You can stop at any time.** While AI is writing, the button shows its
  progress, such as **AI · 3/12**. Choose it, then **Stop writing**.

**While you record.** Turn on **Settings → AI → Auto-document captures** and
StepForge writes a title and description for each new step in the
background.

Requests take a few seconds per step, longer on slower hardware. Closing the
guide stops any request that's still running.

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
| Descriptions are vague | Try a vision model such as `gemma3`, or a larger model if your computer can handle it. |
