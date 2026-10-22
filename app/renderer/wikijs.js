'use strict';

/*
 * Wiki.js: Settings → Accounts → Wiki.js, and "Publish to Wiki.js" for one
 * guide. The API key and password stay in the main process (app/wikijs.js);
 * this only sends what the user types to sign in.
 */

const WIKIJS_ICON = '../assets/icons/wikijs.svg';

function wikiJsOpen(api, url) {
  if (url) void api.shell.openExternal({ url }).catch(() => {});
}

function makeWikiJsSettings(api) {
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

  /* Signed out: the site address, then a username and password or an API key. */
  const address = el('input', { type: 'url', placeholder: 'wiki.example.com', spellcheck: false, 'aria-label': 'Wiki.js site address' });
  const next = el('button.primary', { type: 'button' }, 'Continue');

  const strategySelect = el('select', { 'aria-label': 'Sign in with' });
  const strategyField = el('label.cloud-field.hidden', {}, el('span', {}, 'Sign in with'), strategySelect);
  const usernameLabel = el('span', {}, 'Username');
  const username = el('input', { type: 'text', autocomplete: 'username', spellcheck: false, 'aria-label': 'Username' });
  const password = el('input', { type: 'password', autocomplete: 'current-password', 'aria-label': 'Password' });
  const signIn = el('button.primary', { type: 'button' }, 'Sign in');
  const passwordOption = el('div.wikijs-method', {},
    strategyField,
    el('label.cloud-field', {}, usernameLabel, username),
    el('label.cloud-field', {}, el('span', {}, 'Password'), password),
    el('div.row', {}, signIn));
  const noPasswordNote = el('p.muted.hidden', {}, '');

  const apiKey = el('input', { type: 'password', autocomplete: 'off', 'aria-label': 'API key' });
  const connect = el('button', { type: 'button' }, 'Connect');
  const keyLink = el('button.link', { type: 'button', onClick: () => wikiJsOpen(api, site?.apiKeyUrl) }, 'Open API Access on your wiki');
  const keyOr = el('p.confluence-or', {}, 'Or use an API key');
  const keyOption = el('div.wikijs-method', {},
    keyOr,
    el('label.cloud-field', {}, el('span', {}, 'API key'), apiKey),
    el('div.row', {}, connect, keyLink),
    el('p.muted', {}, 'An administrator creates API keys under Administration → API Access, after turning API access on.'));
  const method = el('div.confluence-method.hidden', {}, passwordOption, noPasswordNote, keyOption);
  const signedOut = el('div.cloud-hero', {},
    el('div.cloud-hero-icon', { 'aria-hidden': 'true' }, el('img', { src: WIKIJS_ICON, alt: '' })),
    el('div.cloud-hero-text', {},
      el('strong', {}, 'Publish guides as Wiki.js pages'),
      el('p.muted', {}, 'For Wiki.js 2 sites. StepForge creates or updates one page per guide, with its screenshots in the wiki’s assets.'),
      el('label.cloud-field', {}, el('span', {}, 'Site address'), address),
      el('div.row', {}, next),
      method));

  const chosenStrategy = () => site?.strategies.find((s) => s.key === strategySelect.value) || site?.strategies[0] || null;
  const refreshUsername = () => {
    const email = chosenStrategy()?.usernameType === 'email';
    usernameLabel.textContent = email ? 'Email address' : 'Username';
    username.type = email ? 'email' : 'text';
    username.setAttribute('aria-label', email ? 'Email address' : 'Username');
  };
  strategySelect.addEventListener('change', refreshUsername);

  const showMethod = (found) => {
    site = found;
    method.classList.remove('hidden');
    next.classList.add('hidden');
    const strategies = found.strategies || [];
    // The choice only appears when the wiki offers more than one.
    strategySelect.replaceChildren(...strategies.map((s) => el('option', { value: s.key }, s.name)));
    strategyField.classList.toggle('hidden', strategies.length < 2);
    passwordOption.classList.toggle('hidden', !strategies.length);
    noPasswordNote.textContent = strategies.length ? ''
      : 'This wiki only offers single sign-on, so StepForge can’t sign in with a username and password. Use an API key instead.';
    noPasswordNote.classList.toggle('hidden', Boolean(strategies.length));
    keyOr.textContent = strategies.length ? 'Or use an API key' : 'Use an API key';
    refreshUsername();
    (strategies.length ? username : apiKey).focus?.();
  };
  next.addEventListener('click', () => run(next, 'Checking…', async () => {
    say('');
    showMethod(await api.wikijs.probe({ address: address.value.trim() }));
  }));
  address.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); next.click(); } });
  address.addEventListener('input', () => { method.classList.add('hidden'); next.classList.remove('hidden'); site = null; });

  const connected = (status) => {
    password.value = '';
    apiKey.value = '';
    say(status.user ? `Signed in as ${status.user}.` : `Connected to ${status.host} with an API key.`, 'success');
    update(status);
  };
  signIn.addEventListener('click', () => run(signIn, 'Signing in…', async () => {
    connected(await api.wikijs.connect({ address: address.value.trim(), method: 'password',
      username: username.value.trim(), password: password.value, strategy: chosenStrategy()?.key || '' }));
  }));
  password.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); signIn.click(); } });
  connect.addEventListener('click', () => run(connect, 'Connecting…', async () => {
    connected(await api.wikijs.connect({ address: address.value.trim(), method: 'apikey', apiKey: apiKey.value }));
  }));
  apiKey.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); connect.click(); } });

  /* Signed in: the account. */
  const who = el('strong.cloud-email', {}, '');
  const siteLine = el('span.muted', {}, '');
  const disconnect = el('button', { type: 'button', onClick: () => run(disconnect, 'Signing out…', async () => {
    update(await api.wikijs.disconnect());
    say('Signed out. Pages you published stay on the wiki.');
  }) }, 'Sign out');
  const account = el('div.cloud-account', {},
    el('div.cloud-avatar', { 'aria-hidden': 'true' }, el('img', { src: WIKIJS_ICON, alt: '' })),
    el('div.cloud-account-info', {}, who, el('div.cloud-status-line', {}, siteLine)),
    el('div.cloud-account-actions', {}, disconnect));
  const usage = el('section.cloud-card', {},
    el('header.cloud-card-head', {}, el('h4', {}, 'Publishing')),
    el('p.muted', {}, 'Choose Share → Publish to Wiki.js… in a guide. You pick the page’s path when you publish; publishing the guide again updates the same page.'));
  const signedIn = el('div.cloud-stack.hidden', {}, account, usage);

  function update(status) {
    current = status || {};
    signedOut.classList.toggle('hidden', Boolean(current.connected));
    signedIn.classList.toggle('hidden', !current.connected);
    if (current.error && !current.connected) say(current.error, 'error');
    if (!current.connected) return;
    who.textContent = current.user || 'API key';
    siteLine.textContent = `${current.host} · Wiki.js · ${current.method === 'apikey' ? 'signed in with an API key' : `signed in with ${current.strategy || 'a password'}`}`;
  }

  const node = el('fieldset.cloud-panel', {}, el('legend', {}, 'Wiki.js'), signedOut, banner, signedIn);
  const stop = api.wikijs.onStatus((status) => { if (!disposed) update(status); });
  api.wikijs.status().then((status) => { if (!disposed) update(status); }).catch((err) => say(err.message, 'error'));
  return { node, dispose() { disposed = true; stop(); if (busy) void api.wikijs.cancel().catch(() => {}); } };
}

