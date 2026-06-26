# Getting Started With AI

StepForge keeps AI local. It talks to your own Ollama server on your machine and does not send guide content to the cloud.

## 1. Install Ollama

Install Ollama from https://ollama.com and make sure the service is running.

On most systems you can verify it with:

```bash
ollama --version
```

## 2. Pull a lightweight model

The recommended default is:

```bash
ollama pull llama3.2:1b
```

That model is small enough to feel responsive on modest hardware, but still good enough for human-sounding titles and short text blocks.

If you want StepForge to send the screenshot itself to the model, pull a vision-capable model instead:

```bash
ollama pull llama3.2-vision
```

That model can inspect pictures as well as text, so it is better when you want the AI to read the UI directly from the screenshot.

If you need something even smaller, try:

```bash
ollama pull qwen3:0.6b
```

or:

```bash
ollama pull gemma3:270m
```

Those are lighter, but they are usually weaker at writing polished step text.

## 3. Open StepForge settings

In StepForge, open `Settings` and find the `AI` section.

Set:

* `Enable AI text filling` to on
* `Ollama host` to your local Ollama server
* `Ollama model` to `llama3.2:1b` for text-only mode, or `llama3.2-vision` if you want screenshot-aware AI

The default host is:

```text
http://127.0.0.1:11434
```

## 4. Test the connection

Use the `Test connection` button in the AI settings section.

If the model is installed, StepForge should confirm the host and model.

## 5. Use AI manually

AI is never automatic. After capture, use the `AI` button next to:

* the step title
* the step description
* each text, code, and table block

You can also use `More -> Generate all text fields with AI` to fill the whole step in one pass.

## Notes

* Capture titles are still generated automatically without AI.
* AI generation only works when `Enable AI text filling` is turned on.
* The app always uses local OCR around the click area first, then local AI only when you ask for it.
* When the selected Ollama model supports vision, StepForge also sends the screenshot to the model so it can cross-check OCR and visual context.
