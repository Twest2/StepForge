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
  const address = el('input', { type: 'url', placeholder: 'confluence.example.com', spellcheck: false, 'aria-label': t('Confluence site address') });
  const next = el('button.primary', { type: 'button' }, t('Continue'));
  const email = el('input', { type: 'email', autocomplete: 'username', spellcheck: false, 'aria-label': t('Atlassian email address') });
  const token = el('input', { type: 'password', autocomplete: 'off', 'aria-label': t('Token') });
  const tokenLabel = el('span', {}, t('Personal access token'));
  const tokenLink = el('button.link', { type: 'button', onClick: () => confluenceOpen(api, site?.tokenUrl) }, t('Create a token'));
  const emailField = el('label.cloud-field.hidden', {}, el('span', {}, t('Email address')), email);
  const connect = el('button.primary', { type: 'button' }, t('Connect'));
  const browser = el('button', { type: 'button' }, t('Sign in with your browser'));
  const browserNote = el('p.muted', {}, t('For single sign-on or a smart card (CAC). If your site asks for your card, insert it first; your computer asks for your PIN.'));
  const browserOption = el('div.confluence-browser', {}, el('p.confluence-or', {}, t('Or')), el('div.row', {}, browser), browserNote);
  const method = el('div.confluence-method.hidden', {},
    emailField,
    el('label.cloud-field', {}, tokenLabel, token),
    el('div.row', {}, connect, tokenLink),
    browserOption);
  const signedOut = el('div.cloud-hero', {},
    el('div.cloud-hero-icon', { 'aria-hidden': 'true' }, el('img', { src: CONFLUENCE_ICON, alt: '' })),
    el('div.cloud-hero-text', {},
      el('strong', {}, t('Publish guides as Confluence pages')),
      el('p.muted', {}, t('Works with Confluence Cloud and with Confluence Data Center or Server sites inside your organization. StepForge creates or updates one page per guide, with its screenshots attached.')),
      el('label.cloud-field', {}, el('span', {}, t('Site address')), address),
      el('div.row', {}, next),
      method));

  const showMethod = (found) => {
    site = found;
    method.classList.remove('hidden');
    emailField.classList.toggle('hidden', !found.cloud);
    tokenLabel.textContent = found.cloud ? t('API token') : t('Personal access token');
    tokenLink.textContent = found.cloud ? t('Create an API token') : t('Create a token on your site');
    browserOption.classList.toggle('hidden', found.cloud);
    next.classList.add('hidden');
    (found.cloud ? email : token).focus?.();
  };
  next.addEventListener('click', () => run(next, t('Checking…'), async () => {
    say('');
    showMethod(await api.confluence.probe({ address: address.value.trim() }));
  }));
  address.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); next.click(); } });
  address.addEventListener('input', () => { method.classList.add('hidden'); next.classList.remove('hidden'); site = null; });
  connect.addEventListener('click', () => run(connect, t('Connecting…'), async () => {
    const status = await api.confluence.connect({ address: address.value.trim(), token: token.value, email: email.value.trim() });
    token.value = '';
    say(t('Connected as {user}. Choose where new pages go.', { user: status.user }), 'success');
    update(status);
  }));
  token.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); connect.click(); } });
  browser.addEventListener('click', () => run(browser, t('Waiting for sign-in…'), async () => {
    say(t('Sign in to Confluence in the window that opened. It closes by itself when you’re signed in.'));
    const status = await api.confluence.connectWithBrowser({ address: address.value.trim() });
    say(t('Connected as {user}. Choose where new pages go.', { user: status.user }), 'success');
    update(status);
  }));

  /* Signed in: the account, and where new pages go. */
  const who = el('strong.cloud-email', {}, '');
  const siteLine = el('span.muted', {}, '');
  const disconnect = el('button', { type: 'button', onClick: () => run(disconnect, t('Disconnecting…'), async () => {
    update(await api.confluence.disconnect());
    say(t('Disconnected. Pages you published stay in Confluence.'));
  }) }, t('Disconnect'));
  const account = el('div.cloud-account', {},
    el('div.cloud-avatar.service-logo', { 'aria-hidden': 'true' }, el('img', { src: CONFLUENCE_ICON, alt: '' })),
    el('div.cloud-account-info', {}, who, el('div.cloud-status-line', {}, siteLine)),
    el('div.cloud-account-actions', {}, disconnect));

  const spaceSelect = el('select', { 'aria-label': t('Space for new pages') }, el('option', { value: '' }, t('Loading spaces…')));
  const parentText = el('span', {}, t('At the top of the space'));
  const parentQuery = el('input', { type: 'search', placeholder: t('Search pages in this space'), 'aria-label': t('Search for a parent page') });
  const parentResults = el('div.confluence-results');
  const topLevel = el('button', { type: 'button' }, t('Top of the space'));
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
        } }, page.title)) : [el('p.muted', {}, t('No matching pages.'))]));
      } catch (err) { say(err.message, 'error'); }
    }, 300);
  });
  const places = el('section.cloud-card', {},
    el('header.cloud-card-head', {}, el('h4', {}, t('Where new pages go'))),
    el('label.gh-field', {}, el('span', {}, t('Space')), spaceSelect),
    el('div.confluence-parent', {}, el('span.muted', {}, t('Parent page:'), ' '), parentText),
    el('div.row', {}, parentQuery, topLevel),
    parentResults,
    el('p.muted', {}, t('You can pick another space or parent page when you publish. Publishing a guide again updates its page.')));
  const signedIn = el('div.cloud-stack.hidden', {}, account, places);

  const loadSpaces = async () => {
    try {
      spaces = await api.confluence.spaces();
      if (disposed) return;
      spaceSelect.replaceChildren(el('option', { value: '' }, spaces.length ? t('Choose a space') : t('No spaces you can add pages to')),
        ...spaces.map((s) => el('option', { value: s.key, selected: s.key === current.space?.key }, `${s.name} (${s.key})`)));
    } catch (err) {
      if (!disposed) { spaceSelect.replaceChildren(el('option', { value: '' }, t('Couldn’t load spaces'))); say(err.message, 'error'); }
    }
  };

  function update(status) {
    const wasConnected = Boolean(current.connected);
    current = status || {};
    signedOut.classList.toggle('hidden', Boolean(current.connected));
    signedIn.classList.toggle('hidden', !current.connected);
    if (current.error && !current.connected) say(current.error, 'error');
    if (!current.connected) return;
    who.textContent = current.user || t('Confluence user');
    const product = current.cloud ? 'Confluence Cloud' : 'Confluence Data Center';
    siteLine.textContent = current.method === 'browser'
      ? t('{host} · {product} · signed in with your browser', { host: current.host, product })
      : `${current.host} · ${product}`;
    parentText.textContent = current.parent ? current.parent.title : t('At the top of the space');
    if (!wasConnected) void loadSpaces();
  }

  const node = el('fieldset.cloud-panel', {}, el('legend', {}, 'Confluence'), signedOut, banner, signedIn);
  const stop = api.confluence.onStatus((status) => { if (!disposed) update(status); });
  api.confluence.status().then((status) => { if (!disposed) update(status); }).catch((err) => say(err.message, 'error'));
  return { node, dispose() { disposed = true; stop(); clearTimeout(searchTimer); if (busy) void api.confluence.cancel().catch(() => {}); } };
}

