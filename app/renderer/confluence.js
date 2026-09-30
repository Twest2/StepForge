'use strict';

/*
 * Confluence: Settings → Accounts → Confluence, and "Publish to Confluence"
 * for one guide. Tokens and cookies stay in the main process
 * (app/confluence.js); this only sends what the user types to sign in.
 */

const CONFLUENCE_ICON = '../assets/icons/confluence.svg';

function confluenceOpen(api, url) {
  if (url) void api.shell.openExternal({ url }).catch(() => {});
}

function makeConfluenceSettings(api) {
  let current = {};
  let site = null;
  let busy = false;
  let disposed = false;

  const banner = el('div.cloud-banner.hidden', { role: 'status', 'aria-live': 'polite' });
  const say = (message, tone = 'info') => {
    banner.textContent = message || '';
    banner.className = `cloud-banner ${tone}${message ? '' : ' hidden'}`;
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

  /* Signed out: the site address, then how to sign in. */
  const address = el('input', { type: 'url', placeholder: 'confluence.example.com', spellcheck: false, 'aria-label': 'Confluence site address' });
  const next = el('button.primary', { type: 'button' }, 'Continue');
  const email = el('input', { type: 'email', autocomplete: 'username', spellcheck: false, 'aria-label': 'Atlassian email address' });
  const token = el('input', { type: 'password', autocomplete: 'off', 'aria-label': 'Token' });
  const tokenLabel = el('span', {}, 'Personal access token');
  const tokenLink = el('button.link', { type: 'button', onClick: () => confluenceOpen(api, site?.tokenUrl) }, 'Create a token');
  const emailField = el('label.cloud-field.hidden', {}, el('span', {}, 'Email address'), email);
  const connect = el('button.primary', { type: 'button' }, 'Connect');
  const browser = el('button', { type: 'button' }, 'Sign in with your browser');
  const browserNote = el('p.muted', {}, 'For single sign-on or a smart card (CAC). If your site asks for your card, insert it first; your computer asks for your PIN.');
  const browserOption = el('div.confluence-browser', {}, el('p.confluence-or', {}, 'Or'), el('div.row', {}, browser), browserNote);
  const method = el('div.confluence-method.hidden', {},
    emailField,
    el('label.cloud-field', {}, tokenLabel, token),
    el('div.row', {}, connect, tokenLink),
    browserOption);
  const signedOut = el('div.cloud-hero', {},
    el('div.cloud-hero-icon', { 'aria-hidden': 'true' }, el('img', { src: CONFLUENCE_ICON, alt: '' })),
    el('div.cloud-hero-text', {},
      el('strong', {}, 'Publish guides as Confluence pages'),
      el('p.muted', {}, 'Works with Confluence Cloud and with Confluence Data Center or Server sites inside your organization. StepForge creates or updates one page per guide, with its screenshots attached.'),
      el('label.cloud-field', {}, el('span', {}, 'Site address'), address),
      el('div.row', {}, next),
      method));

  const showMethod = (found) => {
    site = found;
    method.classList.remove('hidden');
    emailField.classList.toggle('hidden', !found.cloud);
    tokenLabel.textContent = found.cloud ? 'API token' : 'Personal access token';
    tokenLink.textContent = found.cloud ? 'Create an API token' : 'Create a token on your site';
    browserOption.classList.toggle('hidden', found.cloud);
    next.classList.add('hidden');
    (found.cloud ? email : token).focus?.();
  };
  next.addEventListener('click', () => run(next, 'Checking…', async () => {
    say('');
    showMethod(await api.confluence.probe({ address: address.value.trim() }));
  }));
  address.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); next.click(); } });
  address.addEventListener('input', () => { method.classList.add('hidden'); next.classList.remove('hidden'); site = null; });
  connect.addEventListener('click', () => run(connect, 'Connecting…', async () => {
    const status = await api.confluence.connect({ address: address.value.trim(), token: token.value, email: email.value.trim() });
    token.value = '';
    say(`Connected as ${status.user}. Choose where new pages go.`, 'success');
    update(status);
  }));
  token.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); connect.click(); } });
  browser.addEventListener('click', () => run(browser, 'Waiting for sign-in…', async () => {
    say('Sign in to Confluence in the window that opened. It closes by itself when you’re signed in.');
    const status = await api.confluence.connectWithBrowser({ address: address.value.trim() });
    say(`Connected as ${status.user}. Choose where new pages go.`, 'success');
    update(status);
  }));

  /* Signed in: the account, and where new pages go. */
  const who = el('strong.cloud-email', {}, '');
  const siteLine = el('span.muted', {}, '');
  const disconnect = el('button', { type: 'button', onClick: () => run(disconnect, 'Disconnecting…', async () => {
    update(await api.confluence.disconnect());
    say('Disconnected. Pages you published stay in Confluence.');
  }) }, 'Disconnect');
  const account = el('div.cloud-account', {},
    el('div.cloud-avatar', { 'aria-hidden': 'true' }, el('img', { src: CONFLUENCE_ICON, alt: '' })),
    el('div.cloud-account-info', {}, who, el('div.cloud-status-line', {}, siteLine)),
    el('div.cloud-account-actions', {}, disconnect));

  const spaceSelect = el('select', { 'aria-label': 'Space for new pages' }, el('option', { value: '' }, 'Loading spaces…'));
  const parentText = el('span', {}, 'At the top of the space');
  const parentQuery = el('input', { type: 'search', placeholder: 'Search pages in this space', 'aria-label': 'Search for a parent page' });
  const parentResults = el('div.confluence-results');
  const topLevel = el('button', { type: 'button' }, 'Top of the space');
  let spaces = [];
  const saveDefaults = (space, parent) => api.confluence.setDefaults({ space, parent }).then(update).catch((err) => say(err.message, 'error'));
  spaceSelect.addEventListener('change', () => {
    const space = spaces.find((s) => s.key === spaceSelect.value) || null;
    parentResults.replaceChildren();
    parentQuery.value = '';
    void saveDefaults(space, null);
  });
  topLevel.addEventListener('click', () => { parentResults.replaceChildren(); void saveDefaults(current.space, null); });
  let searchTimer = null;
  let searchRequest = 0;
  parentQuery.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      if (!current.space) return;
      const request = ++searchRequest;
      try {
        const pages = await api.confluence.findPages({ spaceKey: current.space.key, query: parentQuery.value });
        if (disposed || request !== searchRequest) return;
        parentResults.replaceChildren(...(pages.length ? pages.map((page) => el('button.confluence-result', { type: 'button', onClick: () => {
          parentResults.replaceChildren();
          parentQuery.value = '';
          void saveDefaults(current.space, page);
        } }, page.title)) : [el('p.muted', {}, 'No matching pages.')]));
      } catch (err) { say(err.message, 'error'); }
    }, 300);
  });
  const places = el('section.cloud-card', {},
    el('header.cloud-card-head', {}, el('h4', {}, 'Where new pages go')),
    el('label.gh-field', {}, el('span', {}, 'Space'), spaceSelect),
    el('div.confluence-parent', {}, el('span.muted', {}, 'Parent page: '), parentText),
    el('div.row', {}, parentQuery, topLevel),
    parentResults,
    el('p.muted', {}, 'You can pick another space when you publish. Publishing a guide again updates its page.'));
  const signedIn = el('div.cloud-stack.hidden', {}, account, places);

  const loadSpaces = async () => {
    try {
      spaces = await api.confluence.spaces();
      if (disposed) return;
      spaceSelect.replaceChildren(el('option', { value: '' }, spaces.length ? 'Choose a space' : 'No spaces you can add pages to'),
        ...spaces.map((s) => el('option', { value: s.key, selected: s.key === current.space?.key }, `${s.name} (${s.key})`)));
    } catch (err) {
      if (!disposed) { spaceSelect.replaceChildren(el('option', { value: '' }, 'Couldn’t load spaces')); say(err.message, 'error'); }
    }
  };

  function update(status) {
    const wasConnected = Boolean(current.connected);
    current = status || {};
    signedOut.classList.toggle('hidden', Boolean(current.connected));
    signedIn.classList.toggle('hidden', !current.connected);
    if (current.error && !current.connected) say(current.error, 'error');
    if (!current.connected) return;
    who.textContent = current.user || 'Confluence user';
    siteLine.textContent = `${current.host} · ${current.cloud ? 'Confluence Cloud' : 'Confluence Data Center'}${current.method === 'browser' ? ' · signed in with your browser' : ''}`;
    parentText.textContent = current.parent ? current.parent.title : 'At the top of the space';
    if (!wasConnected) void loadSpaces();
  }

  const node = el('fieldset.cloud-panel', {}, el('legend', {}, 'Confluence'), signedOut, banner, signedIn);
  const stop = api.confluence.onStatus((status) => { if (!disposed) update(status); });
  api.confluence.status().then((status) => { if (!disposed) update(status); }).catch((err) => say(err.message, 'error'));
  return { node, dispose() { disposed = true; stop(); clearTimeout(searchTimer); if (busy) void api.confluence.cancel().catch(() => {}); } };
}

