'use strict';
const { t } = require('../core/ui-text');
const { storeVersion, versionFromStore } = require('../core/store-version');

/**
 * Update check for Settings → About and the bar under the top bar.
 *
 * This is the only place StepForge asks whether a newer version exists. It
 * runs when StepForge starts (unless Settings → About turns that off) and when
 * the user presses "Check for updates". It makes one request to a fixed GitHub
 * endpoint, refuses redirects, has a deadline and a response-size cap, and
 * sends nothing but a User-Agent. The renderer never performs the request itself.
 *
 * A Microsoft Store install asks the Store instead, so it only hears about a
 * version the Store can install: one request to the Store's public catalog
 * for the version that's live, and only when that's newer, one more to
 * GitHub for its release notes.
 */

const LATEST_RELEASE_API = 'https://api.github.com/repos/Twest2/StepForge/releases/latest';
const RELEASE_BY_TAG_API = 'https://api.github.com/repos/Twest2/StepForge/releases/tags/';
// The catalog the Store app and winget read. Not a documented API: if it
// changes, the check reports an error and shows no notice. Every market lists
// the same package, so one is enough.
const STORE_CATALOG_API = 'https://displaycatalog.mp.microsoft.com/v7.0/products';
const RELEASES_PAGE = 'https://github.com/Twest2/StepForge/releases/latest';
const RELEASE_URL_PREFIX = 'https://github.com/Twest2/StepForge/releases/';
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_RESPONSE_BYTES = 1024 * 1024;

/** "v1.0", "0.7.0", "0.6.1.3" -> [major, minor, patch, build]; null if not a version. */
function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const parts = value.trim().replace(/^v/i, '').split('.');
  if (parts.length < 1 || parts.length > 4 || !parts.every((p) => /^(0|[1-9]\d{0,8})$/.test(p))) return null;
  const nums = parts.map(Number);
  while (nums.length < 4) nums.push(0);
  return nums;
}

/** Negative when a < b, 0 when equal, positive when a > b. */
function compareVersions(a, b) {
  for (let i = 0; i < 4; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function formatVersion(value) {
  return String(value).trim().replace(/^v/i, '');
}

/**
 * How to install the update, based on how StepForge is usually installed on
 * this platform. Package-manager installs update through the package manager;
 * everyone else downloads the new release. On Windows, a Microsoft Store
 * install is updated by the Store, and an install registered with Chocolatey
 * gets the Update now button (app/windows-update.js).
 */
function installHint(platform, hasCommand = () => false, { chocolatey = false, store = false } = {}) {
  if (platform === 'win32') {
    if (store) {
      return t('It’s in the Microsoft Store now. The Store installs it by itself, or open StepForge in the Store and choose Update to get it now.');
    }
    if (chocolatey) {
      return t('Update now installs it with Chocolatey. StepForge closes while it updates and opens again when it’s done.');
    }
    return t('Download the new installer from the release page. Run the installer again and keep "Keep StepForge updated with Chocolatey" checked to get one-click updates.');
  }
  if (platform === 'linux') {
    if (hasCommand('dnf')) return t('Run "sudo dnf upgrade stepforge", or download the new .rpm.');
    if (hasCommand('apt')) return t('Run "sudo apt update && sudo apt install --only-upgrade stepforge", or download the new .deb.');
    return t('Download the new version from the release page.');
  }
  return t('Download the new version from the release page.');
}

/**
 * One GET for JSON with the checker's guarantees: no redirects, a deadline,
 * a size cap. Resolves { status, ok, data } (data is null unless ok); throws
 * on a network failure, AbortError at the deadline.
 */
async function getJson(url, { fetchImpl, timeoutMs, headers }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: controller.signal, headers });
    const data = response.ok ? JSON.parse(await readLimitedText(response, MAX_RESPONSE_BYTES)) : null;
    return { status: response.status, ok: response.ok, data };
  } finally {
    clearTimeout(timer);
  }
}

/** The highest StepForge package version in a Store catalog answer, such as "1.6.800.0"; null if none. */
function liveStoreVersion(catalog) {
  const versions = (catalog?.Products || []).flatMap((product) => product?.DisplaySkuAvailabilities || [])
    .flatMap((entry) => entry?.Sku?.Properties?.Packages || [])
    .map((pkg) => /^[^_]+_(\d+\.\d+\.\d+\.\d+)_/.exec(String(pkg?.PackageFullName || ''))?.[1])
    .filter(Boolean);
  return versions.sort((a, b) => compareVersions(parseVersion(b), parseVersion(a)))[0] || null;
}

