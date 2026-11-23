'use strict';

/*
 * Notion, SharePoint, BookStack, GitLab Pages and Zendesk:
 * Settings → Accounts → Publishing → <service>, and "Publish to <service>"
 * for one guide. One panel and one dialog serve them all, described by
 * PUBLISH_SERVICES. Tokens and secrets stay in the main process
 * (app/publish-account.js); this only sends what the user types to connect.
 */

const PUBLISH_SERVICES = {
  notion: {
    name: 'Notion', icon: 'notion.svg',
    description: t('Publish guides as pages in your Notion workspace.'),
    intro: t('Create an internal integration, paste its secret here, then share a page with it from the page’s ••• menu → Connections. Guides are published under the pages you share.'),
    help: { label: t('Open Notion integrations'), url: 'https://www.notion.so/profile/integrations' },
    fields: [{ key: 'token', label: t('Integration secret'), type: 'password', placeholder: 'ntn_…' }],
    target: t('Publish under'),
    targetNote: t('Only pages shared with the integration are listed.'),
  },
  sharepoint: {
    name: 'SharePoint', icon: 'sharepoint.svg',
    description: t('Publish guides as pages on a SharePoint site.'),
    intro: t('Sign in with your work or school Microsoft account. Guides become site pages, with their screenshots in the site’s Site Assets library.'),
    fields: [{ key: 'address', label: t('Site address'), type: 'url', placeholder: 'contoso.sharepoint.com/sites/Team' }],
    connect: t('Sign in with Microsoft'),
  },
  bookstack: {
    name: 'BookStack', icon: 'bookstack.svg',
    description: t('Publish guides as pages in a BookStack book.'),
    intro: t('Create an API token under your profile → Access & Security → API Tokens. Your role needs the “Access system API” permission.'),
    fields: [
      { key: 'address', label: t('Site address'), type: 'url', placeholder: 'docs.example.com' },
      { key: 'tokenId', label: t('Token ID'), type: 'text' },
      { key: 'tokenSecret', label: t('Token secret'), type: 'password' },
    ],
    target: t('Book or chapter'),
  },
  gitlab: {
    name: 'GitLab Pages', icon: 'gitlab.svg',
    description: t('Share guides on the web with GitLab Pages.'),
    intro: t('Create a personal access token with the api scope. The first publish makes a public project, stepforge-guides, whose GitLab Pages site shows your guides.'),
    fields: [
      { key: 'address', label: t('GitLab address'), type: 'url', placeholder: 'gitlab.com', optional: true },
      { key: 'token', label: t('Personal access token'), type: 'password', placeholder: 'glpat-…' },
    ],
  },
  zendesk: {
    name: 'Zendesk', icon: 'zendesk.svg',
    description: t('Publish guides as help center articles in Zendesk.'),
    intro: t('Create an API token in Admin Center → Apps and integrations → Zendesk API. New articles are saved as drafts for you to review and publish in Zendesk.'),
    fields: [
      { key: 'address', label: t('Zendesk subdomain'), type: 'text', placeholder: 'acme' },
      { key: 'email', label: t('Email address'), type: 'email' },
      { key: 'token', label: t('API token'), type: 'password' },
    ],
    target: t('Section'),
  },
};

const publishIcon = (service) => `../assets/icons/${PUBLISH_SERVICES[service].icon}`;

