'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  buildCaptureTitle,
  normalizeOllamaHost,
  normalizeAiPatch,
  buildAiPrompt,
  applyAiPatchToStep,
  displayText,
  normalizeWhitespace,
} = require('../core/text-intel');

const OCR_CROP = {
  width: 420,
  height: 220,
};

function hasBinary(name) {
  try {
    execFileSync('which', [name], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

let createWorkerImpl = null;
function loadCreateWorker() {
  if (createWorkerImpl) return createWorkerImpl;
  // OCR is optional at startup; lazy-load it so the app can still boot when
  // the dependency has not been installed yet.
  // eslint-disable-next-line global-require
  ({ createWorker: createWorkerImpl } = require('tesseract.js'));
  return createWorkerImpl;
}

class TextIntelService {
  constructor({
    store,
    settings,
    getWindow = () => null,
    dataDir,
    fetchImpl = global.fetch,
    screenApi = null,
  }) {
    this.store = store;
    this.settings = settings;
    this.getWindow = getWindow;
    this.dataDir = dataDir;
    this.fetch = fetchImpl;
    this.screen = screenApi;
    this.worker = null;
    this.workerPromise = null;
    this.workerQueue = Promise.resolve();
    this.ocrDataDir = path.join(dataDir, 'ocr', 'eng');
  }

  async shutdown() {
    if (this.worker) {
      try {
        await this.worker.terminate();
      } catch {
        // best effort
      }
      this.worker = null;
      this.workerPromise = null;
    }
  }

  ensureLangData() {
    const packageDir = path.dirname(require.resolve('@tesseract.js-data/eng/package.json'));
    const source = path.join(packageDir, '4.0.0_best_int', 'eng.traineddata.gz');
    const targetDir = this.ocrDataDir;
    const target = path.join(targetDir, 'eng.traineddata.gz');
    if (!fs.existsSync(target)) {
      fs.mkdirSync(targetDir, { recursive: true });
      fs.copyFileSync(source, target);
    }
    return targetDir;
  }

  async getWorker() {
    if (this.workerPromise) return this.workerPromise;
    this.workerPromise = (async () => {
      const workerFactory = loadCreateWorker();
      const langPath = this.ensureLangData();
      const worker = await workerFactory('eng', 1, {
        langPath,
      });
      await worker.setParameters({
        preserve_interword_spaces: '1',
      });
      this.worker = worker;
      return worker;
    })();
    this.workerPromise.catch(() => {
      this.workerPromise = null;
    });
    return this.workerPromise;
  }

  async recognizeCrop(image, rect = null) {
    const worker = await this.getWorker();
    const cropped = rect ? image.crop(rect) : image;
    const buffer = cropped.toPNG();
    const result = await worker.recognize(buffer);
    const text = String(result?.data?.text || '').trim();
    return {
      text,
      confidence: Number.isFinite(result?.data?.confidence) ? result.data.confidence : null,
      raw: result,
    };
  }

  cropRectForPoint(frame, clickPos, { width = OCR_CROP.width, height = OCR_CROP.height } = {}) {
    if (!frame || !frame.size) return null;
    const bounds = frame.display.bounds || { x: 0, y: 0, width: frame.size.width, height: frame.size.height };
    const scaleX = frame.size.width / bounds.width;
    const scaleY = frame.size.height / bounds.height;
    const point = clickPos || {
      x: bounds.x + bounds.width / 2,
      y: bounds.y + bounds.height / 2,
    };
    const centerX = (point.x - bounds.x) * scaleX;
    const centerY = (point.y - bounds.y) * scaleY;
    const rectW = Math.max(1, Math.round(width * scaleX));
    const rectH = Math.max(1, Math.round(height * scaleY));
    const rect = {
      x: Math.round(centerX - rectW / 2),
      y: Math.round(centerY - rectH / 2),
      width: rectW,
      height: rectH,
    };
    rect.x = clamp(rect.x, 0, Math.max(0, frame.size.width - rect.width));
    rect.y = clamp(rect.y, 0, Math.max(0, frame.size.height - rect.height));
    rect.width = clamp(rect.width, 1, frame.size.width);
    rect.height = clamp(rect.height, 1, frame.size.height);
    return rect;
  }

  async ocrAroundClick(frame, clickPos) {
    if (!frame || !frame.image) return { text: '', confidence: null };
    const rect = this.cropRectForPoint(frame, clickPos);
    try {
      return await this.recognizeCrop(frame.image, rect);
    } catch {
      return { text: '', confidence: null };
    }
  }

  async collectForegroundWindowContext(osPoint = null) {
    try {
      if (process.platform === 'win32') return this.collectWindowsWindowContext(osPoint);
      if (process.platform === 'darwin') return this.collectMacWindowContext();
      if (process.platform === 'linux') return this.collectLinuxWindowContext();
    } catch {
      // best effort only
    }
    return { appName: '', windowTitle: '' };
  }

  collectWindowsWindowContext(osPoint = null) {
    const hasPoint = osPoint && Number.isFinite(osPoint.x) && Number.isFinite(osPoint.y);
    const clickX = hasPoint ? Number(osPoint.x) : 0;
    const clickY = hasPoint ? Number(osPoint.y) : 0;
    const script = `
      $clickX = ${clickX};
      $clickY = ${clickY};
      $elementLabel = '';
      $elementRole = '';
      $elementClass = '';
      $elementProcessId = 0;
      if (${hasPoint ? '$true' : '$false'}) {
        try {
          Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,WindowsBase | Out-Null
          $point = New-Object System.Windows.Point($clickX, $clickY);
          $element = [System.Windows.Automation.AutomationElement]::FromPoint($point);
          if ($element) {
            $current = $element.Current;
            $elementLabel = $current.Name;
            $elementRole = $current.LocalizedControlType;
            $elementClass = $current.ClassName;
            $elementProcessId = $current.ProcessId;
          }
        } catch { }
      }
      Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class Win32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@;
      $hWnd = [Win32]::GetForegroundWindow();
      $sb = New-Object System.Text.StringBuilder 512;
      [void][Win32]::GetWindowText($hWnd, $sb, $sb.Capacity);
      $pid = 0;
      [void][Win32]::GetWindowThreadProcessId($hWnd, [ref]$pid);
      $proc = Get-Process -Id $pid -ErrorAction SilentlyContinue | Select-Object -First 1;
      $out = [ordered]@{
        appName = if ($proc) { $proc.ProcessName } else { '' };
        windowTitle = $sb.ToString();
        elementLabel = $elementLabel;
        elementRole = $elementRole;
        elementClass = $elementClass;
        elementProcessId = $elementProcessId;
        pid = $pid;
      };
      $out | ConvertTo-Json -Compress;
    `;
    const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 1200,
    }).trim();
    return JSON.parse(result || '{}');
  }

  collectMacWindowContext() {
    const script = `
      set appName to ""
      set windowTitle to ""
      tell application "System Events"
        try
          set frontApp to first application process whose frontmost is true
          set appName to name of frontApp
          try
            set windowTitle to name of front window of frontApp
          end try
        end try
      end tell
      return appName & linefeed & windowTitle
    `;
    const result = execFileSync('osascript', ['-e', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 1200,
    }).trimEnd();
    const [appName = '', windowTitle = ''] = result.split(/\r?\n/);
    return { appName, windowTitle };
  }

  collectLinuxWindowContext() {
    if (!hasBinary('xprop')) return { appName: '', windowTitle: '' };
    const active = execFileSync('xprop', ['-root', '_NET_ACTIVE_WINDOW'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 1200,
    });
    const activeMatch = active.match(/window id # (0x[0-9a-fA-F]+)/);
    if (!activeMatch) return { appName: '', windowTitle: '' };
    const winId = activeMatch[1];
    const details = execFileSync('xprop', ['-id', winId, '_NET_WM_NAME', 'WM_NAME', 'WM_CLASS'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 1200,
    });
    const titleMatch = details.match(/(?:_NET_WM_NAME\(UTF8_STRING\)|WM_NAME\(STRING\)|WM_NAME\(UTF8_STRING\)) = "([^"]*)"/);
    const classMatch = details.match(/WM_CLASS\(STRING\) = "([^"]*)"(?:, "([^"]*)")?/);
    return {
      appName: classMatch ? (classMatch[2] || classMatch[1] || '') : '',
      windowTitle: titleMatch ? titleMatch[1] : '',
    };
  }

  async buildCaptureTitle({ mode, frame, clickPos, clickMeta = null }) {
    const ctx = await this.buildCaptureContext({ mode, frame, clickPos, clickMeta });
    return ctx.title;
  }

  async buildCaptureContext({ mode, frame, clickPos, clickMeta = null }) {
    const [metadata, ocr] = await Promise.all([
      this.collectForegroundWindowContext(clickMeta?.osPoint || null),
      this.ocrAroundClick(frame, clickPos),
    ]);
    const title = buildCaptureTitle({ mode, metadata, ocrText: ocr.text });
    return {
      title,
      captureMetadata: {
        ocrText: ocr.text || '',
        windowTitle: metadata.windowTitle || '',
        appName: metadata.appName || '',
        elementLabel: metadata.elementLabel || '',
        elementRole: metadata.elementRole || '',
        mode,
      },
    };
  }

  aiEnabled() {
    return Boolean(this.settings.get('ai.enabled'));
  }

  aiConfig(override = null) {
    const stored = this.settings.get('ai') || {};
    const merged = override ? {
      ...stored,
      ...override,
      ollama: {
        ...(stored.ollama || {}),
        ...(override.ollama || {}),
      },
    } : stored;
    return {
      ...merged,
      enabled: override && Object.prototype.hasOwnProperty.call(override, 'enabled')
        ? Boolean(override.enabled)
        : Boolean(stored.enabled),
      ollama: {
        host: normalizeOllamaHost(merged.ollama?.host || ''),
        model: normalizeWhitespace(merged.ollama?.model || ''),
      },
    };
  }

  async testAiConnection(override = null) {
    const config = this.aiConfig(override);
    if (!config.ollama.host) {
      return { ok: false, reason: 'Set an Ollama host first.' };
    }
    const tagsUrl = new URL('/api/tags', `${config.ollama.host.replace(/\/+$/, '')}/`);
    const res = await this.fetch(tagsUrl, { method: 'GET' });
    if (!res.ok) {
      return { ok: false, reason: `Ollama check failed (${res.status})` };
    }
    const data = await res.json();
    const models = Array.isArray(data?.models) ? data.models.map((model) => model.name).filter(Boolean) : [];
    const installed = config.ollama.model ? models.includes(config.ollama.model) : false;
    return {
      ok: true,
      installed,
      models,
      host: config.ollama.host,
      model: config.ollama.model,
    };
  }

  async callOllamaText({ host, model, prompt, systemPrompt }) {
    const url = new URL('/api/chat', `${host.replace(/\/+$/, '')}/`);
    const response = await this.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        options: { temperature: 0.4 },
      }),
    });
    if (!response.ok) throw new Error(`Ollama request failed (${response.status})`);
    const payload = await response.json();
    const content = payload?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('Ollama returned an empty response');
    return content.trim();
  }

  async callOllama({ host, model, prompt, systemPrompt }) {
    const url = new URL('/api/chat', `${host.replace(/\/+$/, '')}/`);
    const response = await this.fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        format: 'json',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        options: {
          temperature: 0.2,
        },
      }),
    });
    if (!response.ok) {
      throw new Error(`Ollama request failed (${response.status})`);
    }
    const payload = await response.json();
    const content = payload?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('Ollama returned an empty response');
    }
    return content;
  }

  async generateStepPatch({
    guideId,
    stepId,
    target = 'all',
    blockId = null,
  }) {
    try {
      const config = this.aiConfig();
      if (!config.enabled) {
        return { ok: false, reason: 'Enable AI in settings first.' };
      }
      if (!config.ollama.host || !config.ollama.model) {
        return { ok: false, reason: 'Configure Ollama host and model in Settings.' };
      }

      const guide = this.store.getGuide(guideId);
      const step = this.store.getStep(guideId, stepId);
      if (!guide || !step) {
        return { ok: false, reason: 'Guide or step not found.' };
      }

      const currentBlock = blockId
        ? [...(step.textBlocks || []), ...(step.codeBlocks || []), ...(step.tableBlocks || [])].find((b) => b.id === blockId) || null
        : null;
      if (blockId && target === 'block' && !currentBlock) {
        return { ok: false, reason: 'Block not found.' };
      }

      let captureContext = null;
      // Use stored capture metadata when available (best context, from capture time).
      // Fall back to re-running OCR on the stored image only when metadata is absent.
      if (step.captureMetadata) {
        captureContext = {
          ...step.captureMetadata,
          titleCandidate: buildCaptureTitle({
            mode: step.captureMetadata.mode || 'fullscreen',
            metadata: {
              windowTitle: step.captureMetadata.windowTitle,
              appName: step.captureMetadata.appName,
              elementLabel: step.captureMetadata.elementLabel,
              elementRole: step.captureMetadata.elementRole,
            },
            ocrText: step.captureMetadata.ocrText,
          }),
        };
      } else if (step.image) {
        const imagePath = this.store.stepImagePath(guideId, stepId, 'working') || this.store.stepImagePath(guideId, stepId, 'original');
        if (imagePath && fs.existsSync(imagePath)) {
          const { nativeImage } = require('electron');
          const image = nativeImage.createFromPath(imagePath);
          if (!image.isEmpty()) {
            const clickPoint = this.clickPointFromStep(step, image);
            const [metadata, ocr] = await Promise.all([
              this.collectForegroundWindowContext(),
              this.ocrAroundClick({ image, size: image.getSize(), display: { bounds: { x: 0, y: 0, width: image.getSize().width, height: image.getSize().height } } }, clickPoint),
            ]);
            const titleCandidate = buildCaptureTitle({
              mode: step.kind === 'image' ? 'fullscreen' : 'window',
              metadata,
              ocrText: ocr.text,
            });
            captureContext = {
              ...metadata,
              ocrText: ocr.text,
              titleCandidate,
              mode: step.kind === 'image' ? 'fullscreen' : 'content',
            };
          }
        }
      }

      const { systemPrompt, prompt } = buildAiPrompt({
        target,
        guide,
        step,
        captureContext,
        block: currentBlock,
      });

      const raw = await this.callOllama({
        host: config.ollama.host,
        model: config.ollama.model,
        prompt,
        systemPrompt,
      });
      const patch = normalizeAiPatch(raw);
      const updated = applyAiPatchToStep(step, patch, { target, blockId });
      const saved = this.store.saveStep(guideId, updated);
      return { ok: true, step: saved, patch };
    } catch (err) {
      return { ok: false, reason: err && err.message ? err.message : 'AI generation failed.' };
    }
  }

  async rewriteText({ text, guideTitle = '', stepTitle = '' }) {
    try {
      const config = this.aiConfig();
      if (!config.enabled) return { ok: false, reason: 'Enable AI in settings first.' };
      if (!config.ollama.host || !config.ollama.model) {
        return { ok: false, reason: 'Configure Ollama host and model in Settings.' };
      }
      const trimmed = normalizeWhitespace(text);
      if (!trimmed) return { ok: false, reason: 'No text to rewrite.' };

      const contextHint = [
        guideTitle ? `Guide: ${guideTitle}` : '',
        stepTitle ? `Step: ${stepTitle}` : '',
      ].filter(Boolean).join('\n');

      const prompt = [
        contextHint,
        contextHint ? '' : null,
        'Rewrite the following text to sound professional and clear as step-by-step documentation.',
        'Keep it concise. Do not add extra information. Return only the rewritten text.',
        '',
        trimmed,
      ].filter((l) => l !== null).join('\n');

      const result = await this.callOllamaText({
        host: config.ollama.host,
        model: config.ollama.model,
        prompt,
        systemPrompt: 'You are a documentation editor. Return only the improved text, nothing else.',
      });
      return { ok: true, text: result };
    } catch (err) {
      return { ok: false, reason: err?.message || 'Rewrite failed.' };
    }
  }

  clickPointFromStep(step, image = null) {
    const marker = (step.annotations || []).find((ann) => ann.type === 'oval' && Number.isFinite(ann.x) && Number.isFinite(ann.y) && Number.isFinite(ann.w) && Number.isFinite(ann.h));
    if (!marker) return null;
    const size = image ? image.getSize() : step.image?.size || { width: 0, height: 0 };
    if (!size.width || !size.height) return null;
    return {
      x: Math.round((marker.x + marker.w / 2) * size.width),
      y: Math.round((marker.y + marker.h / 2) * size.height),
    };
  }
}

module.exports = { TextIntelService };
