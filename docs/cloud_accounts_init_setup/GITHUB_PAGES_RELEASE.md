# GitHub Pages sharing: maintainer guide

*For StepForge maintainers.* Users never need any of this. They follow the
steps in **Settings → Accounts → GitHub** ([user guide](../GITHUB_PAGES.md)).
Never ask a user for a client ID, token, or App settings.

Every official build uses StepForge's single public **GitHub App**. Each user
installs it on their own repository and gets their own token.

## How sign-in works

- StepForge uses the GitHub App **device flow**: it asks GitHub for a device
  code, shows the user code, and opens `https://github.com/login/device`. It
  polls `https://github.com/login/oauth/access_token` until the user approves.
- There is **no client secret** and no local callback server. Device-flow
  tokens are refreshed without a secret too.
- A GitHub App user token can only act on repositories the App is installed on,
  and only with the App's permissions, so StepForge can't touch any other
  repository the user owns.
- The token is stored encrypted with Electron `safeStorage` in
  `settings/github.credentials` in the library folder. It never crosses IPC.
- All GitHub API calls run in the main process (`app/github-pages.js`). The
  renderer only receives status and public page links.

## One-time registration

Create the App under the StepForge account at
**GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**:

| Setting | Value |
| --- | --- |
| GitHub App name | `StepForge` (its slug becomes part of the install link) |
| Homepage URL | `https://github.com/Twest2/StepForge` |
| Callback URL | Leave empty |
| Expire user authorization tokens | On (StepForge refreshes them) |
| Request user authorization (OAuth) during installation | Off |
| Enable Device Flow | **On** (required) |
| Webhook | Off (**Active** unticked) |
| Where can this GitHub App be installed? | Any account |

**Repository permissions** (everything else stays *No access*):

| Permission | Access | Used for |
| --- | --- | --- |
| Contents | Read and write | README, the `gh-pages` branch (blobs, trees, commits, refs) |
| Pages | Read and write | Turning Pages on for `gh-pages` and reading the site address |
| Workflows | Read and write | Adding `.github/workflows/stepforge-expire.yml` |
| Metadata | Read-only | Required by GitHub for every App |

No account or organization permissions are needed. Don't generate a client
secret or private key; StepForge uses neither.

Then give releases the App's **Client ID** (it starts with `Iv`) and **slug**
(the last part of `https://github.com/apps/<slug>`) as repository variables,
under **Settings → Secrets and variables → Actions → Variables**:

| Variable | Value |
| --- | --- |
| `STEPFORGE_GITHUB_CLIENT_ID` | `Iv23li…` |
| `STEPFORGE_GITHUB_APP_SLUG` | `stepforge` |

```bash
gh variable set STEPFORGE_GITHUB_CLIENT_ID --body 'Iv23li…'
gh variable set STEPFORGE_GITHUB_APP_SLUG --body 'stepforge'
```

Both are public identifiers, not secrets. Committing them to
`app/github-app-config.json` works too; the repository variables win when both
are set.

> [!CAUTION]
> Keep the registration stable between releases. A new App means a new client
> ID: every user has to install it and sign in again, and saved sign-ins from
> the old App are ignored.

## Release builds

The Windows, Ubuntu, Fedora, and Launchpad release jobs run
`node scripts/configure-github-app.js` before packaging. It writes the App
into `app/github-app-config.json` inside each package. **A release job fails
if no valid App is configured**, so a build can't ship with the Install and
Sign in buttons turned off.

Builds without an App, such as a source checkout with no local App, say in the
GitHub panel that they aren't connected to a StepForge GitHub App, and every
other feature keeps working.

## Signing in from a development checkout

Development builds read the App from the environment or from a gitignored
`github-app.local.json` at the repository root, but only while the committed
config is empty:

```bash
STEPFORGE_GITHUB_CLIENT_ID=Iv23li… STEPFORGE_GITHUB_APP_SLUG=my-test-app \
  STEPFORGE_DATA_DIR="$HOME/.local/share/stepforge-dev" npm start
```

To test without touching the real App, register a second App with the same
settings under your own account and use a throwaway repository.

## What StepForge writes to a user's repository

| Where | What | When |
| --- | --- | --- |
| Default branch | `README.md` (only if the repository is empty) | Setup |
| Default branch | `.github/workflows/stepforge-expire.yml` | Setup, and when a newer StepForge ships a changed workflow |
| `gh-pages` | `index.html`, `_stepforge.json`, `g/<slug>/index.html` | Every publish and removal, as one parentless commit, force-updated |
| Repository settings | GitHub Pages source `gh-pages` / `/` | Setup and first publish |

Before using a repository, `inspectRepository()` in `app/github-pages.js`
refuses one whose Pages site StepForge would replace: Pages already on from
another branch or from Actions, or a `gh-pages` branch without
`_stepforge.json`. A repository holding more than GitHub's starter files
(README, LICENSE, `.gitignore`) is used only after the user confirms the
changes listed in the panel.

The layout, manifest rules, workflow text, and expiry logic are in
`core/pages-site.js`. The workflow's clean-up uses the same rules as
`planSite()`, commits with `GITHUB_TOKEN`, and pushes with
`--force-with-lease`, so it never overwrites a publish that happened while it
ran. Changing `WORKFLOW` should also bump `WORKFLOW_MARKER`.

## Release checklist

Automated tests mock GitHub (`tests/unit/github-pages.test.js`), so check these
by hand against the real App before each release that touches sharing:

- [ ] The setup buttons open the new-repository page and the App's install
      page.
- [ ] **Sign in with GitHub** shows a code; entering it on GitHub signs in;
      **Cancel sign-in** stops waiting.
- [ ] Choosing a new empty repository adds the README and workflow, creates
      `gh-pages`, and turns on Pages with no notes left on the site card.
- [ ] **Publish to the web** gives a link that opens the guide once Pages has
      built; publishing again keeps the link.
- [ ] `gh-pages` always has exactly one commit.
- [ ] **Remove** takes the page down; the workflow, run by hand from the
      **Actions** tab, removes a guide whose expiry has passed.
- [ ] **Disconnect** keeps shared guides online and forgets the sign-in.

References: [Device flow](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app#using-the-device-flow-to-generate-a-user-access-token),
[Refreshing user tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens),
[Pages REST API](https://docs.github.com/en/rest/pages/pages),
[Git database API](https://docs.github.com/en/rest/git).
