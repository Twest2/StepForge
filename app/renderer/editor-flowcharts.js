'use strict';
(() => {
const flow = window.StepForgeFlowchart, md = window.StepForgeMarkdown, api = window.stepforge;
const copy = v => JSON.parse(JSON.stringify(v));
const uid = () => `flow-${crypto.randomUUID()}`;

Object.assign(window.GuideEditor.prototype, {
  setupFlowcharts() {
    const bar = this.dom.canvasPane.querySelector('.canvas-toolbar');
    this.dom.imageTools = el('div.image-tools', {}, ...Array.from(bar.children));
    this.dom.flowTools = el('div.flowchart-toolbar', { hidden: true });
    this.dom.visualSelect = el('select.main-visual-select', { 'aria-label': t('Main visual') },
      el('option', { value: 'image' }, t('Image')), el('option', { value: 'flowchart' }, t('Flowchart')), el('option', { value: 'none' }, t('None')));
    this.dom.visualSelect.addEventListener('change', () => {
      const step = this.currentStep;
      if (!step) return;
      this.pushCanvasHistory(); this.editingFlowchartBlock = null;
      step.mainVisual = this.dom.visualSelect.value;
      if (step.mainVisual === 'flowchart') step.flowchart ||= flow.normalizeGraph();
      this.markFlowchartChanged(); this.renderCanvas();
    });
    bar.append(this.dom.imageTools, this.dom.flowTools, el('label.main-visual-picker', {}, t('Main visual'), this.dom.visualSelect));
    this.dom.flowProperties = el('div.flowchart-properties', { hidden: true });
    this.dom.flowSurface = el('div.flowchart-surface', { hidden: true, tabIndex: 0, role: 'group', 'aria-label': t('Flowchart editor') });
    bar.after(this.dom.flowProperties);
    this.dom.canvasWrap.append(this.dom.flowSurface);
    this.flowEditor = new window.FlowchartEditor({
      toolbar: this.dom.flowTools, surface: this.dom.flowSurface, properties: this.dom.flowProperties,
      getGraph: () => this.activeFlowchart(), getSteps: () => this.flowchartSteps(),
      onChange: graph => { this.pushCanvasHistory(); this.setActiveFlowchart(graph); this.markFlowchartChanged(); this.renderBlocksPanel(); },
      onPlacement: placement => this.moveFlowchart(placement), onDone: () => { this.editingFlowchartBlock = null; this.renderCanvas(); },
      onAi: () => this.generateFlowchartWithAi(), onGoToStep: id => this.selectStep(id), onToast: (...args) => this.onToast(...args),
    });
    this.dom.flowTools.prepend(el('button.tool', { type: 'button', onClick: () => this.undo() }, t('Undo')),
      el('button.tool', { type: 'button', onClick: () => this.redo() }, t('Redo')));
    const add = el('button', { type: 'button', onClick: () => this.addFlowchartBlock() }, t('+ Flowchart'));
    this.dom.addTableBlockBtn.after(add);
    this.setupMarkdownDescription();
  },

  flowchartSteps() {
    const numbers = window.StepForgeOutline.stepNumberMap(this.steps);
    return this.steps.map(s => ({ stepId: s.stepId, number: numbers.get(s.stepId), title: s.title }));
  },

  activeFlowchart() {
    const step = this.currentStep;
    if (!step) return null;
    if (this.editingFlowchartBlock) return step.flowchartBlocks?.find(b => b.id === this.editingFlowchartBlock)?.graph || null;
    return step.mainVisual === 'flowchart' ? step.flowchart : null;
  },

  setActiveFlowchart(graph) {
    if (this.editingFlowchartBlock) {
      const block = this.currentStep?.flowchartBlocks?.find(b => b.id === this.editingFlowchartBlock);
      if (block) block.graph = graph;
    } else if (this.currentStep) this.currentStep.flowchart = graph;
  },

  flowchartIsActive() { return Boolean(this.activeFlowchart()); },

  syncFlowchartCanvas() {
    if (!this.dom.flowSurface) return false;
    const step = this.currentStep;
    if (this.editingFlowchartBlock && !step?.flowchartBlocks?.some(b => b.id === this.editingFlowchartBlock)) this.editingFlowchartBlock = null;
    const active = this.flowchartIsActive();
    const context = `${step?.stepId || ''}:${this.editingFlowchartBlock || 'main'}`;
    if (this.flowchartContext !== context) {
      this.flowchartContext = context;
      Object.assign(this.flowEditor, { selected: null, edge: null, connectFrom: null, drag: null, tool: 'select' });
    }
    this.dom.visualSelect.disabled = !step || Boolean(this.editingFlowchartBlock);
    this.dom.visualSelect.value = this.editingFlowchartBlock ? 'flowchart' : step?.mainVisual || 'image';
    this.dom.imageTools.hidden = active;
    this.dom.flowTools.hidden = !active;
    this.dom.flowProperties.hidden = !active;
    this.dom.flowSurface.hidden = !active;
    this.dom.canvas.hidden = active || step?.mainVisual === 'none';
    this.dom.canvasWrap.classList.toggle('editing-flowchart', active);
    this.dom.annotationList.closest('section').hidden = active;
    this.dom.focusedViewToggle.classList.toggle('hidden', active);
    this.dom.focusedControls.classList.toggle('flowchart-hidden', active);
    if (active) {
      this.dom.canvasEmpty.classList.add('hidden');
      this.flowEditor.render({ block: Boolean(this.editingFlowchartBlock), aiReady: this.isAiEnabled() });
      return true;
    }
    if (step?.mainVisual === 'none') {
      this.dom.canvasEmpty.textContent = t('No main visual. Choose Image or Flowchart to add one.');
      this.dom.canvasEmpty.classList.remove('hidden'); return true;
    }
    return false;
  },

  markFlowchartChanged() { this.pendingSave = true; this.saveStepDebounced(); this.emitMeta(); },

  addFlowchartBlock() {
    const step = this.currentStep;
    if (!step) return this.onToast(t('Select a step first.'), { error: true });
    this.pushCanvasHistory();
    const id = uid(), order = Math.max(0, ...[...(step.textBlocks || []), ...(step.codeBlocks || []), ...(step.tableBlocks || []), ...(step.flowchartBlocks || [])].map(b => b.order || 0)) + 1;
    (step.flowchartBlocks ||= []).push({ id, order, title: '', graph: flow.normalizeGraph() });
    this.editingFlowchartBlock = id; this.markFlowchartChanged(); this.renderBlocksPanel(); this.renderCanvas();
  },

  moveFlowchart(placement) {
    const step = this.currentStep, graph = this.activeFlowchart();
    if (!step || !graph || (placement === 'block') === Boolean(this.editingFlowchartBlock)) return;
    this.pushCanvasHistory();
    if (placement === 'block') {
      const id = uid(), blocks = step.flowchartBlocks ||= [];
      const order = Math.max(0, ...[...(step.textBlocks || []), ...(step.codeBlocks || []), ...(step.tableBlocks || []), ...blocks].map(b => b.order || 0)) + 1;
      blocks.push({ id, order, title: '', graph: copy(graph) });
      step.flowchart = null; step.mainVisual = step.image ? 'image' : 'none'; this.editingFlowchartBlock = id;
    } else {
      const block = step.flowchartBlocks.find(b => b.id === this.editingFlowchartBlock);
      // Preserve an existing main diagram by swapping it into the old block.
      if (step.flowchart) block.graph = step.flowchart;
      else step.flowchartBlocks = step.flowchartBlocks.filter(b => b !== block);
      step.flowchart = graph; step.mainVisual = 'flowchart'; this.editingFlowchartBlock = null;
    }
    this.markFlowchartChanged(); this.renderBlocksPanel(); this.renderCanvas();
  },

  async generateFlowchartWithAi() {
    if (!this.currentStep || !this.isAiEnabled()) return;
    const request = await window.StepForgeDialogs.promptText({ title: t('Generate flowchart'), label: t('Describe the flowchart or change'), multiline: true,
      value: t('Summarize this guide. Only include branches supported by its instructions.') });
    if (!request?.trim()) return;
    const guideId = this.guideId, stepId = this.currentStep.stepId, blockId = this.editingFlowchartBlock || null;
    const baseline = JSON.stringify(this.activeFlowchart());
    await this.flushStep();
    if (this.pendingSave) return;
    const status = el('p', { role: 'status', 'aria-live': 'polite' }, t('Creating flowchart…'));
    const preview = el('div.flowchart-ai-preview');
    let closed = false, result = null;
    const apply = el('button.primary', { type: 'button', disabled: true, onClick: () => {
      if (this.guideId !== guideId || this.currentStep?.stepId !== stepId || (this.editingFlowchartBlock || null) !== blockId
        || JSON.stringify(this.activeFlowchart()) !== baseline) {
        status.textContent = t('The diagram changed while AI was writing. Generate again to keep your edits.'); return;
      }
      this.pushCanvasHistory();
      if (!this.activeFlowchart()) { this.currentStep.mainVisual = 'flowchart'; this.currentStep.flowchart = result.graph; }
      else this.setActiveFlowchart(result.graph);
      this.markFlowchartChanged(); this.renderBlocksPanel(); this.renderCanvas(); close();
    } }, t('Apply'));
    const { close } = openModal({ title: t('Review flowchart'), body: el('div', {}, status, preview), footer: [
      el('button', { type: 'button', onClick: () => close() }, t('Cancel')), apply],
      onClose: () => { closed = true; api.ai.cancel({ guideId }).catch(() => {}); } });
    try {
      result = await api.ai.flowchart({ guideId, request, graph: this.activeFlowchart() });
      if (closed) return;
      if (!result.ok) throw new Error(result.reason);
      preview.innerHTML = flow.toSvg(result.graph, this.flowchartSteps());
      status.textContent = t('Review the branches before applying.'); apply.disabled = false;
    } catch (err) { if (!closed) status.textContent = err.message; }
  },

  setupMarkdownDescription() {
    this.descriptionMode = 'markdown';
    const mode = this.dom.descriptionMode = el('select', { 'aria-label': t('Description editing mode'), onChange: () => { this.descriptionMode = mode.value; this.syncMarkdownDescription(); } },
      el('option', { value: 'markdown' }, 'Markdown'), el('option', { value: 'preview' }, t('Preview')), el('option', { value: 'rich' }, t('Rich text')));
    const picker = el('button', { type: 'button', onClick: () => this.insertStepReference() }, t('Go to step…'));
    this.dom.richToolbar.before(el('div.row.description-mode', {}, mode, picker));
    const source = this.dom.descriptionSource = el('textarea.description-source', { rows: 12, spellcheck: true, 'aria-label': t('Description Markdown') });
    const preview = this.dom.descriptionPreview = el('div.rich-editor.description-preview', { hidden: true, tabIndex: 0, 'aria-label': t('Description preview') });
    this.dom.descEditor.after(source, preview);
    source.addEventListener('focus', () => { if (this.currentStep) this.pushCanvasHistory('description'); });
    source.addEventListener('input', () => {
      const step = this.currentStep; if (!step) return;
      step.descriptionMarkdown = source.value; step.descriptionHtml = md.render(source.value);
      this.pendingSave = true; this.saveStepDebounced(); this.emitMeta();
    });
    preview.addEventListener('click', e => {
      const a = e.target.closest('a[href^="step:"]'); if (!a) return;
      e.preventDefault(); const id = a.getAttribute('href').slice(5);
      if (this.stepMap.has(id)) this.selectStep(id);
      else this.onToast(t('The linked step is unavailable.'), { error: true });
    });
    this.dom.descEditor.addEventListener('click', e => {
      const a = e.target.closest('a[href^="step:"]');
      if (a && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.selectStep(a.getAttribute('href').slice(5)); }
    });
    preview.after(el('p.muted.markdown-help', {}, t('CommonMark, tables, strikethrough and step links. Remote images are shown as links; HTML is displayed as text.')));
  },

  syncMarkdownDescription() {
    if (!this.dom.descriptionSource) return;
    const step = this.currentStep, mode = this.descriptionMode || 'markdown';
    this.dom.descriptionSource.hidden = mode !== 'markdown';
    this.dom.descriptionPreview.hidden = mode !== 'preview';
    this.dom.descEditor.hidden = mode !== 'rich';
    this.dom.richToolbar.hidden = mode !== 'rich';
    if (!step) { this.dom.descriptionSource.value = ''; this.dom.descriptionPreview.innerHTML = ''; return; }
    const source = this.dom.descriptionSource;
    if (document.activeElement !== source) {
      if (typeof step.descriptionMarkdown === 'string') source.value = step.descriptionMarkdown;
      else if (this.descriptionLoadedStep !== step.stepId || this.descriptionLoadedHtml !== step.descriptionHtml) {
        this.descriptionLoadedStep = step.stepId; this.descriptionLoadedHtml = step.descriptionHtml;
        source.value = '';
        source.readOnly = true;
        const html = step.descriptionHtml;
        api.guide.descriptionToMarkdown({ html: html || '' }).then(value => {
          if (this.currentStep === step && step.descriptionHtml === html && typeof step.descriptionMarkdown !== 'string') { source.value = value; source.readOnly = false; }
        }).catch(err => { source.readOnly = false; this.onToast(err.message, { error: true }); });
      }
    }
    if (typeof step.descriptionMarkdown === 'string') source.readOnly = false;
    this.dom.descriptionPreview.innerHTML = step.descriptionHtml || '';
    const numbers = window.StepForgeOutline.stepNumberMap(this.steps);
    for (const a of this.dom.descriptionPreview.querySelectorAll('a[href^="step:"]')) {
      const id = a.getAttribute('href').slice(5), number = numbers.get(id);
      if (!number) { a.textContent += ` (${t('Step unavailable')})`; a.removeAttribute('href'); }
      else if (/^Go to Step(?:\s.*)?$/.test(a.textContent)) a.textContent = t('Go to Step {number}', { number });
    }
  },

  insertStepReference() {
    const step = this.currentStep; if (!step) return;
    const source = this.dom.descriptionSource, start = source.selectionStart, end = source.selectionEnd;
    const selection = window.getSelection();
    const range = selection?.rangeCount && this.dom.descEditor.contains(selection.anchorNode) ? selection.getRangeAt(0).cloneRange() : null;
    const select = el('select', { 'aria-label': t('Go to step') }, ...this.flowchartSteps().filter(s => s.stepId !== step.stepId)
      .map(s => el('option', { value: s.stepId }, `${s.number}. ${s.title || t('Untitled step')}`)));
    const { close } = openModal({ title: t('Go to step'), body: select, footer: [
      el('button', { type: 'button', onClick: () => close() }, t('Cancel')),
      el('button.primary', { type: 'button', disabled: !select.options.length, onClick: () => {
        if (this.currentStep !== step || !this.stepMap.has(select.value)) { close(); return; }
        this.pushCanvasHistory('description');
        if (this.descriptionMode === 'rich') {
          const link = el('a', { href: `step:${select.value}` }, 'Go to Step');
          if (range) { range.deleteContents(); range.insertNode(link); } else this.dom.descEditor.append(link);
          delete step.descriptionMarkdown; step.descriptionHtml = this.dom.descEditor.innerHTML;
        } else {
          this.descriptionMode = 'markdown'; this.dom.descriptionMode.value = 'markdown';
          source.setRangeText(`[Go to Step](step:${select.value})`, start, end, 'end');
          step.descriptionMarkdown = source.value; step.descriptionHtml = md.render(source.value);
        }
        this.pendingSave = true; this.saveStepDebounced(); this.syncMarkdownDescription(); close();
      } }, t('Insert'))], initialFocus: select });
  },
});
})();
