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

/** The code field for two-step sign-in: digits only, filled in by password managers that know one-time codes. */
function wikiJsCodeInput() {
  return el('input', { type: 'text', inputMode: 'numeric', autocomplete: 'one-time-code', maxLength: 7, spellcheck: false,
    placeholder: '123456', 'aria-label': t('Verification code') });
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
  const address = el('input', { type: 'url', placeholder: 'wiki.example.com', spellcheck: false, 'aria-label': t('Wiki.js site address') });
  const next = el('button.primary', { type: 'button' }, t('Continue'));

  const strategySelect = el('select', { 'aria-label': t('Sign in with') });
  const strategyField = el('label.cloud-field.hidden', {}, el('span', {}, t('Sign in with')), strategySelect);
  const usernameLabel = el('span', {}, t('Username'));
  const username = el('input', { type: 'text', autocomplete: 'username', spellcheck: false, 'aria-label': t('Username') });
  const password = el('input', { type: 'password', autocomplete: 'current-password', 'aria-label': t('Password') });
  const signIn = el('button.primary', { type: 'button' }, t('Sign in'));
  // Shown when Wiki.js asks for a code from the authenticator app.
  const code = wikiJsCodeInput();
  const codeField = el('label.cloud-field.hidden', {}, el('span', {}, t('Verification code')), code);
  const passwordOption = el('div.wikijs-method', {},
    strategyField,
    el('label.cloud-field', {}, usernameLabel, username),
    el('label.cloud-field', {}, el('span', {}, t('Password')), password),
    codeField,
    el('div.row', {}, signIn));
  const noPasswordNote = el('p.muted.hidden', {}, '');

  const apiKey = el('input', { type: 'password', autocomplete: 'off', 'aria-label': t('API key') });
  const connect = el('button', { type: 'button' }, t('Connect'));
  const keyLink = el('button.link', { type: 'button', onClick: () => wikiJsOpen(api, site?.apiKeyUrl) }, t('Open API Access on your wiki'));
  const keyOr = el('p.confluence-or', {}, t('Or use an API key'));
  const keyOption = el('div.wikijs-method', {},
    keyOr,
    el('label.cloud-field', {}, el('span', {}, t('API key')), apiKey),
    el('div.row', {}, connect, keyLink),
    el('p.muted', {}, t('An administrator creates API keys under Administration → API Access, after turning API access on.')));
  const method = el('div.confluence-method.hidden', {}, passwordOption, noPasswordNote, keyOption);
  const signedOut = el('div.cloud-hero', {},
    el('div.cloud-hero-icon', { 'aria-hidden': 'true' }, el('img', { src: WIKIJS_ICON, alt: '' })),
    el('div.cloud-hero-text', {},
      el('strong', {}, t('Publish guides as Wiki.js pages')),
      el('p.muted', {}, t('For Wiki.js 2 sites. StepForge creates or updates one page per guide, with its screenshots in the wiki’s assets.')),
      el('label.cloud-field', {}, el('span', {}, t('Site address')), address),
      el('div.row', {}, next),
      method));

  const chosenStrategy = () => site?.strategies.find((s) => s.key === strategySelect.value) || site?.strategies[0] || null;
  const refreshUsername = () => {
    const email = chosenStrategy()?.usernameType === 'email';
    usernameLabel.textContent = email ? t('Email address') : t('Username');
    username.type = email ? 'email' : 'text';
    username.setAttribute('aria-label', email ? t('Email address') : t('Username'));
  };
  // A different sign-in starts over without the code.
  strategySelect.addEventListener('change', () => { refreshUsername(); askForCode(false); });

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
      : t('This wiki only offers single sign-on, so StepForge can’t sign in with a username and password. Use an API key instead.');
    noPasswordNote.classList.toggle('hidden', Boolean(strategies.length));
    keyOr.textContent = strategies.length ? t('Or use an API key') : t('Use an API key');
    refreshUsername();
    (strategies.length ? username : apiKey).focus?.();
  };
  next.addEventListener('click', () => run(next, t('Checking…'), async () => {
    say('');
    showMethod(await api.wikijs.probe({ address: address.value.trim() }));
  }));
  address.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); next.click(); } });
  address.addEventListener('input', () => { method.classList.add('hidden'); next.classList.remove('hidden'); site = null; askForCode(false); });

  const askForCode = (asking) => {
    codeField.classList.toggle('hidden', !asking);
    signIn.textContent = asking ? t('Verify') : t('Sign in');
    code.value = '';
    if (asking) code.focus?.();
  };
  for (const input of [username, password]) input.addEventListener('input', () => askForCode(false));

  const connected = (status) => {
    password.value = '';
    apiKey.value = '';
    askForCode(false);
    say(status.user ? t('Signed in as {user}.', { user: status.user }) : t('Connected to {host} with an API key.', { host: status.host }), 'success');
    update(status);
  };
  signIn.addEventListener('click', async () => {
    let wantsCode = false;
    await run(signIn, t('Signing in…'), async () => {
      const asking = !codeField.classList.contains('hidden');
      const result = await api.wikijs.connect({ address: address.value.trim(), method: 'password',
        username: username.value.trim(), password: password.value, strategy: chosenStrategy()?.key || '',
        ...(asking ? { code: code.value.trim() } : {}) });
      if (result.needsCode) wantsCode = true;
      else connected(result);
    });
    // Once run() is done: ending the loading state puts the button's earlier label back.
    if (wantsCode && !disposed) {
      askForCode(true);
      say(t('This account uses two-step verification. Enter the 6-digit code from your authenticator app.'));
    }
  });
  code.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); signIn.click(); } });
  password.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); signIn.click(); } });
  connect.addEventListener('click', () => run(connect, t('Connecting…'), async () => {
    connected(await api.wikijs.connect({ address: address.value.trim(), method: 'apikey', apiKey: apiKey.value }));
  }));
  apiKey.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); connect.click(); } });

  /* Signed in: the account. */
  const who = el('strong.cloud-email', {}, '');
  const siteLine = el('span.muted', {}, '');
  const disconnect = el('button', { type: 'button', onClick: () => run(disconnect, t('Signing out…'), async () => {
    update(await api.wikijs.disconnect());
    say(t('Signed out. Pages you published stay on the wiki.'));
  }) }, t('Sign out'));
  const account = el('div.cloud-account', {},
    el('div.cloud-avatar', { 'aria-hidden': 'true' }, el('img', { src: WIKIJS_ICON, alt: '' })),
    el('div.cloud-account-info', {}, who, el('div.cloud-status-line', {}, siteLine)),
    el('div.cloud-account-actions', {}, disconnect));
  // Wiki.js ended a two-step session: a code signs in again.
  const againCode = wikiJsCodeInput();
  const againBtn = el('button.primary', { type: 'button' }, t('Sign in again'));
  const again = el('section.cloud-card.hidden', {},
    el('header.cloud-card-head', {}, el('h4', {}, t('Signed out on the wiki'))),
    el('p.muted', {}, t('Enter the 6-digit code from your authenticator app to sign in again. StepForge asks for this when Wiki.js ends your session, for example after a long break.')),
    el('label.cloud-field', {}, el('span', {}, t('Verification code')), againCode),
    el('div.row', {}, againBtn));
  againBtn.addEventListener('click', () => run(againBtn, t('Signing in…'), async () => {
    const status = await api.wikijs.signInAgain({ code: againCode.value.trim() });
    againCode.value = '';
    say(t('Signed in as {user}.', { user: status.user }), 'success');
    update(status);
  }));
  againCode.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); againBtn.click(); } });
  const usage = el('section.cloud-card', {},
    el('header.cloud-card-head', {}, el('h4', {}, t('Publishing'))),
    el('p.muted', {}, t('Choose Share → Publish to Wiki.js… in a guide. You pick the page’s path when you publish; publishing the guide again updates the same page.')));
  const signedIn = el('div.cloud-stack.hidden', {}, account, again, usage);

  function update(status) {
    current = status || {};
    signedOut.classList.toggle('hidden', Boolean(current.connected));
    signedIn.classList.toggle('hidden', !current.connected);
    if (current.error && !current.connected) say(current.error, 'error');
    if (!current.connected) return;
    who.textContent = current.user || t('API key');
    const how = current.method === 'apikey' ? t('signed in with an API key')
      : current.twoStep ? t('signed in with {method} and two-step verification', { method: current.strategy || t('a password') })
        : t('signed in with {method}', { method: current.strategy || t('a password') });
    siteLine.textContent = `${current.host} · Wiki.js · ${how}`;
    again.classList.toggle('hidden', !current.needsCode);
  }

  const node = el('fieldset.cloud-panel', {}, el('legend', {}, 'Wiki.js'), signedOut, banner, signedIn);
  const stop = api.wikijs.onStatus((status) => { if (!disposed) update(status); });
  api.wikijs.status().then((status) => { if (!disposed) update(status); }).catch((err) => say(err.message, 'error'));
  return { node, dispose() { disposed = true; stop(); if (busy) void api.wikijs.cancel().catch(() => {}); } };
}