const CONFLUENCE_STAGES = [
  ['check', 'Check for private details'],
  ['export', 'Prepare the page'],
  ['page', 'Save the page'],
  ['upload', 'Attach screenshots'],
];

function confluenceProgress(guideTitle) {
  const fill = el('span.gh-progress-fill', { style: {} });
  const bar = el('div.gh-progress.indeterminate', { role: 'progressbar', 'aria-label': 'Publishing progress', 'aria-valuemin': '0', 'aria-valuemax': '100' }, fill);
  const detail = el('span.gh-progress-detail.muted', {}, '');
  const stages = CONFLUENCE_STAGES.map(([id, label]) => {
    const icon = el('span.gh-stage-icon', { 'aria-hidden': 'true' });
    return { id, icon, node: el('li.gh-stage', {}, icon, el('span.gh-stage-label', {}, label)) };
  });
  const node = el('div.gh-publishing', { role: 'status', 'aria-live': 'polite' },
    el('p', {}, el('strong', {}, `Publishing “${guideTitle}” to Confluence`)),
    el('ol.gh-stages', {}, ...stages.map((s) => s.node)),
    el('div.gh-upload', {}, bar, detail));
  const set = (progress) => {
    const at = Math.max(0, CONFLUENCE_STAGES.findIndex(([id]) => id === progress?.stage));
    stages.forEach((stage, index) => {
      const state = index < at ? 'done' : index === at ? 'active' : 'upcoming';
      stage.node.className = `gh-stage ${state}`;
      stage.icon.replaceChildren(state === 'done' ? '✓' : state === 'active' ? el('span.spinner') : '');
    });
    const fraction = progress?.stage === 'upload' && progress.total ? progress.loaded / progress.total
      : progress?.stage === 'check' && progress.total ? progress.done / progress.total : null;
    if (fraction === null) {
      bar.classList.add('indeterminate');
      bar.removeAttribute('aria-valuenow');
    } else {
      const percent = Math.min(100, Math.floor(fraction * 100));
      bar.classList.remove('indeterminate');
      fill.style.width = `${percent}%`;
      bar.setAttribute('aria-valuenow', String(percent));
    }
    detail.textContent = progress?.stage === 'upload' ? `Screenshot ${progress.index} of ${progress.count}`
      : progress?.stage === 'check' && progress.total ? `Screenshot ${progress.done} of ${progress.total}`
        : progress?.stage === 'page' ? 'Saving the page in Confluence…' : 'Building the page from your guide…';
  };
  set({ stage: 'check' });
  return { node, set };
}

