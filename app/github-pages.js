'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteFileSync } = require('../core/util');
const { progressBody } = require('../core/transfer-meter');
const site = require('../core/pages-site');

/*
 * Temporary guide sharing on GitHub Pages, in a repository the user owns.
 *
 * Sign-in uses the GitHub App device flow: StepForge shows a short code, the
 * user enters it on github.com, and GitHub hands back a user token. There is
 * no client secret and no local callback server. The token is limited to the
 * repositories the user installed the StepForge GitHub App on, and to the
 * App's permissions (Contents, Pages and Workflows: read and write).
 *
 * The App's client ID and slug are public identifiers, not secrets, so
 * releases keep them in github-app-config.json. A source checkout can supply
 * them through the environment or a gitignored github-app.local.json.
 */

const LOCAL_APP_FILE = path.join(__dirname, '..', 'github-app.local.json');
const API = 'https://api.github.com';
const LOGIN = 'https://github.com/login';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const CLIENT_ID_PATTERN = /^Iv[A-Za-z0-9._-]{6,}$/;
const APP_SLUG_PATTERN = /^[a-z0-9-]{1,100}$/;
const SIGN_IN_EXPIRED = 'Your GitHub sign-in has expired or was revoked. Sign in again to keep sharing guides.';
const SIGN_IN_CANCELLED = 'GitHub sign-in cancelled.';
// Uploads get at least this long, and more for big guides on slow links.
const MIN_UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const MIN_UPLOAD_BYTES_PER_SECOND = 64 * 1024;

function resolveAppConfig({ committed = require('./github-app-config.json'), env = process.env, localFile = LOCAL_APP_FILE } = {}) {
  const pick = (value) => String(value || '').trim();
  if (committed.clientId) return { clientId: pick(committed.clientId), appSlug: pick(committed.appSlug), source: 'release' };
  if (env.STEPFORGE_GITHUB_CLIENT_ID) {
    return { clientId: pick(env.STEPFORGE_GITHUB_CLIENT_ID), appSlug: pick(env.STEPFORGE_GITHUB_APP_SLUG), source: 'environment' };
  }
  try {
    const local = JSON.parse(fs.readFileSync(localFile, 'utf8'));
    return { clientId: pick(local.clientId), appSlug: pick(local.appSlug), source: 'local' };
  } catch {
    return { clientId: '', appSlug: '', source: 'none' };
  }
}

const GITHUB_APP = resolveAppConfig();

const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const OWNER_NAME = /^[A-Za-z0-9-]{1,39}$/;

function parseFullName(fullName) {
  const [owner, name, extra] = String(fullName || '').split('/');
  return extra === undefined && OWNER_NAME.test(owner || '') && REPO_NAME.test(name || '') ? { owner, name } : null;
}

// GitHub answers 409 for Git data requests in a repository with no commits.
function isEmptyRepository(err) {
  return err?.status === 409;
}

// Git object ids from API responses end up in request paths; accept only hex.
function objectId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(value)) throw new Error('GitHub returned an unexpected object id.');
  return value;
}

class GitHubError extends Error {
  // `transient` marks failures worth trying again: no connection, a timeout,
  // or GitHub having a bad moment (5xx).
  constructor(message, status = 0, { transient = false } = {}) {
    super(message);
    this.status = status;
    this.transient = transient;
  }
}

class GitHubPages {
  constructor({
    directory,
    safeStorage,
    openExternal,
    clientId = GITHUB_APP.clientId,
    appSlug = GITHUB_APP.appSlug,
    fetchImpl = globalThis.fetch,
    now = Date.now,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onStatus = () => {},
    copyText = null,
  }) {
    this.file = path.join(directory, 'github.credentials');
    this.clientId = clientId;
    this.appSlug = appSlug;
    this.available = CLIENT_ID_PATTERN.test(clientId || '') && APP_SLUG_PATTERN.test(appSlug || '');
    this.safeStorage = safeStorage;
    this.openExternal = openExternal;
    this.fetch = fetchImpl;
    this.now = now;
    this.wait = wait;
    this.onStatus = onStatus;
    this.copyText = copyText;

    this.credentials = null;
    this.loadError = null;
    this.pending = null;
    this.signIn = null;
    this.controllers = new Set();
    this.generation = 0;
    this.queue = Promise.resolve();
    this.loadFile();
  }

  // ---- stored sign-in ------------------------------------------------------