const CONFLUENCE_STAGES = [
  ['check', t('Check for private details')],
  ['export', t('Prepare the page')],
  ['page', t('Save the page')],
  ['upload', t('Attach screenshots')],
];

function confluenceProgress(guideTitle) {
  const fill = el('span.gh-progress-fill', { style: {} });
  const bar = el('div.gh-progress.indeterminate', { role: 'progressbar', 'aria-label': t('Publishing progress'), 'aria-valuemin': '0', 'aria-valuemax': '100' }, fill);
  const detail = el('span.gh-progress-detail.muted', {}, '');
  const stages = CONFLUENCE_STAGES.map(([id, label]) => {
    const icon = el('span.gh-stage-icon', { 'aria-hidden': 'true' });
    return { id, icon, node: el('li.gh-stage', {}, icon, el('span.gh-stage-label', {}, label)) };
  });
  const node = el('div.gh-publishing', { role: 'status', 'aria-live': 'polite' },
    el('p', {}, el('strong', {}, t('Publishing “{title}” to Confluence', { title: guideTitle }))),
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
    detail.textContent = progress?.stage === 'upload' ? t('Screenshot {index} of {count}', { index: progress.index, count: progress.count })
      : progress?.stage === 'check' && progress.total ? t('Screenshot {index} of {count}', { index: progress.done, count: progress.total })
        : progress?.stage === 'page' ? t('Saving the page in Confluence…') : t('Building the page from your guide…');
  };
  set({ stage: 'check' });
  return { node, set };
}

/**
 * Publish one guide to Confluence. Resolves when the dialog closes, with
 * whether the guide changed (private-detail blurs may have been added).
 */