const WIKIJS_STAGES = [
  ['check', t('Check for private details')],
  ['export', t('Prepare the page')],
  ['upload', t('Upload screenshots')],
  ['page', t('Save the page')],
];

function wikiJsProgress(guideTitle) {
  const fill = el('span.gh-progress-fill', { style: {} });
  const bar = el('div.gh-progress.indeterminate', { role: 'progressbar', 'aria-label': t('Publishing progress'), 'aria-valuemin': '0', 'aria-valuemax': '100' }, fill);
  const detail = el('span.gh-progress-detail.muted', {}, '');
  const stages = WIKIJS_STAGES.map(([id, label]) => {
    const icon = el('span.gh-stage-icon', { 'aria-hidden': 'true' });
    return { id, icon, node: el('li.gh-stage', {}, icon, el('span.gh-stage-label', {}, label)) };
  });
  const node = el('div.gh-publishing', { role: 'status', 'aria-live': 'polite' },
    el('p', {}, el('strong', {}, t('Publishing “{title}” to Wiki.js', { title: guideTitle }))),
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
    detail.textContent = progress?.stage === 'upload' && progress.index ? t('Screenshot {index} of {count}', { index: progress.index, count: progress.count })
      : progress?.stage === 'upload' ? t('Getting the screenshot folder ready…')
        : progress?.stage === 'check' && progress.total ? t('Screenshot {index} of {count}', { index: progress.done, count: progress.total })
          : progress?.stage === 'page' ? t('Saving the page in Wiki.js…') : t('Building the page from your guide…');
  };
  set({ stage: 'check' });
  return { node, set };
}