/** checkForUpdates for a Microsoft Store install: the Store says which version it has. */
async function checkStore({ currentVersion, base, productId, fetchImpl, timeoutMs }) {
  const headers = { Accept: 'application/json', 'User-Agent': `StepForge/${formatVersion(currentVersion)}` };
  let mine;
  try { mine = parseVersion(storeVersion(formatVersion(currentVersion))); } catch { mine = null; }
  if (!mine || !/^[0-9A-Z]{12}$/.test(String(productId || ''))) {
    return { ...base, status: 'error', message: t('This build has no version number to compare.') };
  }
  let live;
  try {
    const answer = await getJson(`${STORE_CATALOG_API}?bigIds=${productId}&market=US&languages=en-US`, { fetchImpl, timeoutMs, headers });
    if (!answer.ok) return { ...base, status: 'error', message: t('The Microsoft Store returned an error ({status}). Try again later.', { status: answer.status }) };
    live = liveStoreVersion(answer.data);
  } catch (error) {
    const message = error && error.name === 'AbortError'
      ? t('The Microsoft Store took too long to answer. Check your connection and try again.')
      : t('Couldn’t reach the Microsoft Store. Check your internet connection and try again.');
    return { ...base, status: 'error', message };
  }
  const latestVersion = versionFromStore(live);
  if (!latestVersion) return { ...base, status: 'error', message: t('The Microsoft Store didn’t say which version it has.') };
  const result = { ...base, latestVersion, store: true, updateNow: false };
  if (compareVersions(parseVersion(live), mine) <= 0) return { ...result, status: 'up-to-date' };
  // The release notes are a bonus: without them the notice still shows.
  let release = null;
  try {
    const answer = await getJson(`${RELEASE_BY_TAG_API}v${latestVersion}`, { fetchImpl, timeoutMs, headers: { ...headers, Accept: 'application/vnd.github+json' } });
    release = answer.ok ? answer.data : null;
  } catch { /* no notes */ }
  return {
    ...result,
    status: 'update-available',
    releaseUrl: typeof release?.html_url === 'string' && release.html_url.startsWith(RELEASE_URL_PREFIX) ? release.html_url : RELEASES_PAGE,
    publishedAt: typeof release?.published_at === 'string' ? release.published_at : null,
    notes: typeof release?.body === 'string' ? release.body.slice(0, 100000) : '',
    hint: installHint('win32', () => false, { store: true }),
  };
}

async function readLimitedText(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('response too large');
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new Error('response too large');
  return text;
}

/**
 * Ask GitHub for the latest published release and compare it with the
 * running version. Never throws: failures come back as { status: 'error' }.
 * `chocolatey` is true for a Windows install that Update now can update; the
 * result's `updateNow` says whether to offer the button. `store` is true for a
 * Microsoft Store install, which the Store updates; the result's `store` says
 * to send the user there instead of to the download.
 */
async function checkForUpdates({
  currentVersion,
  platform = process.platform,
  hasCommand = () => false,
  chocolatey = false,
  store = false,
  productId = '',
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const current = parseVersion(currentVersion);
  const base = { currentVersion: currentVersion ? formatVersion(currentVersion) : '', releaseUrl: RELEASES_PAGE };
  if (!current) {
    return { ...base, status: 'error', message: t('This build has no version number to compare.') };
  }
  if (platform === 'win32' && store === true) return checkStore({ currentVersion, base, productId, fetchImpl, timeoutMs });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let release;
  try {
    const response = await fetchImpl(LATEST_RELEASE_API, {
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `StepForge/${formatVersion(currentVersion)}`,
      },
    });
    if (response.status === 404) {
      return { ...base, status: 'error', message: t('No published release was found.') };
    }
    if (response.status === 403 || response.status === 429) {
      return { ...base, status: 'error', message: t('GitHub is limiting requests right now. Try again in a few minutes.') };
    }
    if (!response.ok) {
      return { ...base, status: 'error', message: t('GitHub returned an error ({status}). Try again later.', { status: response.status }) };
    }
    release = JSON.parse(await readLimitedText(response, MAX_RESPONSE_BYTES));
  } catch (error) {
    const message = error && error.name === 'AbortError'
      ? t('GitHub took too long to answer. Check your connection and try again.')
      : t('Couldn’t reach GitHub. Check your internet connection and try again.');
    return { ...base, status: 'error', message };
  } finally {
    clearTimeout(timer);
  }

  const latest = parseVersion(release && release.tag_name);
  if (!latest) {
    return { ...base, status: 'error', message: t('The latest release has an unrecognized version number.') };
  }
  const releaseUrl = typeof release.html_url === 'string' && release.html_url.startsWith(RELEASE_URL_PREFIX)
    ? release.html_url
    : RELEASES_PAGE;
  const result = {
    ...base,
    latestVersion: formatVersion(release.tag_name),
    releaseUrl,
    publishedAt: typeof release.published_at === 'string' ? release.published_at : null,
    // The release's text on GitHub (Markdown), shown as "What's new".
    notes: typeof release.body === 'string' ? release.body.slice(0, 100000) : '',
  };
  if (compareVersions(latest, current) > 0) {
    const microsoftStore = platform === 'win32' && store === true;
    const updateNow = platform === 'win32' && chocolatey === true && !microsoftStore;
    return {
      ...result,
      status: 'update-available',
      updateNow,
      store: microsoftStore,
      hint: installHint(platform, hasCommand, { chocolatey: updateNow, store: microsoftStore }),
    };
  }
  return { ...result, status: 'up-to-date' };
}

module.exports = {
  LATEST_RELEASE_API,
  STORE_CATALOG_API,
  RELEASES_PAGE,
  parseVersion,
  compareVersions,
  installHint,
  checkForUpdates,
};