async function showPublishToConfluenceDialog({ api, guideId, guideTitle, onOpenAccounts, onShowFinding }) {
  const status = await api.confluence.status();
  if (!status.connected) {
    return new Promise((resolve) => {
      const { close } = openModal({
        title: t('Publish to Confluence'),
        body: el('div.gh-publish', {},
          el('p', {}, t('Publishing creates a Confluence page for this guide, with its screenshots attached. Publishing again updates the same page.')),
          el('p.muted', {}, t('To start, connect your Confluence site in Settings → Accounts → Confluence.'))),
        footer: [
          el('button', { type: 'button', onClick: () => { close(); resolve(false); } }, t('Cancel')),
          el('button.primary', { type: 'button', onClick: () => { close(); resolve(false); onOpenAccounts?.(); } }, t('Set up Confluence')),
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
    const { close } = openModal({ title: t('Publish to Confluence'), body: el('div', {}, quality, body), footer: [cancelBtn, publishBtn], onClose: finish });
    addQualityPanel(api, guideId, quality, (finding) => { close(); finish(); onShowFinding?.(finding); });

    const spaceSelect = el('select', { 'aria-label': t('Confluence space') }, el('option', { value: '' }, t('Loading spaces…')));
    let spaces = [];
    const previous = el('div.cloud-banner.hidden', {});
    const error = el('p.gh-note.error.hidden', { role: 'alert' }, '');
    const showError = (message) => { error.textContent = message; error.classList.remove('hidden'); };
    let checking = true;
    const chosenSpace = () => spaces.find((s) => s.key === spaceSelect.value) || null;
    // Publish waits for the guide's last publish, which says where its page is.
    let knownLoaded = false;
    const canPublish = () => Boolean(chosenSpace()) && knownLoaded && !checking && !publishing;

    // Where the page goes. The guide's own page stays where it is unless
    // another parent is picked; StepForge can't move it to the top of a space.
    let known = null;
    let parent = null;
    let picked = false;
    let searchTimer = null;
    let searchRequest = 0;
    const parentText = el('span', {}, '');
    const parentQuery = el('input', { type: 'search', placeholder: t('Search pages in this space'), 'aria-label': t('Search for a parent page') });
    const parentResults = el('div.confluence-results');
    const topLevel = el('button', { type: 'button' }, t('Top of the space'));
    const parentNote = el('p.muted', {}, '');
    const parentPicker = el('div.hidden', {},
      el('div.confluence-parent', {}, el('span.muted', {}, t('Parent page:'), ' '), parentText),
      el('div.row', {}, parentQuery, topLevel),
      parentResults);
    const publishedHere = () => Boolean(known && known.spaceKey === chosenSpace()?.key);
    const defaultParent = (space) => {
      if (!space) return null;
      if (known?.spaceKey === space.key) return known.parent || null;
      return status.space?.key === space.key ? status.parent || null : null;
    };
    const refresh = () => {
      publishBtn.disabled = !canPublish();
      const space = chosenSpace();
      parentPicker.classList.toggle('hidden', !space);
      topLevel.classList.toggle('hidden', publishedHere());
      const stays = publishedHere() && (!parent || parent.id === known.parent?.id);
      parentText.textContent = parent ? parent.title : stays ? t('Where it is now') : t('At the top of the space');
      parentNote.textContent = !space ? ''
        : stays ? t('Publishing again updates the page where it is. Pick another parent page to move it there.')
          : publishedHere() ? t('The page moves under “{parent}”.', { parent: parent.title })
            : parent ? t('The page goes under “{parent}”.', { parent: parent.title }) : t('The page goes at the top of {space}.', { space: space.name });
    };
    const resetParent = () => {
      clearTimeout(searchTimer);
      searchRequest += 1;
      picked = false;
      parent = defaultParent(chosenSpace());
      parentQuery.value = '';
      parentResults.replaceChildren();
      refresh();
    };
    // What loads later (spaces, the guide's last publish) doesn't undo a pick.
    const settleParent = () => (picked ? refresh() : resetParent());
    spaceSelect.addEventListener('change', resetParent);
    topLevel.addEventListener('click', () => { parent = null; picked = true; parentResults.replaceChildren(); refresh(); });
    parentQuery.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(async () => {
        const space = chosenSpace();
        if (!space || !open) return;
        const request = ++searchRequest;
        try {
          const pages = await api.confluence.findPages({ spaceKey: space.key, query: parentQuery.value });
          if (!open || request !== searchRequest) return;
          parentResults.replaceChildren(...(pages.length ? pages.map((page) => el('button.confluence-result', { type: 'button', onClick: () => {
            parent = page;
            picked = true;
            parentQuery.value = '';
            parentResults.replaceChildren();
            refresh();
          } }, page.title)) : [el('p.muted', {}, t('No matching pages.'))]));
        } catch (err) { showError(err.message); }
      }, 300);
    });

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
      const { close: closeReview } = openModal({
        title: t('Private details'),
        body: el('div.privacy-dialog', {},
          el('p.muted', {}, t('These are blurred on the Confluence page. Remove any blur that isn’t needed.')),
          privacyReviewList(api, guideId, review, { onChange: (next) => { changed = true; showReview(next); } })),
        footer: [el('button.primary', { type: 'button', onClick: () => closeReview() }, t('Done'))],
      });
    });
    runPrivacyCheck(api, guideId, (text) => { privacyText.textContent = text; })
      .then(showReview)
      .catch((err) => {
        privacySpinner.classList.add('hidden');
        privacyText.textContent = t('StepForge couldn’t check the screenshots for private details ({error}). Check them yourself before publishing.', { error: err.message });
        privacyBox.classList.add('found');
      })
      .finally(() => { checking = false; refresh(); });

    const form = el('div.gh-publish', {},
      el('p', {}, t('Publish “{title}” as a page on {host}, with its screenshots attached.', { title: guideTitle, host: status.host })),
      previous,
      el('label.gh-field', {}, el('span', {}, t('Space')), spaceSelect),
      parentPicker,
      parentNote,
      privacyBox,
      error);
    body.replaceChildren(form);

    const lastPublish = api.confluence.published({ guideId });
    lastPublish.then((page) => { known = page || null; }, () => {}).finally(() => {
      knownLoaded = true;
      if (open) settleParent();
    });
    Promise.all([lastPublish, guideUpdatedTimes(api)]).then(([page, updated]) => {
      if (!page || !open) return;
      previous.replaceChildren(...fillNodes(t('Published before. Publishing again updates {link}.'), { link: el('button.link', { type: 'button', onClick: () => confluenceOpen(api, page.url) }, t('the same page')) }),
        editedSinceShared(updated.get(guideId), page.publishedAt) ? ` ${t('The guide has changed since you published it.')}` : '');
      previous.classList.remove('hidden');
    }).catch(() => {});
    api.confluence.spaces().then((list) => {
      spaces = list;
      if (!open) return;
      spaceSelect.replaceChildren(el('option', { value: '' }, t('Choose a space')),
        ...list.map((s) => el('option', { value: s.key, selected: s.key === status.space?.key }, `${s.name} (${s.key})`)));
      settleParent();
    }).catch((err) => showError(err.message));

    const publish = async (replace = false) => {
      const space = chosenSpace();
      if (!space || publishing) return;
      publishing = true;
      quality.replaceChildren(); // too late to fix before this publish
      error.classList.add('hidden');
      const progress = confluenceProgress(guideTitle);
      body.replaceChildren(progress.node);
      publishBtn.classList.add('hidden');
      cancelBtn.textContent = t('Close');
      const stop = api.confluence.onProgress((update) => { if (update?.guideId === guideId) progress.set(update); });
      try {
        // parentPicked: only a parent chosen here moves an already-published page.
        const result = await api.confluence.publish({ guideId, space, parent, parentPicked: picked, replace });
        changed = true;
        if (result.edited || result.conflict) {
          publishing = false;
          const ok = result.edited
            ? await confirmReplaceEdits(api, result.edited, { where: t('in Confluence'), history: t('Confluence keeps the edited version in the page history.') })
            : await confirmDialog(el('div.cloud-confirm', {},
              el('strong', {}, t('A page called “{title}” already exists in {space}.', { title: result.conflict.title, space: result.conflict.space })),
              el('p', {}, t('Replace its content with this guide? Confluence keeps the old version in the page history.'))),
            { okLabel: t('Replace page') });
          if (ok && open) { await publish(true); return; }
          body.replaceChildren(form);
          publishBtn.classList.remove('hidden');
          cancelBtn.textContent = t('Cancel');
          refresh();
          return;
        }
        if (!open) { toast(t('“{title}” is in Confluence.', { title: guideTitle })); return; }
        const copy = el('button.primary', { type: 'button', onClick: async () => {
          try { await navigator.clipboard.writeText(result.url); toast(t('Link copied.')); }
          catch { toast(t('Couldn’t copy the link.'), { error: true }); }
        } }, t('Copy link'));
        body.replaceChildren(
          el('p.gh-published-title', {}, el('span.gh-published-icon', { 'aria-hidden': 'true' }, '✓'),
            el('strong', {}, result.updated ? t('Updated “{title}” in Confluence.', { title: result.title }) : t('Published “{title}” to Confluence.', { title: result.title }))),
          el('code.settings-path.gh-url', { title: result.url }, result.url),
          el('div.row', {}, copy, el('button', { type: 'button', onClick: () => confluenceOpen(api, result.url) }, t('Open in browser'))));
        cancelBtn.textContent = t('Done');
      } catch (err) {
        publishing = false;
        if (!open) { toast(t('Publishing “{title}” to Confluence failed: {error}', { title: guideTitle, error: err.message }), { error: true }); return; }
        body.replaceChildren(form);
        publishBtn.classList.remove('hidden');
        cancelBtn.textContent = t('Cancel');
        refresh();
        showError(err.message);
      } finally {
        stop();
      }
    };
    publishBtn.addEventListener('click', () => { void publish(false); });
  });
}
