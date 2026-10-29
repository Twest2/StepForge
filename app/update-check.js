'use strict';

/**
 * User-initiated update check for Settings → About.
 *
 * This is the only place StepForge asks whether a newer version exists, and it
 * runs only when the user presses "Check for updates" — never at startup or in
 * the background. It makes one request to a fixed GitHub endpoint, refuses
 * redirects, has a deadline and a response-size cap, and sends nothing but a
 * User-Agent. The renderer never performs the request itself.
 */

const LATEST_RELEASE_API = 'https://api.github.com/repos/Twest2/StepForge/releases/latest';
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
      return 'The Microsoft Store installs updates automatically, usually within a day or two of a release. To get it sooner, open StepForge in the Store and choose Update.';
    }
    if (chocolatey) {
      return 'Update now installs it with Chocolatey. StepForge closes while it updates and opens again when it’s done.';
    }
    return 'Download the new installer from the release page. Run the installer again and keep "Keep StepForge updated with Chocolatey" checked to get one-click updates.';
  }
  if (platform === 'linux') {
    if (hasCommand('dnf')) return 'Run "sudo dnf upgrade stepforge", or download the new .rpm.';
    if (hasCommand('apt')) return 'Run "sudo apt update && sudo apt install --only-upgrade stepforge", or download the new .deb.';
    return 'Download the new version from the release page.';
  }
  return 'Download the new version from the release page.';
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
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const current = parseVersion(currentVersion);
  const base = { currentVersion: currentVersion ? formatVersion(currentVersion) : '', releaseUrl: RELEASES_PAGE };
  if (!current) {
    return { ...base, status: 'error', message: 'This build has no version number to compare.' };
  }

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
      return { ...base, status: 'error', message: 'No published release was found.' };
    }
    if (response.status === 403 || response.status === 429) {
      return { ...base, status: 'error', message: 'GitHub is limiting requests right now. Try again in a few minutes.' };
    }
    if (!response.ok) {
      return { ...base, status: 'error', message: `GitHub returned an error (${response.status}). Try again later.` };
    }
    release = JSON.parse(await readLimitedText(response, MAX_RESPONSE_BYTES));
  } catch (error) {
    const message = error && error.name === 'AbortError'
      ? 'GitHub took too long to answer. Check your connection and try again.'
      : 'Couldn’t reach GitHub. Check your internet connection and try again.';
    return { ...base, status: 'error', message };
  } finally {
    clearTimeout(timer);
  }

  const latest = parseVersion(release && release.tag_name);
  if (!latest) {
    return { ...base, status: 'error', message: 'The latest release has an unrecognized version number.' };
  }
  const releaseUrl = typeof release.html_url === 'string' && release.html_url.startsWith(RELEASE_URL_PREFIX)
    ? release.html_url
    : RELEASES_PAGE;
  const result = {
    ...base,
    latestVersion: formatVersion(release.tag_name),
    releaseUrl,
    publishedAt: typeof release.published_at === 'string' ? release.published_at : null,
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
  RELEASES_PAGE,
  parseVersion,
  compareVersions,
  installHint,
  checkForUpdates,
};