  loadFile() {
    try {
      if (!fs.existsSync(this.file)) return;
      this.requireEncryption();
      const stored = JSON.parse(this.safeStorage.decryptString(fs.readFileSync(this.file)));
      if (this.available && stored.clientId === this.clientId && stored.access_token) {
        this.credentials = stored;
        this.loadError = null;
      } else {
        this.loadError = 'Sign in to GitHub again to connect this version of StepForge.';
      }
    } catch {
      this.loadError = 'StepForge couldn’t unlock your saved GitHub sign-in. Sign in to GitHub again.';
    }
  }

  requireEncryption() {
    if (!this.safeStorage.isEncryptionAvailable() || this.safeStorage.getSelectedStorageBackend?.() === 'basic_text') {
      throw new Error('GitHub sign-in requires an operating-system credential store. Unlock your keyring and restart StepForge.');
    }
  }

  save() {
    this.requireEncryption();
    atomicWriteFileSync(this.file, this.safeStorage.encryptString(JSON.stringify(this.credentials)));
    this.loadError = null;
  }

  links() {
    return {
      newRepository: 'https://github.com/new?name=stepforge-guides&visibility=public&description=Guides%20shared%20from%20StepForge',
      install: this.appSlug ? `https://github.com/apps/${this.appSlug}/installations/new` : '',
      authorizations: 'https://github.com/settings/apps/authorizations',
      pagesSettings: this.credentials?.repo ? `https://github.com/${this.credentials.repo.owner}/${this.credentials.repo.name}/settings/pages` : '',
      repository: this.credentials?.repo ? `https://github.com/${this.credentials.repo.owner}/${this.credentials.repo.name}` : '',
    };
  }

  status() {
    const credentials = this.credentials;
    const repo = credentials?.repo || null;
    return {
      available: this.available,
      connected: Boolean(credentials?.access_token),
      needsSignIn: Boolean(credentials?.reauth),
      login: credentials?.login || '',
      repo: repo ? `${repo.owner}/${repo.name}` : '',
      repoPrivate: Boolean(repo?.private),
      siteUrl: repo?.siteUrl || '',
      pagesReady: Boolean(repo?.pagesReady),
      autoExpire: Boolean(repo?.autoExpire),
      setupNote: repo?.setupNote || '',
      pending: this.pending ? { ...this.pending } : null,
      error: this.loadError || (credentials?.reauth ? SIGN_IN_EXPIRED : null),
      links: this.links(),
      expiryDays: [...site.EXPIRY_DAYS],
      defaultExpiryDays: site.DEFAULT_EXPIRY_DAYS,
    };
  }

  publishStatus() {
    this.onStatus(this.status());
  }

  /** Stop everything: the sign-in and any request in flight. */
  cancel() {
    this.generation += 1;
    this.cancelSignIn();
    for (const controller of this.controllers) controller.abort();
  }

  /** Stop only a sign-in that is waiting for approval. Publishing carries on. */
  cancelSignIn() {
    this.signIn?.cancel();
  }

  disconnect() {
    this.cancel();
    this.credentials = null;
    this.loadError = null;
    this.pending = null;
    fs.rmSync(this.file, { force: true });
    this.publishStatus();
  }

  // ---- HTTP -----------------------------------------------------------------

  /**
   * One HTTPS request. `signal` cancels it from outside; `onProgress(sent)`
   * streams a Buffer body and reports how much of it has been sent.
   */
  async request(url, { method = 'GET', headers = {}, body, timeoutMs = 60000, raw = false, signal = null, onProgress = null } = {}) {
    const controller = new AbortController();
    this.controllers.add(controller);
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
    const stop = () => controller.abort();
    signal?.addEventListener('abort', stop);
    if (signal?.aborted) controller.abort();
    try {
      const init = { method, headers: { 'User-Agent': 'StepForge', ...headers }, body, signal: controller.signal, redirect: 'error' };
      if (onProgress && Buffer.isBuffer(body)) {
        init.body = progressBody(body, onProgress);
        init.duplex = 'half';
        init.headers['Content-Length'] = String(body.length);
      }
      let response;
      try {
        response = await this.fetch(url, init);
      } catch (err) {
        // fetch() rejects with a TypeError when there is no connection at all.
        if (err?.name === 'TypeError' && !controller.signal.aborted) {
          throw new GitHubError('StepForge couldn’t reach GitHub. Check your internet connection and try again.', 0, { transient: true });
        }
        throw err;
      }
      const declared = Number(response.headers?.get?.('content-length'));
      if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new GitHubError('GitHub sent an unexpectedly large response.');
      const text = response.status === 204 ? '' : await response.text();
      if (text.length > MAX_RESPONSE_BYTES) throw new GitHubError('GitHub sent an unexpectedly large response.');
      let data = null;
      if (text && !raw) { try { data = JSON.parse(text); } catch { data = null; } }
      if (!response.ok) {
        const detail = typeof data?.message === 'string' ? data.message.slice(0, 200) : '';
        throw new GitHubError(`GitHub request failed (${response.status}${detail ? `: ${detail}` : ''}).`, response.status,
          { transient: response.status >= 500 });
      }
      return raw ? text : data;
    } catch (err) {
      if (controller.signal.aborted && err.name === 'AbortError') {
        if (timedOut) throw new GitHubError('GitHub took too long to answer. Try again.', 0, { transient: true });
        throw new GitHubError('GitHub request was cancelled. Nothing on this computer changed.');
      }
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', stop);
      this.controllers.delete(controller);
    }
  }