/** Settings → Accounts → Publishing → one service. `onStatus(status)` follows the connection. */
function makePublishSettings(api, service, { onStatus = () => {} } = {}) {
  const info = PUBLISH_SERVICES[service];
  let busy = false;
  let disposed = false;
  const banner = el('div.cloud-banner.hidden', { role: 'status', 'aria-live': 'polite' });
  const say = (message, tone = 'info') => {
    banner.textContent = message || '';
    banner.className = `cloud-banner ${tone}${message ? '' : ' hidden'}`;
  };

  const inputs = info.fields.map((field) => {
    const input = el('input', { type: field.type, placeholder: field.placeholder || '', spellcheck: false, autocomplete: 'off', 'aria-label': field.label });
    return { field, input, node: el('label.cloud-field', {}, el('span', {}, field.label), input) };
  });
  const connectBtn = el('button.primary', { type: 'button' }, info.connect || t('Connect'));
  const help = info.help ? el('button.link', { type: 'button', onClick: () => void api.shell.openExternal({ url: info.help.url }).catch(() => {}) }, info.help.label) : null;
  const signedOut = el('div.cloud-hero', {},
    el('div.cloud-hero-icon', { 'aria-hidden': 'true' }, el('img', { src: publishIcon(service), alt: '' })),
    el('div.cloud-hero-text', {},
      el('strong', {}, info.description),
      el('p.muted', {}, info.intro),
      ...inputs.map((i) => i.node),
      el('div.row', {}, connectBtn, help)));

  const who = el('strong.cloud-email', {}, '');
  const siteLine = el('span.muted', {}, '');
  const disconnectBtn = el('button', { type: 'button' }, t('Disconnect'));
  const signedIn = el('div.cloud-stack.hidden', {},
    el('div.cloud-account', {},
      el('div.cloud-avatar.service-logo', { 'aria-hidden': 'true' }, el('img', { src: publishIcon(service), alt: '' })),
      el('div.cloud-account-info', {}, who, el('div.cloud-status-line', {}, siteLine)),
      el('div.cloud-account-actions', {}, disconnectBtn)),
    el('section.cloud-card', {},
      el('header.cloud-card-head', {}, el('h4', {}, t('Publishing'))),
      el('p.muted', {}, t('Choose Share → Publish to {service} in a guide. Publishing the guide again updates the same page.', { service: info.name }))));

  const update = (status = {}) => {
    signedOut.classList.toggle('hidden', Boolean(status.connected));
    signedIn.classList.toggle('hidden', !status.connected);
    if (status.error && !status.connected) say(status.error, 'error');
    if (status.connected === false && status.available === false) {
      connectBtn.disabled = true;
      say(t('This build has no valid app credentials for {service}.', { service: info.name }), 'error');
    }
    who.textContent = status.account || info.name;
    siteLine.textContent = [status.site, info.name].filter(Boolean).join(' · ');
    onStatus(status);
  };
  const run = async (button, label, action) => {
    if (busy || disposed) return;
    busy = true;
    setButtonLoading(button, true, label);
    try { await action(); } catch (err) { if (!disposed) say(err.message, 'error'); }
    finally {
      busy = false;
      if (!disposed) setButtonLoading(button, false);
    }
  };
  connectBtn.addEventListener('click', () => run(connectBtn, t('Connecting…'), async () => {
    say('');
    const value = (input) => String(input.value ?? '');
    const fields = Object.fromEntries(inputs.map(({ field, input }) => [field.key, field.type === 'password' ? value(input) : value(input).trim()]));
    const missing = inputs.find(({ field, input }) => !field.optional && !value(input).trim());
    if (missing) { say(t('Enter the {field}.', { field: missing.field.label }), 'error'); missing.input.focus?.(); return; }
    const status = await api.publish.connect({ service, fields });
    if (disposed) return;
    for (const { field, input } of inputs) if (field.type === 'password') input.value = '';
    if (status.connected) say(t('Connected to {service}.', { service: info.name }), 'success');
    update(status);
  }));
  for (const { input } of inputs) input.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); connectBtn.click(); } });
  disconnectBtn.addEventListener('click', () => run(disconnectBtn, t('Disconnecting…'), async () => {
    update(await api.publish.disconnect({ service }));
    say(t('Disconnected. Pages you published stay on {service}.', { service: info.name }));
  }));

  api.publish.status({ service }).then((status) => { if (!disposed) update(status); }).catch((err) => say(err.message, 'error'));
  return {
    node: el('fieldset.cloud-panel', {}, el('legend', {}, info.name), signedOut, banner, signedIn),
    dispose() { disposed = true; if (busy) void api.publish.cancel({ service }).catch(() => {}); },
  };
}

const PUBLISH_STAGES = [
  ['check', t('Check for private details')],
  ['export', t('Prepare the page')],
  ['upload', t('Upload screenshots')],
  ['page', t('Save the page')],
];

function publishProgress(title, serviceName) {
  const fill = el('span.gh-progress-fill', { style: {} });
  const bar = el('div.gh-progress.indeterminate', { role: 'progressbar', 'aria-label': t('Publishing progress'), 'aria-valuemin': '0', 'aria-valuemax': '100' }, fill);
  const stages = PUBLISH_STAGES.map(([id, label]) => {
    const icon = el('span.gh-stage-icon', { 'aria-hidden': 'true' });
    return { id, icon, node: el('li.gh-stage', {}, icon, el('span.gh-stage-label', {}, label)) };
  });
  const node = el('div.gh-publishing', { role: 'status', 'aria-live': 'polite' },
    el('p', {}, el('strong', {}, t('Publishing “{title}” to {service}', { title, service: serviceName }))),
    el('ol.gh-stages', {}, ...stages.map((s) => s.node)),
    el('div.gh-upload', {}, bar));
  const set = (progress) => {
    const at = Math.max(0, PUBLISH_STAGES.findIndex(([id]) => id === progress?.stage));
    stages.forEach((stage, index) => {
      const state = index < at ? 'done' : index === at ? 'active' : 'upcoming';
      stage.node.className = `gh-stage ${state}`;
      stage.icon.replaceChildren(state === 'done' ? '✓' : state === 'active' ? el('span.spinner') : '');
    });
    const fraction = progress?.stage === 'upload' && progress.total ? progress.loaded / progress.total
      : progress?.stage === 'check' && progress.total ? progress.done / progress.total : null;
    bar.classList.toggle('indeterminate', fraction === null);
    if (fraction !== null) fill.style.width = `${Math.min(100, Math.floor(fraction * 100))}%`;
  };
  set({ stage: 'check' });
  return { node, set };
}

