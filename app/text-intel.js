'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  DEFAULT_CAPTURE_TITLES,
  buildCaptureTitle,
  normalizeOllamaHost,
  validateOllamaHost,
  normalizeAiPatch,
  buildAiPrompt,
  applyAiPatchToStep,
  displayText,
  normalizeWhitespace,
} = require('../core/text-intel');

const DEFAULT_TITLE_VALUES = new Set(Object.values(DEFAULT_CAPTURE_TITLES).concat(['Capture']));

const OCR_CROP = {
  width: 420,
  height: 220,
};

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function modelLooksVisionCapable(model) {
  const clean = normalizeWhitespace(model).toLowerCase();
  if (!clean) return false;
  return clean.includes('vision')
    || clean.includes('llava')
    || clean.includes('gemma4')
    || /(^|[^a-z0-9])qwen[23](?:\.[0-9]+)?vl([^a-z0-9]|$)/.test(clean);
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
    windowContextProvider = null,
  }) {
    this.store = store;
    this.settings = settings;
    this.getWindow = getWindow;
    this.dataDir = dataDir;
    this.fetch = fetchImpl;
    this.screen = screenApi;
    // OS-specific foreground-window/element detection is a platform adapter.
    // This code no longer branches on process.platform; the factory selects it.
    this.windowContext = windowContextProvider
      || require('./platform').createWindowContextProvider();
    this.worker = null;
    this.workerPromise = null;
    this.workerQueue = Promise.resolve();
    this.ocrDataDir = path.join(dataDir, 'ocr', 'eng');
    this.modelCapabilityCache = new Map();
    // In-flight AI request controllers, grouped by guide, so closing a guide
    // (or quitting) can cancel outstanding requests instead of leaving them
    // to resolve against stale data.
    this.inflight = new Set();
    // Bounded concurrency for AI network calls.
    this.maxConcurrent = 2;
    this.activeCount = 0;
    this.waitQueue = [];
  }

  aiNetworkOptions() {
    const ai = this.settings.get('ai') || {};
    const timeoutMs = Number.isFinite(ai.timeoutMs) && ai.timeoutMs > 0 ? ai.timeoutMs : 60000;
    const maxImageBytes = Number.isFinite(ai.maxImageBytes) && ai.maxImageBytes > 0
      ? ai.maxImageBytes
      : 12 * 1024 * 1024;
    return {
      allowRemote: Boolean(ai.allowRemoteHost),
      attachScreenshots: ai.attachScreenshots !== false,
      timeoutMs,
      maxImageBytes,
    };
  }

  // Resolve the endpoint against the local-first policy or throw a clear error.
  resolveHost(host) {
    const { allowRemote } = this.aiNetworkOptions();
    const result = validateOllamaHost(host, { allowRemote });
    if (!result.ok) {
      const err = new Error(result.reason);
      err.code = 'STEPFORGE_AI_HOST_BLOCKED';
      throw err;
    }
    return result.host;
  }

  // fetch with a hard deadline and cooperative cancellation. Every AI network
  // call goes through here so a dead endpoint can never hang the UI.
  async fetchJson(url, { method = 'GET', body = null, guideId = null } = {}) {
    const { timeoutMs } = this.aiNetworkOptions();
    const controller = new AbortController();
    if (guideId) controller._guideId = guideId;
    this.inflight.add(controller);
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    try {
      const res = await this.fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      return res;
    } catch (err) {
      if (controller.signal.aborted) {
        // The abort reason distinguishes an explicit cancel from a timeout.
        const reasonMsg = controller.signal.reason && controller.signal.reason.message;
        const cancelled = reasonMsg === 'cancelled';
        const wrapped = new Error(cancelled ? 'AI request cancelled.' : 'AI request timed out.');
        wrapped.code = 'STEPFORGE_AI_ABORTED';
        throw wrapped;
      }
      throw err;
    } finally {
      clearTimeout(timer);
      this.inflight.delete(controller);
    }
  }

  // Cancel in-flight AI requests, optionally scoped to one guide.
  cancelInflight(guideId = null) {
    for (const controller of [...this.inflight]) {
      if (!guideId || controller._guideId === guideId) {
        try { controller.abort(new Error('cancelled')); } catch { /* already settled */ }
        this.inflight.delete(controller);
      }
    }
  }

  // Bounded-concurrency gate for AI network work.
  async withConcurrency(fn) {
    if (this.activeCount >= this.maxConcurrent) {
      await new Promise((resolve) => this.waitQueue.push(resolve));
    }
    this.activeCount += 1;
    try {
      return await fn();
    } finally {
      this.activeCount -= 1;
      const next = this.waitQueue.shift();
      if (next) next();
    }
  }

  async shutdown() {
    this.cancelInflight();
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
    // Use a full-width horizontal strip at the click height. This preserves complete
    // link text (e.g. "Oracle | Cloud Applications and Cloud Platform") rather than
    // cropping through it when the element spans more than the 420 px default width.
    const bounds = frame.display?.bounds || { x: 0, y: 0, width: frame.size.width, height: frame.size.height };
    const rect = this.cropRectForPoint(frame, clickPos, {
      width: bounds.width,  // full display width → full image width after DPI scaling
      height: 100,          // ~2 lines tall, enough context without too much noise
    });
    try {
      return await this.recognizeCrop(frame.image, rect);
    } catch {
      return { text: '', confidence: null };
    }
  }

  async collectForegroundWindowContext(osPoint = null) {
    try {
      return await this.windowContext.collect(osPoint);
    } catch {
      // best effort only
      return { appName: '', windowTitle: '' };
    }
  }


  async buildCaptureTitle({ mode, frame, clickPos, clickMeta = null }) {
    const ctx = await this.buildCaptureContext({ mode, frame, clickPos, clickMeta });
    return ctx.title;
  }

  async buildCaptureContext({ mode, frame, clickPos, clickMeta = null }) {
    const keyContext = clickMeta?.keyContext || {};
    const recentTyped = keyContext.recentTyped || '';
    const recentShortcut = keyContext.recentShortcut || '';
    // Use window context pre-captured by the click watcher when available.
    // This avoids a costly PowerShell cold-start (1–3 s) on every capture.
    const fastContext = clickMeta?.windowContext || null;
    const [metadata, ocr] = await Promise.all([
      fastContext
        ? Promise.resolve(fastContext)
        : this.collectForegroundWindowContext(clickMeta?.osPoint || null),
      this.ocrAroundClick(frame, clickPos),
    ]);
    const title = buildCaptureTitle({ mode, metadata, ocrText: ocr.text, recentTyped, recentShortcut });
    return {
      title,
      captureMetadata: {
        ocrText: ocr.text || '',
        windowTitle: metadata.windowTitle || '',
        appName: metadata.appName || '',
        elementLabel: metadata.elementLabel || '',
        elementRole: metadata.elementRole || '',
        elementValue: metadata.elementValue || '',
        recentTyped,
        recentShortcut,
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
    let host;
    try {
      host = this.resolveHost(config.ollama.host);
    } catch (err) {
      return { ok: false, reason: err.message };
    }
    const tagsUrl = new URL('/api/tags', `${host.replace(/\/+$/, '')}/`);
    let res;
    try {
      res = await this.fetchJson(tagsUrl, { method: 'GET' });
    } catch (err) {
      return { ok: false, reason: err.message };
    }
    if (!res.ok) {
      return { ok: false, reason: `Ollama check failed (${res.status})` };
    }
    const data = await res.json();
    const models = Array.isArray(data?.models) ? data.models.map((model) => model.name).filter(Boolean) : [];
    const installed = config.ollama.model ? models.includes(config.ollama.model) : false;
    const vision = installed ? await this.modelSupportsVision({
      host,
      model: config.ollama.model,
    }) : false;
    return {
      ok: true,
      installed,
      vision,
      models,
      host,
      model: config.ollama.model,
    };
  }

  async modelCapabilities({ host, model }) {
    const normalizedHost = normalizeOllamaHost(host);
    const normalizedModel = normalizeWhitespace(model);
    if (!normalizedHost || !normalizedModel) return [];
    const cacheKey = `${normalizedHost}::${normalizedModel}`;
    if (this.modelCapabilityCache.has(cacheKey)) {
      return this.modelCapabilityCache.get(cacheKey);
    }
    const url = new URL('/api/show', `${normalizedHost.replace(/\/+$/, '')}/`);
    let capabilities = [];
    try {
      const response = await this.fetchJson(url, {
        method: 'POST',
        body: { model: normalizedModel },
      });
      if (response.ok) {
        const payload = await response.json();
        capabilities = Array.isArray(payload?.capabilities)
          ? payload.capabilities.map((cap) => normalizeWhitespace(cap).toLowerCase()).filter(Boolean)
          : [];
      }
    } catch {
      capabilities = [];
    }
    if (!capabilities.includes('vision') && modelLooksVisionCapable(normalizedModel)) {
      capabilities = [...capabilities, 'vision'];
    }
    this.modelCapabilityCache.set(cacheKey, capabilities);
    return capabilities;
  }

  async modelSupportsVision({ host, model }) {
    const capabilities = await this.modelCapabilities({ host, model });
    return capabilities.includes('vision');
  }

  readStepImageBase64(guideId, stepId) {
    const imagePath = this.store.stepImagePath(guideId, stepId, 'working') || this.store.stepImagePath(guideId, stepId, 'original');
    if (!imagePath || !fs.existsSync(imagePath)) return '';
    return fs.readFileSync(imagePath).toString('base64');
  }

  async callOllamaText({ host, model, prompt, systemPrompt, guideId = null }) {
    const url = new URL('/api/chat', `${host.replace(/\/+$/, '')}/`);
    const response = await this.withConcurrency(() => this.fetchJson(url, {
      method: 'POST',
      guideId,
      body: {
        model,
        stream: false,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        options: { temperature: 0.4 },
      },
    }));
    if (!response.ok) throw new Error(`Ollama request failed (${response.status})`);
    const payload = await response.json();
    const content = payload?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('Ollama returned an empty response');
    return content.trim();
  }

  async callOllama({ host, model, prompt, systemPrompt, images = [], guideId = null }) {
    const url = new URL('/api/chat', `${host.replace(/\/+$/, '')}/`);
    const userMessage = { role: 'user', content: prompt };
    if (Array.isArray(images) && images.length) {
      userMessage.images = images;
    }
    const response = await this.withConcurrency(() => this.fetchJson(url, {
      method: 'POST',
      guideId,
      body: {
        model,
        stream: false,
        format: 'json',
        messages: [
          { role: 'system', content: systemPrompt },
          userMessage,
        ],
        options: {
          temperature: 0.2,
        },
      },
    }));
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
      let host;
      try {
        host = this.resolveHost(config.ollama.host);
      } catch (err) {
        return { ok: false, reason: err.message };
      }
      const netOptions = this.aiNetworkOptions();

      const guide = this.store.getGuide(guideId);
      const step = this.store.getStep(guideId, stepId);
      if (!guide || !step) {
        return { ok: false, reason: 'Guide or step not found.' };
      }
      // Snapshot the revision now: AI generation is slow, and the user may
      // edit the step meanwhile. We save with this expectedRevision so a
      // response built from stale data cannot overwrite a newer user edit.
      const baseRevision = Number.isInteger(step.revision) ? step.revision : 0;

      const currentBlock = blockId
        ? [...(step.textBlocks || []), ...(step.codeBlocks || []), ...(step.tableBlocks || [])].find((b) => b.id === blockId) || null
        : null;
      if (blockId && target === 'block' && !currentBlock) {
        return { ok: false, reason: 'Block not found.' };
      }

      // Only attach a screenshot when the user allows it, the model can use
      // it, and it is within the size budget (a full 4K PNG base64-expands to
      // tens of MB in the request body).
      let screenshotBase64 = '';
      if (netOptions.attachScreenshots && step.image) {
        const candidate = this.readStepImageBase64(guideId, stepId);
        const bytes = candidate ? Math.floor((candidate.length * 3) / 4) : 0;
        if (candidate && bytes <= netOptions.maxImageBytes) {
          screenshotBase64 = candidate;
        }
      }
      const screenshotAttached = Boolean(screenshotBase64)
        ? await this.modelSupportsVision({
          host,
          model: config.ollama.model,
        })
        : false;

      let captureContext = null;
      // Use stored capture metadata when available (best context, from capture time).
      // Fall back to re-running OCR on the stored image only when metadata is absent.
      if (step.captureMetadata) {
        const rawCandidate = buildCaptureTitle({
          mode: step.captureMetadata.mode || 'fullscreen',
          metadata: {
            windowTitle: step.captureMetadata.windowTitle,
            appName: step.captureMetadata.appName,
            elementLabel: step.captureMetadata.elementLabel,
            elementRole: step.captureMetadata.elementRole,
            elementValue: step.captureMetadata.elementValue,
          },
          ocrText: step.captureMetadata.ocrText,
          recentTyped: step.captureMetadata.recentTyped,
          recentShortcut: step.captureMetadata.recentShortcut,
        });
        captureContext = {
          ...step.captureMetadata,
          // Don't suggest a generic fallback title — leave it blank so AI generates from context.
          titleCandidate: DEFAULT_TITLE_VALUES.has(rawCandidate) ? '' : rawCandidate,
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
            const rawCandidate2 = buildCaptureTitle({
              mode: step.kind === 'image' ? 'fullscreen' : 'window',
              metadata,
              ocrText: ocr.text,
            });
            captureContext = {
              ...metadata,
              ocrText: ocr.text,
              titleCandidate: DEFAULT_TITLE_VALUES.has(rawCandidate2) ? '' : rawCandidate2,
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
        screenshotAttached,
      });

      const raw = await this.callOllama({
        host,
        model: config.ollama.model,
        prompt,
        systemPrompt,
        images: screenshotAttached ? [screenshotBase64] : [],
        guideId,
      });
      const patch = normalizeAiPatch(raw);
      // Re-read the step: while generation ran, a capture auto-doc or another
      // background write may have advanced it. Apply the patch to the current
      // step and save with the original expected revision so a user edit made
      // during generation causes a conflict instead of a silent overwrite.
      let currentStep = step;
      try {
        currentStep = this.store.getStep(guideId, stepId) || step;
      } catch {
        currentStep = step;
      }
      const updated = applyAiPatchToStep(currentStep, patch, { target, blockId });
      let saved;
      try {
        saved = this.store.saveStep(guideId, updated, { expectedRevision: baseRevision });
      } catch (err) {
        if (err && err.code === 'STEPFORGE_REVISION_CONFLICT') {
          return { ok: false, reason: 'The step changed while AI was generating; nothing was overwritten.' };
        }
        throw err;
      }
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
      let host;
      try {
        host = this.resolveHost(config.ollama.host);
      } catch (err) {
        return { ok: false, reason: err.message };
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
        host,
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