  // github.com's OAuth endpoints answer 200 with an `error` field.
  async loginRequest(pathname, params, signal = null) {
    return this.request(`${LOGIN}/${pathname}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal,
    });
  }

  storeTokens(tokens, base = {}) {
    const now = this.now();
    return {
      ...base,
      clientId: this.clientId,
      access_token: tokens.access_token,
      // Absent when the App has user-token expiry turned off.
      expiresAt: tokens.expires_in ? now + Number(tokens.expires_in) * 1000 : null,
      refresh_token: tokens.refresh_token || null,
      refreshExpiresAt: tokens.refresh_token_expires_in ? now + Number(tokens.refresh_token_expires_in) * 1000 : null,
    };
  }

  /**
   * Sign in with the device flow. Starting again replaces a sign-in that is
   * still waiting, and an expired sign-in can be renewed without losing the
   * chosen repository.
   */
  async connect() {
    if (!this.available) throw new Error('GitHub sign-in is unavailable in this build of StepForge.');
    if (this.credentials?.access_token && !this.credentials.reauth) throw new Error('Disconnect the current GitHub account before signing in with another one.');
    this.requireEncryption();
    this.cancelSignIn();
    const generation = this.generation;
    const controller = new AbortController();
    let wake;
    const woken = new Promise((resolve) => { wake = resolve; });
    const attempt = { cancel: () => { controller.abort(); wake(); } };
    this.signIn = attempt;
    const { signal } = controller;
    const stopped = () => signal.aborted || generation !== this.generation;
    try {
      const device = await this.loginRequest('device/code', { client_id: this.clientId }, signal);
      if (device?.error === 'device_flow_disabled') throw new Error('GitHub sign-in isn’t turned on for this StepForge GitHub App. Its maintainer needs to enable Device Flow.');
      if (!device?.device_code || !device.user_code) throw new Error('GitHub didn’t start the sign-in. Try again.');
      const verificationUri = device.verification_uri === 'https://github.com/login/device' ? device.verification_uri : 'https://github.com/login/device';
      const userCode = String(device.user_code).slice(0, 20);
      let copied = false;
      try { if (this.copyText) { this.copyText(userCode); copied = true; } } catch { /* the code is still shown */ }
      if (stopped()) throw new Error(SIGN_IN_CANCELLED);
      this.pending = { userCode, verificationUri, copied };
      this.publishStatus();
      // Never wait for the browser. On some systems opening a URL only
      // returns once the browser closes, which held up the whole sign-in.
      Promise.resolve().then(() => this.openExternal(verificationUri)).catch(() => {});
      const deadline = this.now() + Math.min(Number(device.expires_in) || 900, 900) * 1000;
      let interval = Math.max(Number(device.interval) || 5, 5) * 1000;
      let tokens;
      for (;;) {
        await Promise.race([this.wait(interval), woken]);
        if (stopped()) throw new Error(SIGN_IN_CANCELLED);
        if (this.now() > deadline) throw new Error('The GitHub sign-in code expired. Choose Sign in with GitHub to get a new one.');
        try {
          tokens = await this.loginRequest('oauth/access_token', { client_id: this.clientId, device_code: device.device_code, grant_type: DEVICE_GRANT }, signal);
        } catch (err) {
          if (stopped()) throw new Error(SIGN_IN_CANCELLED);
          // A dropped connection or a GitHub hiccup shouldn't end the sign-in.
          if (err.transient) continue;
          throw err;
        }
        if (stopped()) throw new Error(SIGN_IN_CANCELLED);
        if (tokens?.access_token) break;
        if (tokens?.error === 'authorization_pending') continue;
        if (tokens?.error === 'slow_down') { interval = Math.max(interval + 5000, (Number(tokens.interval) || 0) * 1000); continue; }
        if (tokens?.error === 'access_denied') throw new Error('GitHub sign-in was cancelled on github.com.');
        if (tokens?.error === 'expired_token') throw new Error('The GitHub sign-in code expired. Choose Sign in with GitHub to get a new one.');
        throw new Error(`GitHub sign-in failed${tokens?.error ? ` (${String(tokens.error).slice(0, 60)})` : ''}.`);
      }
      const next = this.storeTokens(tokens);
      const user = await this.request(`${API}/user`, {
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${next.access_token}`, 'X-GitHub-Api-Version': '2022-11-28' },
        signal,
      });
      if (stopped()) throw new Error(SIGN_IN_CANCELLED);
      next.login = String(user?.login || '').slice(0, 39);
      // Signing in again as the same person keeps the repository they chose.
      const previous = this.credentials;
      if (previous?.repo && previous.login && previous.login.toLowerCase() === next.login.toLowerCase()) next.repo = previous.repo;
      this.credentials = next;
      this.save();
      this.pending = null;
      return this.status();
    } catch (err) {
      if (signal.aborted && !(err instanceof GitHubError && err.status)) throw new Error(SIGN_IN_CANCELLED);
      throw err;
    } finally {
      if (this.signIn === attempt) {
        this.signIn = null;
        this.pending = null;
        this.publishStatus();
      }
    }
  }

  /** The stored token stopped working and couldn't be renewed. */
  signInExpired() {
    if (!this.credentials || this.credentials.reauth) return;
    this.credentials.reauth = true;
    try { this.save(); } catch { /* still flagged for this session */ }
    this.publishStatus();
  }

  async accessToken(force = false) {
    const credentials = this.credentials;
    if (!credentials?.access_token) throw new Error(this.loadError || 'Sign in to GitHub first.');
    if (credentials.reauth) throw new GitHubError(SIGN_IN_EXPIRED, 401);
    const fresh = !credentials.expiresAt || credentials.expiresAt > this.now() + 60000;
    if (!force && fresh) return credentials.access_token;
    if (!credentials.refresh_token) {
      if (!force) return credentials.access_token;
      throw new GitHubError(SIGN_IN_EXPIRED, 401);
    }
    this.refreshing ||= (async () => {
      // Device-flow tokens refresh without a client secret.
      const tokens = await this.loginRequest('oauth/access_token', {
        client_id: this.clientId, grant_type: 'refresh_token', refresh_token: credentials.refresh_token,
      });
      if (!tokens?.access_token) throw new GitHubError(SIGN_IN_EXPIRED, 401);
      if (this.credentials !== credentials) throw new Error('GitHub account changed during sign-in.');
      this.credentials = this.storeTokens(tokens, credentials);
      this.save();
      return this.credentials.access_token;
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async api(method, pathname, body, { raw = false, accept = 'application/vnd.github+json', timeoutMs, onProgress = null } = {}) {
    const generation = this.generation;
    let payload;
    if (body !== undefined) payload = onProgress ? Buffer.from(JSON.stringify(body)) : JSON.stringify(body);
    const send = async (token) => {
      if (generation !== this.generation) throw new Error('GitHub request cancelled.');
      return this.request(`${API}${pathname}`, {
        method,
        raw,
        timeoutMs,
        headers: {
          Accept: accept,
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: payload,
        onProgress: onProgress && ((sent) => onProgress(sent, payload.length)),
      });
    };
    try {
      return await send(await this.accessToken());
    } catch (err) {
      if (err.status !== 401) throw err;
      try {
        return await send(await this.accessToken(true));
      } catch (retry) {
        if (retry.status === 401) {
          this.signInExpired();
          throw new GitHubError(SIGN_IN_EXPIRED, 401);
        }
        throw retry;
      }
    }
  }

  async optional(method, pathname, body, options) {
    try { return await this.api(method, pathname, body, options); } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }
  }

  // Serialize repository writes so two publishes never race each other.
  exclusive(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  // ---- repository -----------------------------------------------------------

  /** Repositories the StepForge App is installed on that this user can reach. */
  async repositories() {
    const installations = await this.api('GET', '/user/installations?per_page=100');
    const repos = [];
    for (const installation of installations?.installations || []) {
      if (installation.app_slug && installation.app_slug !== this.appSlug) continue;
      const page = await this.api('GET', `/user/installations/${encodeURIComponent(installation.id)}/repositories?per_page=100`);
      for (const repo of page?.repositories || []) {
        const parsed = parseFullName(repo.full_name);
        if (parsed) repos.push({ fullName: repo.full_name, private: Boolean(repo.private) });
      }
    }
    return repos.sort((a, b) => a.fullName.localeCompare(b.fullName));
  }

  repoPath(suffix = '', repo = this.credentials?.repo) {
    if (!repo) throw new Error('Choose a GitHub repository for shared guides first.');
    return `/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}${suffix}`;
  }

  accessHint(err) {
    if (err.status === 403 || err.status === 404) {
      return new GitHubError(`StepForge can't change ${this.status().repo}. Check that the StepForge GitHub App is installed on it with every permission it asks for.`, err.status);
    }
    return err;
  }

  /**
   * Choose the repository for shared guides. A new (or nearly empty)
   * repository is used straight away. A repository with other work in it
   * needs `useExisting` after the user has seen what StepForge will change,
   * and is refused outright if StepForge would overwrite its Pages site.
   */
  async selectRepository({ fullName, useExisting = false, onProgress = null }) {
    const parsed = parseFullName(fullName);
    if (!parsed) throw new Error('Choose a repository from the list.');
    const allowed = await this.repositories();
    const match = allowed.find((repo) => repo.fullName.toLowerCase() === fullName.toLowerCase());
    if (!match) throw new Error(`StepForge isn't installed on ${fullName}. Install the StepForge GitHub App on it first.`);
    const [owner, name] = match.fullName.split('/');
    const candidate = { owner, name, private: match.private };
    onProgress?.({ task: 'setup', message: `Checking ${match.fullName}…` });
    let inspection;
    try { inspection = await this.inspectRepository(candidate); } catch (err) {
      if (err.status === 403 || err.status === 404) {
        throw new GitHubError(`StepForge can't read ${match.fullName}. Check that the StepForge GitHub App is installed on it with every permission it asks for.`, err.status);
      }
      throw err;
    }
    if (inspection.conflict) throw new Error(inspection.conflict);
    if (!inspection.fresh && !inspection.ownSite && !useExisting) {
      return {
        needsConfirmation: true,
        repo: match.fullName,
        changes: [
          `Add ${site.WORKFLOW_PATH} to the ${inspection.defaultBranch} branch. It removes shared guides when they expire.`,
          `Create a ${site.PAGES_BRANCH} branch for the shared guides and turn on GitHub Pages for it.`,
        ],
      };
    }
    this.credentials.repo = candidate;
    this.save();
    return this.setup({ onProgress });
  }

  /**
   * Look at a repository before using it. `fresh` means empty or holding only
   * the files GitHub offers when creating a repository; `ownSite` means its
   * Pages branch was made by StepForge; `conflict` explains why StepForge
   * must not use it (it would replace someone's existing Pages site).
   */
  async inspectRepository(repo) {
    const fullName = `${repo.owner}/${repo.name}`;
    const info = await this.api('GET', this.repoPath('', repo));
    const defaultBranch = String(info?.default_branch || 'main');
    const result = { defaultBranch, fresh: true, ownSite: false, conflict: '' };

    let pagesRef;
    try {
      pagesRef = await this.optional('GET', this.repoPath(`/git/ref/heads/${site.PAGES_BRANCH}`, repo));
    } catch (err) {
      // An empty repository has no Git data yet, and GitHub answers 409.
      if (isEmptyRepository(err)) return result;
      throw err;
    }
    if (pagesRef?.object?.sha) {
      const commit = await this.api('GET', this.repoPath(`/git/commits/${objectId(pagesRef.object.sha)}`, repo));
      const tree = await this.api('GET', this.repoPath(`/git/trees/${objectId(commit?.tree?.sha)}`, repo));
      result.ownSite = (tree?.tree || []).some((entry) => entry.path === site.MANIFEST_PATH);
      if (!result.ownSite) {
        result.conflict = `${fullName} already has a ${site.PAGES_BRANCH} branch that StepForge didn't create. StepForge replaces that branch every time it publishes, so it won't use this repository. Choose another repository or create a new one.`;
        return result;
      }
    }

    let pages = null;
    try { pages = await this.optional('GET', this.repoPath('/pages', repo)); } catch (err) {
      // Without the Pages permission setup explains how to turn Pages on.
      if (err.status !== 403) throw err;
    }
    const servesPagesBranch = pages?.source?.branch === site.PAGES_BRANCH && pages.build_type !== 'workflow';
    if (pages && !servesPagesBranch && !result.ownSite) {
      const from = pages.build_type === 'workflow' ? 'with GitHub Actions' : `from the ${pages.source?.branch || 'another'} branch`;
      result.conflict = `${fullName} already publishes a GitHub Pages site ${from}. StepForge would replace that site, so it won't use this repository. Choose another repository or create a new one.`;
      return result;
    }

    if (await this.optional('GET', this.repoPath(`/branches/${encodeURIComponent(defaultBranch)}`, repo))) {
      const root = await this.optional('GET', this.repoPath('/contents', repo));
      const starter = /^(readme(\.md)?|license(\.md|\.txt)?|\.gitignore)$/i;
      result.fresh = (Array.isArray(root) ? root : []).every((entry) => starter.test(String(entry.name || '')));
    }
    return result;
  }

  clearRepository() {
    if (!this.credentials) return this.status();
    delete this.credentials.repo;
    this.save();
    this.publishStatus();
    return this.status();
  }

  /**
   * Prepare the chosen repository: a README and the expiry workflow on the
   * default branch, a Pages branch, and Pages serving that branch. Each step
   * that fails leaves a note the settings panel shows with instructions.
   */
  setup({ onProgress = null } = {}) {
    const repo = this.requireSite();
    const step = (message) => onProgress?.({ task: 'setup', message });
    return this.exclusive(async () => {
      const notes = [];
      try {
        step('Checking the repository…');
        const info = await this.api('GET', this.repoPath());
        repo.private = Boolean(info?.private);
        const defaultBranch = String(info?.default_branch || 'main');
        const branchPath = `/branches/${encodeURIComponent(defaultBranch)}`;
        const empty = !(await this.optional('GET', this.repoPath(branchPath)));
        if (empty) {
          // An empty repository has no branch to hold the workflow yet. The
          // Contents API works on empty repositories and makes the first commit.
          step('Adding a README…');
          await this.api('PUT', this.repoPath(`/contents/${site.README_PATH}`), {
            message: 'Add a README for shared StepForge guides',
            content: Buffer.from(site.README).toString('base64'),
          });
        }
        step('Adding the clean-up workflow…');
        repo.autoExpire = await this.ensureWorkflow();
        if (!repo.autoExpire) notes.push('StepForge could not add the clean-up workflow, so guides are only removed after they expire while StepForge is open. Check that the App has the Workflows permission.');
        step('Creating the site…');
        await this.untilNotEmpty(async () => this.writeSite(await this.readSite(), { now: this.now() }));
        step('Turning on GitHub Pages…');
        const pages = await this.ensurePages();
        repo.pagesReady = Boolean(pages);
        repo.siteUrl = site.siteBaseUrl({ owner: repo.owner, repo: repo.name, htmlUrl: pages?.html_url || '' });
        if (!pages) notes.push(`Turn on GitHub Pages for ${repo.owner}/${repo.name}: in the repository's Settings → Pages, choose “Deploy from a branch”, then the ${site.PAGES_BRANCH} branch and the / (root) folder.`);
      } catch (err) {
        throw this.accessHint(err);
      } finally {
        repo.setupNote = notes.join(' ');
        this.save();
        this.publishStatus();
      }
      return this.status();
    });
  }

  async ensureWorkflow() {
    const existing = await this.optional('GET', this.repoPath(`/contents/${site.WORKFLOW_PATH}`));
    if (existing?.content && Buffer.from(existing.content, 'base64').toString('utf8') === site.WORKFLOW) return true;
    try {
      await this.api('PUT', this.repoPath(`/contents/${site.WORKFLOW_PATH}`), {
        message: 'Remove shared StepForge guides after they expire',
        content: Buffer.from(site.WORKFLOW).toString('base64'),
        ...(existing?.sha ? { sha: existing.sha } : {}),
      });
      return true;
    } catch (err) {
      if (err.status === 403 || err.status === 404 || err.status === 422) return false;
      throw err;
    }
  }

  /**
   * Right after the first commit in a new repository, GitHub can keep
   * answering 409 ("Git Repository is empty") for a few seconds.
   */
  async untilNotEmpty(fn, attempts = 5) {
    for (let attempt = 1; ; attempt += 1) {
      try { return await fn(); } catch (err) {
        if (!isEmptyRepository(err) || attempt >= attempts) throw err;
        await this.wait(attempt * 1000);
      }
    }
  }

  async ensurePages() {
    const source = { branch: site.PAGES_BRANCH, path: '/' };
    try {
      const current = await this.optional('GET', this.repoPath('/pages'));
      if (!current) {
        try {
          return await this.api('POST', this.repoPath('/pages'), { source });
        } catch (err) {
          // GitHub sometimes turns Pages on by itself when a gh-pages branch
          // appears, and then refuses to create it again.
          if (err.status === 409) return await this.optional('GET', this.repoPath('/pages'));
          throw err;
        }
      }
      if (current.source?.branch !== source.branch || current.source?.path !== source.path) {
        await this.api('PUT', this.repoPath('/pages'), { source, build_type: 'legacy' });
      }
      return current;
    } catch (err) {
      // Private repositories on free plans, or an App without the Pages permission.
      if (err.status === 403 || err.status === 404 || err.status === 409 || err.status === 422) return null;
      throw err;
    }
  }

  // ---- the Pages branch -----------------------------------------------------

  async readSite() {
    let ref;
    try {
      ref = await this.optional('GET', this.repoPath(`/git/ref/heads/${site.PAGES_BRANCH}`));
    } catch (err) {
      if (!isEmptyRepository(err)) throw err;
    }
    if (!ref?.object?.sha) return { head: null, entries: new Map(), manifest: site.emptyManifest() };
    const commit = await this.api('GET', this.repoPath(`/git/commits/${objectId(ref.object.sha)}`));
    const tree = await this.api('GET', this.repoPath(`/git/trees/${objectId(commit?.tree?.sha)}?recursive=1`));
    const entries = new Map();
    for (const entry of tree?.tree || []) if (entry.type === 'blob' && typeof entry.path === 'string') entries.set(entry.path, objectId(entry.sha));
    let manifest = site.emptyManifest();
    const manifestSha = entries.get(site.MANIFEST_PATH);
    if (manifestSha) {
      const text = await this.api('GET', this.repoPath(`/git/blobs/${manifestSha}`), undefined, { raw: true, accept: 'application/vnd.github.raw+json' });
      manifest = site.parseManifest(text);
    }
    return { head: ref.object.sha, entries, manifest };
  }

  /** Upload one file. `onProgress(loaded, total)` counts the file's own bytes. */
  async blob(content, onProgress = null) {
    const timeoutMs = Math.max(MIN_UPLOAD_TIMEOUT_MS, Math.ceil((content.length * 4) / 3 / MIN_UPLOAD_BYTES_PER_SECOND) * 1000);
    const created = await this.api('POST', this.repoPath('/git/blobs'), { content: content.toString('base64'), encoding: 'base64' }, {
      timeoutMs,
      // The request is JSON with the file in base64; report it as file bytes.
      onProgress: onProgress && ((sent, total) => onProgress(Math.min(content.length, Math.round((sent / total) * content.length)), content.length)),
    });
    return created.sha;
  }

  /**
   * Replace the Pages branch with one parentless commit built from the plan.
   * Guides that are kept reuse their existing blobs; nothing old stays in the
   * branch history.
   */
  async writeSite(current, { now, publish = null, remove = null, html = null, onProgress = null }) {
    const plan = site.planSite(current.manifest, { now, publish, remove });
    const tree = [];
    for (const slug of Object.keys(plan.manifest.guides)) {
      const file = site.guidePath(slug);
      let sha;
      if (slug === plan.slug && html) {
        onProgress?.({ stage: 'upload', loaded: 0, total: html.length });
        sha = await this.blob(html, onProgress && ((loaded, total) => onProgress({ stage: 'upload', loaded, total })));
        onProgress?.({ stage: 'commit' });
      } else {
        sha = current.entries.get(file);
      }
      if (!sha) { delete plan.manifest.guides[slug]; continue; }
      tree.push({ path: file, mode: '100644', type: 'blob', sha });
    }
    // GitHub writes CNAME when the user sets a custom domain; keep it.
    const cname = current.entries.get(site.CNAME_PATH);
    if (cname) tree.push({ path: site.CNAME_PATH, mode: '100644', type: 'blob', sha: cname });
    const unchanged = current.head && !publish && !plan.removed.length && !remove
      && current.entries.size === tree.length + 2 && current.entries.has(site.ROOT_INDEX_PATH);
    if (unchanged) return { ...plan, changed: false };
    tree.push({ path: site.ROOT_INDEX_PATH, mode: '100644', type: 'blob', sha: await this.blob(Buffer.from(site.ROOT_INDEX)) });
    tree.push({ path: site.MANIFEST_PATH, mode: '100644', type: 'blob', sha: await this.blob(Buffer.from(site.serializeManifest(plan.manifest))) });
    const createdTree = await this.api('POST', this.repoPath('/git/trees'), { tree });
    const message = publish ? 'Publish a StepForge guide' : remove ? 'Remove a StepForge guide' : 'Update shared StepForge guides';
    const commit = await this.api('POST', this.repoPath('/git/commits'), { message, tree: createdTree.sha, parents: [] });
    if (current.head) {
      await this.api('PATCH', this.repoPath(`/git/refs/heads/${site.PAGES_BRANCH}`), { sha: commit.sha, force: true });
    } else {
      await this.api('POST', this.repoPath('/git/refs'), { ref: `refs/heads/${site.PAGES_BRANCH}`, sha: commit.sha });
    }
    return { ...plan, changed: true };
  }

  requireSite() {
    const repo = this.credentials?.repo;
    if (!this.credentials?.access_token) throw new Error(this.loadError || 'Sign in to GitHub in Settings → Accounts first.');
    if (this.credentials.reauth) throw new Error(SIGN_IN_EXPIRED);
    if (!repo) throw new Error('Choose a repository for shared guides in Settings → Accounts → GitHub first.');
    return repo;
  }

  siteBase(repo = this.credentials?.repo) {
    return repo.siteUrl || site.siteBaseUrl({ owner: repo.owner, repo: repo.name });
  }

  listFrom(manifest) {
    const base = this.siteBase();
    return Object.entries(manifest.guides)
      .map(([slug, entry]) => ({ slug, ...entry, url: site.guideUrl(base, slug) }))
      .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
  }

  /** A shared guide's link, worked out locally so copying it is instant. */
  linkFor(slug) {
    const repo = this.credentials?.repo;
    return repo && site.isSlug(slug) ? site.guideUrl(this.siteBase(repo), slug) : null;
  }

  /**
   * Publish (or republish, keeping the link) one guide's HTML.
   * `onProgress` gets { stage: 'upload', loaded, total } while the page
   * uploads, then { stage: 'commit' } while the site is updated.
   */
  publish({ guideId, title, html, days, onProgress = null }) {
    const repo = this.requireSite();
    site.expiresAtFor(days);
    const page = Buffer.from(site.prepareGuideHtml(html));
    if (page.length > site.MAX_GUIDE_BYTES) {
      throw new Error('This guide is larger than 50 MB. Publish fewer steps or smaller screenshots.');
    }
    return this.exclusive(async () => {
      try {
        const now = this.now();
        const plan = await this.writeSite(await this.readSite(), { now, publish: { guideId, title, days }, html: page, onProgress });
        if (!repo.pagesReady) {
          const pages = await this.ensurePages();
          if (pages) {
            repo.pagesReady = true;
            repo.siteUrl = site.siteBaseUrl({ owner: repo.owner, repo: repo.name, htmlUrl: pages.html_url || '' });
            repo.setupNote = '';
            this.save();
            this.publishStatus();
          }
        }
        const published = this.listFrom(plan.manifest).find((entry) => entry.slug === plan.slug);
        return { ...published, pagesReady: Boolean(repo.pagesReady) };
      } catch (err) { throw this.accessHint(err); }
    });
  }

  unpublish({ slug }) {
    this.requireSite();
    if (!site.isSlug(slug)) throw new Error('Unknown shared guide.');
    return this.exclusive(async () => {
      try {
        const plan = await this.writeSite(await this.readSite(), { now: this.now(), remove: slug });
        return this.listFrom(plan.manifest);
      } catch (err) { throw this.accessHint(err); }
    });
  }

  /** Published guides. Expired ones are removed as a side effect. */
  published() {
    this.requireSite();
    return this.exclusive(async () => {
      try {
        const current = await this.readSite();
        const plan = current.head ? await this.writeSite(current, { now: this.now() }) : site.planSite(current.manifest, { now: this.now() });
        return this.listFrom(plan.manifest);
      } catch (err) { throw this.accessHint(err); }
    });
  }

  /**
   * After publishing, check the public link until GitHub Pages serves it, so
   * StepForge can say when it works. Resolves false if it takes too long.
   */
  async waitUntilLive(slug, { attempts = 45 } = {}) {
    const url = this.linkFor(slug);
    if (!url || !this.credentials?.repo?.pagesReady) return false;
    const generation = this.generation;
    for (let attempt = 0; attempt < attempts && generation === this.generation; attempt += 1) {
      if (attempt) await this.wait(Math.min(2000 + attempt * 500, 10000));
      if (generation !== this.generation) break;
      try {
        // A fresh query string skips any "404" GitHub's CDN cached a moment ago.
        const response = await this.fetch(`${url}?stepforge=${this.now()}-${attempt}`, {
          method: 'HEAD', redirect: 'manual', headers: { 'User-Agent': 'StepForge' }, signal: AbortSignal.timeout(15000),
        });
        if (response.status >= 200 && response.status < 400) return true;
      } catch { /* not reachable yet */ }
    }
    return false;
  }

  /** Remove expired guides; used after launch while StepForge is connected. */
  async sweep() {
    if (!this.credentials?.repo || !this.credentials.access_token) return 0;
    const before = await this.exclusive(() => this.readSite());
    const expired = Object.values(before.manifest.guides).filter((entry) => site.isExpired(entry, this.now())).length;
    if (expired) await this.published();
    return expired;
  }
}

module.exports = { GitHubPages, GitHubError, resolveAppConfig, parseFullName, LOCAL_APP_FILE, CLIENT_ID_PATTERN, APP_SLUG_PATTERN };