const WIKIJS_STAGES = [
  ['check', 'Check for private details'],
  ['export', 'Prepare the page'],
  ['upload', 'Upload screenshots'],
  ['page', 'Save the page'],
];

function wikiJsProgress(guideTitle) {
  const fill = el('span.gh-progress-fill', { style: {} });
  const bar = el('div.gh-progress.indeterminate', { role: 'progressbar', 'aria-label': 'Publishing progress', 'aria-valuemin': '0', 'aria-valuemax': '100' }, fill);
  const detail = el('span.gh-progress-detail.muted', {}, '');
  const stages = WIKIJS_STAGES.map(([id, label]) => {
    const icon = el('span.gh-stage-icon', { 'aria-hidden': 'true' });
    return { id, icon, node: el('li.gh-stage', {}, icon, el('span.gh-stage-label', {}, label)) };
  });
  const node = el('div.gh-publishing', { role: 'status', 'aria-live': 'polite' },
    el('p', {}, el('strong', {}, `Publishing “${guideTitle}” to Wiki.js`)),
    el('ol.gh-stages', {}, ...stages.map((s) => s.node)),
    el('div.gh-upload', {}, bar, detail));
  const set = (progress) => {
    const at = Math.max(0, WIKIJS_STAGES.findIndex(([id]) => id === progress?.stage));
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
    detail.textContent = progress?.stage === 'upload' && progress.index ? `Screenshot ${progress.index} of ${progress.count}`
      : progress?.stage === 'upload' ? 'Getting the screenshot folder ready…'
        : progress?.stage === 'check' && progress.total ? `Screenshot ${progress.done} of ${progress.total}`
          : progress?.stage === 'page' ? 'Saving the page in Wiki.js…' : 'Building the page from your guide…';
  };
  set({ stage: 'check' });
  return { node, set };
}