/**
 * Wiki.js ended a two-step session: ask for a code and sign in again.
 * Resolves true once signed in, false if the user cancels.
 */
function askWikiJsCode(api) {
  return new Promise((resolve) => {
    const code = wikiJsCodeInput();
    const error = el('p.gh-note.error.hidden', { role: 'alert' }, '');
    const cancel = el('button', { type: 'button', onClick: () => { close(); resolve(false); } }, t('Cancel'));
    const verify = el('button.primary', { type: 'button' }, t('Sign in'));
    const { close } = openModal({
      title: t('Sign in to Wiki.js again'),
      body: el('div.cloud-confirm', {},
        el('p', {}, t('Wiki.js ended your session. Enter the 6-digit code from your authenticator app to sign in again and publish.')),
        el('label.cloud-field', {}, el('span', {}, t('Verification code')), code),
        error),
      footer: [cancel, verify],
      onClose: () => resolve(false),
    });
    let busy = false;
    verify.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      setButtonLoading(verify, true, t('Signing in…'));
      try {
        await api.wikijs.signInAgain({ code: code.value.trim() });
        close();
        resolve(true);
      } catch (err) {
        error.textContent = err.message;
        error.classList.remove('hidden');
        code.value = '';
      } finally {
        busy = false;
        setButtonLoading(verify, false);
      }
    });
    code.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); verify.click(); } });
    code.focus?.();
  });
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
async function showPublishToWikiJsDialog({ api, guideId, guideTitle, onOpenAccounts, onShowFinding }) {
  const status = await api.wikijs.status();
  if (!status.connected) {
    return new Promise((resolve) => {
      const { close } = openModal({
        title: t('Publish to Wiki.js'),
        body: el('div.gh-publish', {},
          el('p', {}, t('Publishing creates a Wiki.js page for this guide, with its screenshots uploaded to the wiki. Publishing again updates the same page.')),
          el('p.muted', {}, status.error || t('To start, connect your wiki in Settings → Accounts → Wiki.js.'))),
        footer: [
          el('button', { type: 'button', onClick: () => { close(); resolve(false); } }, t('Cancel')),
          el('button.primary', { type: 'button', onClick: () => { close(); resolve(false); onOpenAccounts?.(); } }, t('Set up Wiki.js')),
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
    const cancelBtn = el('button', { type: 'button', onClick: () => { close(); finish(); } }, t('Cancel'));
    const publishBtn = el('button.primary', { type: 'button', disabled: true }, t('Publish'));
    const quality = el('div');
    const { close } = openModal({ title: t('Publish to Wiki.js'), body: el('div', {}, quality, body), footer: [cancelBtn, publishBtn], onClose: finish });
    addQualityPanel(api, guideId, quality, (finding) => { close(); finish(); onShowFinding?.(finding); });

    const pathInput = el('input', { type: 'text', spellcheck: false, 'aria-label': t('Page path'), placeholder: 'guides/my-guide' });
    const titleInput = el('input', { type: 'text', 'aria-label': t('Page title'), value: guideTitle });
    const localeInput = el('input.wikijs-locale', { type: 'text', spellcheck: false, 'aria-label': t('Language'), value: 'en' });
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
        ? t('The page will be at {address}, with its screenshots in the asset folder of the same name.', { address: wikiJsAddress(status.host, localeInput.value, pathInput.value) }) : '';
    };
    for (const input of [pathInput, titleInput, localeInput]) input.addEventListener('input', refresh);

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
          el('p.muted', {}, t('These are blurred on the Wiki.js page. Remove any blur that isn’t needed.')),
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

    const form = el('div.gh-publish.wikijs-publish', {},
      el('p', {}, t('Publish “{title}” as a page on {host}, with its screenshots uploaded to the wiki.', { title: guideTitle, host: status.host })),
      previous,
      el('label.gh-field', {}, el('span', {}, t('Path')), pathInput),
      el('label.gh-field', {}, el('span', {}, t('Title')), titleInput),
      el('label.gh-field', {}, el('span', {}, t('Language')), localeInput),
      addressNote,
      privacyBox,
      error);
    body.replaceChildren(form);

    // The guide's page if it has one; otherwise the last folder used.
    Promise.all([api.wikijs.defaults({ guideId }), guideUpdatedTimes(api)]).then(([defaults, updated]) => {
      if (!open) return;
      pathInput.value = defaults.path;
      // The guide's title with its placeholders filled in, unless already edited.
      if (titleInput.value === guideTitle) titleInput.value = defaults.title;
      localeInput.value = defaults.locale || 'en';
      ready = true;
      refresh();
      const page = defaults.published;
      if (!page) return;
      previous.replaceChildren(...fillNodes(t('Published before. Publishing again updates {link}.'), { link: el('button.link', { type: 'button', onClick: () => wikiJsOpen(api, page.url) }, t('the same page')) }),
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
      const progress = wikiJsProgress(guideTitle);
      body.replaceChildren(progress.node);
      publishBtn.classList.add('hidden');
      cancelBtn.textContent = t('Close');
      const stop = api.wikijs.onProgress((update) => { if (update?.guideId === guideId) progress.set(update); });
      try {
        const result = await api.wikijs.publish({ guideId, path: pathInput.value.trim(), title: titleInput.value.trim(), locale: localeInput.value.trim() || 'en', replace });
        changed = true;
        if (result.needsCode) {
          publishing = false;
          if (!open) { toast(t('Wiki.js ended your session. Publish “{title}” again to enter a code from your authenticator app.', { title: guideTitle }), { error: true }); return; }
          if (await askWikiJsCode(api) && open) { await publish(replace); return; }
          backToForm();
          showError(t('Publishing needs a code from your authenticator app. Choose Publish to try again.'));
          return;
        }
        if (result.edited || result.conflict) {
          publishing = false;
          const ok = result.edited
            ? await confirmReplaceEdits(api, result.edited, { where: t('on the wiki'), history: t('Wiki.js keeps the edited version in the page history.') })
            : await confirmDialog(el('div.cloud-confirm', {},
              el('strong', {}, t('A page already exists at {path}. Replace it?', { path: result.conflict.path })),
              el('p', {}, t('“{title}” wasn’t published from this guide. Wiki.js keeps its current version in the page history.', { title: result.conflict.title }))),
            { okLabel: t('Replace page') });
          if (ok && open) { await publish(true); return; }
          backToForm();
          return;
        }
        if (!open) { toast(t('“{title}” is on Wiki.js.', { title: guideTitle })); return; }
        const copy = el('button.primary', { type: 'button', onClick: async () => {
          try { await navigator.clipboard.writeText(result.url); toast(t('Link copied.')); }
          catch { toast(t('Couldn’t copy the link.'), { error: true }); }
        } }, t('Copy link'));
        body.replaceChildren(
          el('p.gh-published-title', {}, el('span.gh-published-icon', { 'aria-hidden': 'true' }, '✓'),
            el('strong', {}, result.updated ? t('Updated “{title}” on Wiki.js.', { title: result.title }) : t('Published “{title}” to Wiki.js.', { title: result.title }))),
          el('code.settings-path.gh-url', { title: result.url }, result.url),
          el('div.row', {}, copy, el('button', { type: 'button', onClick: () => wikiJsOpen(api, result.url) }, t('Open in browser'))));
        cancelBtn.textContent = t('Done');
      } catch (err) {
        if (!open) { toast(t('Publishing “{title}” to Wiki.js failed: {error}', { title: guideTitle, error: err.message }), { error: true }); return; }
        backToForm();
        showError(err.message);
      } finally {
        stop();
      }
    };
    publishBtn.addEventListener('click', () => { void publish(false); });
  });
}