/**
 * Publish one guide to Confluence. Resolves when the dialog closes, with
 * whether the guide changed (private-detail blurs may have been added).
 */
async function showPublishToConfluenceDialog({ api, guideId, guideTitle, onOpenAccounts }) {
  const status = await api.confluence.status();
  if (!status.connected) {
    return new Promise((resolve) => {
      const { close } = openModal({
        title: 'Publish to Confluence',
        body: el('div.gh-publish', {},
          el('p', {}, 'Publishing creates a Confluence page for this guide, with its screenshots attached. Publishing again updates the same page.'),
          el('p.muted', {}, 'To start, connect your Confluence site in Settings → Accounts → Confluence.')),
        footer: [
          el('button', { type: 'button', onClick: () => { close(); resolve(false); } }, 'Cancel'),
          el('button.primary', { type: 'button', onClick: () => { close(); resolve(false); onOpenAccounts?.(); } }, 'Set up Confluence'),
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
    const cancelBtn = el('button', { type: 'button', onClick: () => { close(); finish(); } }, 'Cancel');
    const publishBtn = el('button.primary', { type: 'button', disabled: true }, 'Publish');
    const { close } = openModal({ title: 'Publish to Confluence', body, footer: [cancelBtn, publishBtn], onClose: finish });

    const spaceSelect = el('select', { 'aria-label': 'Confluence space' }, el('option', { value: '' }, 'Loading spaces…'));
    let spaces = [];
    const parentNote = el('p.muted', {}, '');
    const previous = el('div.cloud-banner.hidden', {});
    const error = el('p.gh-note.error.hidden', { role: 'alert' }, '');
    const showError = (message) => { error.textContent = message; error.classList.remove('hidden'); };
    let checking = true;
    const chosenSpace = () => spaces.find((s) => s.key === spaceSelect.value) || null;
    const canPublish = () => Boolean(chosenSpace()) && !checking && !publishing;
    const refresh = () => {
      publishBtn.disabled = !canPublish();
      const space = chosenSpace();
      parentNote.textContent = space && status.parent && status.space?.key === space.key
        ? `The page goes under “${status.parent.title}”.` : space ? `The page goes at the top of ${space.name}.` : '';
    };
    spaceSelect.addEventListener('change', refresh);

    // Private details are checked before Publish is available, as for the web.
    const privacyText = el('span', {}, 'Checking screenshots for private details…');
    const privacySpinner = el('span.spinner', { 'aria-hidden': 'true' });
    const privacyReview = el('button.hidden', { type: 'button' }, 'Review');
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
      const { close: closeReview } = openModal({
        title: 'Private details',
        body: el('div.privacy-dialog', {},
          el('p.muted', {}, 'These are blurred on the Confluence page. Remove any blur that isn’t needed.'),
          privacyReviewList(api, guideId, review, { onChange: (next) => { changed = true; showReview(next); } })),
        footer: [el('button.primary', { type: 'button', onClick: () => closeReview() }, 'Done')],
      });
    });
    runPrivacyCheck(api, guideId, (text) => { privacyText.textContent = text; })
      .then(showReview)
      .catch((err) => {
        privacySpinner.classList.add('hidden');
        privacyText.textContent = `StepForge couldn’t check the screenshots for private details (${err.message}). Check them yourself before publishing.`;
        privacyBox.classList.add('found');
      })
      .finally(() => { checking = false; refresh(); });

    const form = el('div.gh-publish', {},
      el('p', {}, `Publish “${guideTitle}” as a page on ${status.host}, with its screenshots attached.`),
      previous,
      el('label.gh-field', {}, el('span', {}, 'Space'), spaceSelect),
      parentNote,
      privacyBox,
      error);
    body.replaceChildren(form);

    api.confluence.published({ guideId }).then((page) => {
      if (!page || !open) return;
      previous.replaceChildren('Published before. Publishing again updates ', el('button.link', { type: 'button', onClick: () => confluenceOpen(api, page.url) }, 'the same page'), '.');
      previous.classList.remove('hidden');
    }).catch(() => {});
    api.confluence.spaces().then((list) => {
      spaces = list;
      if (!open) return;
      spaceSelect.replaceChildren(el('option', { value: '' }, 'Choose a space'),
        ...list.map((s) => el('option', { value: s.key, selected: s.key === status.space?.key }, `${s.name} (${s.key})`)));
      refresh();
    }).catch((err) => showError(err.message));

    const publish = async (replace = false) => {
      const space = chosenSpace();
      if (!space || publishing) return;
      publishing = true;
      error.classList.add('hidden');
      const progress = confluenceProgress(guideTitle);
      body.replaceChildren(progress.node);
      publishBtn.classList.add('hidden');
      cancelBtn.textContent = 'Close';
      const stop = api.confluence.onProgress((update) => { if (update?.guideId === guideId) progress.set(update); });
      try {
        const parent = status.parent && status.space?.key === space.key ? status.parent : null;
        const result = await api.confluence.publish({ guideId, space, parent, replace });
        changed = true;
        if (result.conflict) {
          publishing = false;
          const ok = await confirmDialog(el('div.cloud-confirm', {},
            el('strong', {}, `A page called “${result.conflict.title}” already exists in ${result.conflict.space}.`),
            el('p', {}, 'Replace its content with this guide? Confluence keeps the old version in the page history.')),
          { okLabel: 'Replace page' });
          if (ok && open) { await publish(true); return; }
          body.replaceChildren(form);
          publishBtn.classList.remove('hidden');
          cancelBtn.textContent = 'Cancel';
          refresh();
          return;
        }
        if (!open) { toast(`“${guideTitle}” is in Confluence.`); return; }
        const copy = el('button.primary', { type: 'button', onClick: async () => {
          try { await navigator.clipboard.writeText(result.url); toast('Link copied.'); }
          catch { toast('Couldn’t copy the link.', { error: true }); }
        } }, 'Copy link');
        body.replaceChildren(
          el('p.gh-published-title', {}, el('span.gh-published-icon', { 'aria-hidden': 'true' }, '✓'),
            el('strong', {}, result.updated ? `Updated “${result.title}” in Confluence.` : `Published “${result.title}” to Confluence.`)),
          el('code.settings-path.gh-url', { title: result.url }, result.url),
          el('div.row', {}, copy, el('button', { type: 'button', onClick: () => confluenceOpen(api, result.url) }, 'Open in browser')));
        cancelBtn.textContent = 'Done';
      } catch (err) {
        publishing = false;
        if (!open) { toast(`Publishing “${guideTitle}” to Confluence failed: ${err.message}`, { error: true }); return; }
        body.replaceChildren(form);
        publishBtn.classList.remove('hidden');
        cancelBtn.textContent = 'Cancel';
        refresh();
        showError(err.message);
      } finally {
        stop();
      }
    };
    publishBtn.addEventListener('click', () => { void publish(false); });
  });
}