/**
 * Publish one guide to a service in PUBLISH_SERVICES. Resolves when the
 * dialog closes, with whether the guide changed (private-detail blurs may
 * have been added).
 */
async function showPublishToServiceDialog({ api, service, guideId, guideTitle, onOpenAccounts, onShowFinding }) {
  const info = PUBLISH_SERVICES[service];
  const heading = t('Publish to {service}', { service: info.name });
  const status = await api.publish.status({ service });
  if (!status.connected) {
    return new Promise((resolve) => {
      const { close } = openModal({
        title: heading,
        body: el('div.gh-publish', {}, el('p', {}, info.description),
          el('p.muted', {}, status.error || t('To start, connect {service} in Settings → Accounts → Publishing.', { service: info.name }))),
        footer: [
          el('button', { type: 'button', onClick: () => { close(); resolve(false); } }, t('Cancel')),
          el('button.primary', { type: 'button', onClick: () => { close(); resolve(false); onOpenAccounts?.(); } }, t('Set up {service}', { service: info.name })),
        ],
        onClose: () => resolve(false),
      });
    });
  }

  return new Promise((resolve) => {
    let open = true;
    let publishing = false;
    let changed = false;
    const finish = () => { open = false; resolve(changed); };
    const body = el('div.gh-publish');
    const cancelBtn = el('button', { type: 'button', onClick: () => { close(); finish(); } }, t('Cancel'));
    const publishBtn = el('button.primary', { type: 'button', disabled: true }, t('Publish'));
    const quality = el('div');
    const { close } = openModal({ title: heading, body: el('div', {}, quality, body), footer: [cancelBtn, publishBtn], onClose: finish });
    addQualityPanel(api, guideId, quality, (finding) => { close(); finish(); onShowFinding?.(finding); });

    const titleInput = el('input', { type: 'text', 'aria-label': t('Page title'), value: guideTitle });
    const targetSelect = el('select', { 'aria-label': info.target || '', disabled: true }, el('option', { value: '' }, t('Loading…')));
    const targetField = info.target ? el('label.gh-field', {}, el('span', {}, info.target), targetSelect) : null;
    const targetNote = el('p.muted.wikijs-note.hidden', {}, '');
    const previous = el('div.cloud-banner.hidden', {});
    const error = el('p.gh-note.error.hidden', { role: 'alert' }, '');
    const showError = (message) => { error.textContent = message; error.classList.remove('hidden'); };
    let checking = true;
    let ready = false;
    const canPublish = () => ready && !checking && !publishing && Boolean(titleInput.value.trim()) && (!info.target || Boolean(targetSelect.value));
    const refresh = () => { publishBtn.disabled = !canPublish(); };
    titleInput.addEventListener('input', refresh);
    targetSelect.addEventListener('change', refresh);

    // Private details are checked before Publish is available, as for the web.
    const privacyText = el('span', {}, t('Checking screenshots for private details…'));
    const privacySpinner = el('span.spinner', { 'aria-hidden': 'true' });
    const privacyReview = el('button.hidden', { type: 'button' }, t('Review'));
    const privacyBox = el('div.gh-privacy', { role: 'status', 'aria-live': 'polite' }, privacySpinner, privacyText, privacyReview);
    let review = null;
    const showReview = (next) => {
      review = next;
      privacySpinner.classList.add('hidden');
      privacyText.textContent = privacySummary(next);
      privacyBox.classList.toggle('found', Boolean(next.blurs.length || next.text.length));
      privacyReview.classList.toggle('hidden', !next.blurs.length && !next.text.length);
      if (next.added) changed = true;
    };
    privacyReview.addEventListener('click', () => {
      showPrivacyReview(api, guideId, review, t('These are blurred on the published page. Remove any blur that isn’t needed.'),
        (next) => { changed = true; showReview(next); });
    });
    runPrivacyCheck(api, guideId, (text) => { privacyText.textContent = text; })
      .then(showReview)
      .catch((err) => {
        privacySpinner.classList.add('hidden');
        privacyText.textContent = t('StepForge couldn’t check the screenshots for private details ({error}). Check them yourself before publishing.', { error: err.message });
        privacyBox.classList.add('found');
      })
      .finally(() => { checking = false; refresh(); });

    const where = status.site && status.site !== status.account ? `${status.account} (${status.site})` : status.account;
    const form = el('div.gh-publish', {},
      el('p', {}, t('Publish “{title}” to {where}.', { title: guideTitle, where: where || info.name })),
      previous,
      el('label.gh-field', {}, el('span', {}, t('Title')), titleInput),
      targetField, targetNote,
      privacyBox,
      error);
    body.replaceChildren(form);

    Promise.all([api.publish.defaults({ service, guideId }), info.target ? api.publish.targets({ service }) : [], guideUpdatedTimes(api)])
      .then(([defaults, targets, updated]) => {
        if (!open) return;
        if (titleInput.value === guideTitle) titleInput.value = defaults.title;
        if (info.target) {
          targetSelect.replaceChildren(...targets.map((target) => el('option', { value: target.id }, target.name)));
          targetSelect.disabled = !targets.length;
          const known = defaults.published?.target;
          if (known && targets.some((target) => target.id === known)) targetSelect.value = known;
          targetNote.textContent = !targets.length ? t('Nothing to publish to yet. {note}', { note: info.targetNote || t('Check that you can add pages there.') }) : info.targetNote || '';
          targetNote.classList.toggle('hidden', !targetNote.textContent);
        }
        ready = true;
        refresh();
        const page = defaults.published;
        if (!page) return;
        previous.replaceChildren(t('Published before. Publishing again updates the same page.'),
          editedSinceShared(updated.get(guideId), page.publishedAt) ? ` ${t('The guide has changed since you published it.')}` : '');
        previous.classList.remove('hidden');
      }).catch((err) => showError(err.message));

    const backToForm = () => {
      publishing = false;
      body.replaceChildren(form);
      publishBtn.classList.remove('hidden');
      cancelBtn.textContent = t('Cancel');
      refresh();
    };
    const publish = async (replace = false) => {
      if (!canPublish() && !replace) return;
      publishing = true;
      quality.replaceChildren(); // too late to fix before this publish
      error.classList.add('hidden');
      const progress = publishProgress(guideTitle, info.name);
      body.replaceChildren(progress.node);
      publishBtn.classList.add('hidden');
      cancelBtn.textContent = t('Close');
      const stop = api.publish.onProgress((update) => { if (update?.guideId === guideId && update.service === service) progress.set(update); });
      try {
        const result = await api.publish.run({ service, guideId, title: titleInput.value.trim(), target: targetSelect.value || '', replace });
        changed = true;
        if (result.conflict) {
          publishing = false;
          const ok = await confirmDialog(el('div.cloud-confirm', {},
            el('strong', {}, t('{path} already exists. Replace it?', { path: result.conflict.path })),
            el('p', {}, t('It wasn’t published from this guide.'))), { okLabel: t('Replace') });
          if (ok && open) { await publish(true); return; }
          backToForm();
          return;
        }
        if (!open) { toast(t('“{title}” is on {service}.', { title: guideTitle, service: info.name })); return; }
        const copy = el('button.primary', { type: 'button', onClick: async () => {
          try { await navigator.clipboard.writeText(result.url); toast(t('Link copied.')); }
          catch { toast(t('Couldn’t copy the link.'), { error: true }); }
        } }, t('Copy link'));
        body.replaceChildren(
          el('p.gh-published-title', {}, el('span.gh-published-icon', { 'aria-hidden': 'true' }, '✓'),
            el('strong', {}, result.draft ? t('Saved “{title}” on {service} as a draft.', { title: result.title, service: info.name })
              : result.updated ? t('Updated “{title}” on {service}.', { title: result.title, service: info.name })
                : t('Published “{title}” to {service}.', { title: result.title, service: info.name }))),
          result.note ? el('p.muted', {}, result.note) : null,
          el('code.settings-path.gh-url', { title: result.url }, result.url),
          el('div.row', {}, copy, el('button', { type: 'button', onClick: () => void api.shell.openExternal({ url: result.url }).catch(() => {}) }, t('Open in browser'))));
        cancelBtn.textContent = t('Done');
      } catch (err) {
        if (!open) { toast(t('Publishing “{title}” to {service} failed: {error}', { title: guideTitle, service: info.name, error: err.message }), { error: true }); return; }
        backToForm();
        showError(err.message);
      } finally {
        stop();
      }
    };
    publishBtn.addEventListener('click', () => { void publish(false); });
  });
}
