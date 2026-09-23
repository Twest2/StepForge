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
   the model is installed.
6. **Save.**

## 4. Generate text

**On demand.** Each step's title, description, and content blocks have an
**AI** button. To fill in everything for the current step at once, choose
**More → Generate all text fields with AI**.

**Automatically.** Turn on **Settings → AI → Auto-document captures** and
StepForge describes each new step in the background as you record.

Requests can take a few seconds on slower hardware. Closing the guide cancels
any that are still running.

## Privacy

- StepForge only talks to Ollama on **this computer** (`127.0.0.1` or
  `localhost`) and refuses any other address by default.
- What's sent: the step screenshot (vision models only), the step text, and
  the capture details StepForge recorded, such as the window title and the
  text near your click.

**Running Ollama on another machine?** Add `"allowRemoteHost": true` to the
`ai` section of `settings/app-settings.json` in your
[data folder](GETTING_STARTED.md#troubleshooting), then set **Host** to that
machine's address. Only do this for a host you trust: your screenshots and
text are sent to it, and StepForge can't control what it does with them. To
keep requests text-only even with a vision model, set `"attachScreenshots": false`
in the same section.

The [privacy policy](PRIVACY.md#optional-ai) has the full details.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Test connection can't reach Ollama | Make sure Ollama is running (`ollama list` should respond) and the host is correct. |
| Model not found | Run `ollama list` and copy the model name exactly, including any tag like `:1b`. |
| No AI buttons in the editor | Turn on **Settings → AI → Enable AI** and save. |
| Descriptions are vague | Try a vision model such as `gemma3`, or a larger model if your computer can handle it. |