/** Where a page will be: the site, language and path, as Wiki.js shows them. */
function wikiJsAddress(site, locale, path) {
  const clean = String(path || '').trim().replace(/^\/+|\/+$/g, '');
  return `${String(site || '').replace(/^https?:\/\//, '')}/${(locale || 'en').trim() || 'en'}/${clean}`;
}

/**
 * Publish one guide to Wiki.js. Resolves when the dialog closes, with
 * whether the guide changed (private-detail blurs may have been added).
 */
async function showPublishToWikiJsDialog({ api, guideId, guideTitle, onOpenAccounts }) {
  const status = await api.wikijs.status();
  if (!status.connected) {
    return new Promise((resolve) => {
      const { close } = openModal({
        title: 'Publish to Wiki.js',
        body: el('div.gh-publish', {},
          el('p', {}, 'Publishing creates a Wiki.js page for this guide, with its screenshots uploaded to the wiki. Publishing again updates the same page.'),
          el('p.muted', {}, status.error || 'To start, connect your wiki in Settings → Accounts → Wiki.js.')),
        footer: [
          el('button', { type: 'button', onClick: () => { close(); resolve(false); } }, 'Cancel'),
          el('button.primary', { type: 'button', onClick: () => { close(); resolve(false); onOpenAccounts?.(); } }, 'Set up Wiki.js'),
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
    const body = el('div.gh-publish.wikijs-publish');
    const cancelBtn = el('button', { type: 'button', onClick: () => { close(); finish(); } }, 'Cancel');
    const publishBtn = el('button.primary', { type: 'button', disabled: true }, 'Publish');
    const { close } = openModal({ title: 'Publish to Wiki.js', body, footer: [cancelBtn, publishBtn], onClose: finish });

    const pathInput = el('input', { type: 'text', spellcheck: false, 'aria-label': 'Page path', placeholder: 'guides/my-guide' });
    const titleInput = el('input', { type: 'text', 'aria-label': 'Page title', value: guideTitle });
    const localeInput = el('input.wikijs-locale', { type: 'text', spellcheck: false, 'aria-label': 'Language', value: 'en' });
    const addressNote = el('p.muted.wikijs-address', {}, '');
    const previous = el('div.cloud-banner.hidden', {});
    const error = el('p.gh-note.error.hidden', { role: 'alert' }, '');
    const showError = (message) => { error.textContent = message; error.classList.remove('hidden'); };
    let checking = true;
    let ready = false;
    const canPublish = () => ready && !checking && !publishing && Boolean(pathInput.value.trim()) && Boolean(titleInput.value.trim());
    const refresh = () => {
      publishBtn.disabled = !canPublish();
      addressNote.textContent = pathInput.value.trim()
        ? `The page will be at ${wikiJsAddress(status.host, localeInput.value, pathInput.value)}, with its screenshots in the asset folder of the same name.` : '';
    };
    for (const input of [pathInput, titleInput, localeInput]) input.addEventListener('input', refresh);

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
          el('p.muted', {}, 'These are blurred on the Wiki.js page. Remove any blur that isn’t needed.'),
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

    const form = el('div.gh-publish.wikijs-publish', {},
      el('p', {}, `Publish “${guideTitle}” as a page on ${status.host}, with its screenshots uploaded to the wiki.`),
      previous,
      el('label.gh-field', {}, el('span', {}, 'Path'), pathInput),
      el('label.gh-field', {}, el('span', {}, 'Title'), titleInput),
      el('label.gh-field', {}, el('span', {}, 'Language'), localeInput),
      addressNote,
      privacyBox,
      error);
    body.replaceChildren(form);

    // The guide's page if it has one; otherwise the last folder used.
    Promise.all([api.wikijs.defaults({ guideId }), guideUpdatedTimes(api)]).then(([defaults, updated]) => {
      if (!open) return;
      pathInput.value = defaults.path;
      localeInput.value = defaults.locale || 'en';
      ready = true;
      refresh();
      const page = defaults.published;
      if (!page) return;
      previous.replaceChildren('Published before. Publishing again updates ', el('button.link', { type: 'button', onClick: () => wikiJsOpen(api, page.url) }, 'the same page'), '.',
        editedSinceShared(updated.get(guideId), page.publishedAt) ? ' The guide has changed since you published it.' : '');
      previous.classList.remove('hidden');
    }).catch((err) => showError(err.message));

    const backToForm = () => {
      publishing = false;
      body.replaceChildren(form);
      publishBtn.classList.remove('hidden');
      cancelBtn.textContent = 'Cancel';
      refresh();
    };
    const publish = async (replace = false) => {
      if (!canPublish() && !replace) return;
      publishing = true;
      error.classList.add('hidden');
      const progress = wikiJsProgress(guideTitle);
      body.replaceChildren(progress.node);
      publishBtn.classList.add('hidden');
      cancelBtn.textContent = 'Close';
      const stop = api.wikijs.onProgress((update) => { if (update?.guideId === guideId) progress.set(update); });
      try {
        const result = await api.wikijs.publish({ guideId, path: pathInput.value.trim(), title: titleInput.value.trim(), locale: localeInput.value.trim() || 'en', replace });
        changed = true;
        if (result.edited || result.conflict) {
          publishing = false;
          const ok = result.edited
            ? await confirmReplaceEdits(api, result.edited, { where: 'on the wiki', history: 'Wiki.js keeps the edited version in the page history.' })
            : await confirmDialog(el('div.cloud-confirm', {},
              el('strong', {}, `A page already exists at ${result.conflict.path}. Replace it?`),
              el('p', {}, `“${result.conflict.title}” wasn’t published from this guide. Wiki.js keeps its current version in the page history.`)),
            { okLabel: 'Replace page' });
          if (ok && open) { await publish(true); return; }
          backToForm();
          return;
        }
        if (!open) { toast(`“${guideTitle}” is on Wiki.js.`); return; }
        const copy = el('button.primary', { type: 'button', onClick: async () => {
          try { await navigator.clipboard.writeText(result.url); toast('Link copied.'); }
          catch { toast('Couldn’t copy the link.', { error: true }); }
        } }, 'Copy link');
        body.replaceChildren(
          el('p.gh-published-title', {}, el('span.gh-published-icon', { 'aria-hidden': 'true' }, '✓'),
            el('strong', {}, result.updated ? `Updated “${result.title}” on Wiki.js.` : `Published “${result.title}” to Wiki.js.`)),
          el('code.settings-path.gh-url', { title: result.url }, result.url),
          el('div.row', {}, copy, el('button', { type: 'button', onClick: () => wikiJsOpen(api, result.url) }, 'Open in browser')));
        cancelBtn.textContent = 'Done';
      } catch (err) {
        if (!open) { toast(`Publishing “${guideTitle}” to Wiki.js failed: ${err.message}`, { error: true }); return; }
        backToForm();
        showError(err.message);
      } finally {
        stop();
      }
    };
    publishBtn.addEventListener('click', () => { void publish(false); });
  });
}
