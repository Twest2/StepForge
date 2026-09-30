# Share guides on the web with GitHub Pages

StepForge can publish a guide as a web page for **1, 7, or 30 days**, so you
can send someone a link instead of a file. The page is hosted by
[GitHub Pages](https://pages.github.com) in a GitHub repository **you own**.
StepForge doesn't run a server and never hosts your guides.

Sharing is **optional and off by default**. You need a free GitHub account.

> [!WARNING]
> **Shared guides are public.** Anyone with the link can open a shared guide,
> and anyone who looks at your repository on GitHub can find it. StepForge
> checks your screenshots and blurs the private details it finds before
> publishing ([how](GETTING_STARTED.md#find-private-details)), but it can
> miss some. Check every screenshot for passwords, email addresses, customer
> details, and anything else private, and hide what it missed with the
> **Blur** tool.
> Removing a guide takes it off the site, but someone may already have saved a
> copy.

## Set up sharing (one time)

Open **Settings → Accounts → GitHub**. The panel walks you through three
steps, with a button for each, and ticks each one off when it's done.

1. **Sign in to GitHub.** Choose **Sign in with GitHub**. StepForge copies a
   one-time code to your clipboard and opens `github.com/login/device`. Paste
   the code there and approve StepForge. The code also stays on screen in
   StepForge. You never type your GitHub password into StepForge.
2. **Give StepForge one repository.** The simplest choice is a new
   repository just for shared guides: choose **Create a repository**, and
   GitHub opens with the name `stepforge-guides` filled in. Keep it
   **Public** and select **Create repository**. Then choose **Install
   StepForge on GitHub**, select **Only select repositories**, pick that
   repository, and select **Install**. StepForge asks for access to that
   repository's contents, Pages, and workflows, and nothing else. You can also
   [use a repository you already have](#use-an-existing-repository).
3. **Choose the repository.** When you come back to StepForge, the panel
   already knows StepForge is installed. Pick the repository and choose **Use
   this repository**. The button shows each setup step as it runs.

You can do step 2 before step 1 if you like. A brand-new, empty repository
works too.

StepForge then sets up the repository for you:

- adds a short `README.md` explaining what the repository is for, if the
  repository is empty,
- adds a workflow, `.github/workflows/stepforge-expire.yml`, that removes
  guides when they expire, even when StepForge is closed,
- creates a `gh-pages` branch for the site, and
- turns on GitHub Pages for that branch.

The **Your site** card shows the site's address, whether GitHub Pages is on,
and whether automatic removal is on. If a step couldn't be finished, the card
says what to do and has a **Check again** button.

### Use an existing repository

You can share guides from a repository that already has other work in it,
such as a project's own repository. When you choose it, StepForge shows what
it will add and waits for you to confirm:

- `.github/workflows/stepforge-expire.yml` on the repository's default
  branch, and
- a `gh-pages` branch for the shared guides, with GitHub Pages turned on for
  it.

Nothing else in the repository changes. Your README and other files are left
alone.

StepForge won't use a repository that **already publishes a GitHub Pages
site** (from any branch or from GitHub Actions), or that has a `gh-pages`
branch it didn't create, because it would replace that site. Use a new
repository instead.

> [!NOTE]
> StepForge's GitHub App can change any file in a repository it's installed
> on. It only ever touches the two things above, but a separate repository
> just for shared guides keeps your other work out of its reach.

## Publish a guide

1. Open the guide and choose **Share → Publish to the web…** (or right-click
   the guide in the library).
2. Choose how long to keep it online: **1 day**, **7 days**, or **30 days**.
3. Read the warning, tick **I understand this guide will be public on the
   internet**, and choose **Publish**.
4. StepForge shows what it's doing: preparing the page, uploading it to
   GitHub (with a progress bar, size, and speed), and updating your site. You
   can close the window; StepForge keeps going and tells you when it's done.
5. Choose **Copy link** and send it to whoever needs it.

GitHub usually takes under a minute to put a new page online. StepForge
checks the link for you: the dialog says **Going live** until GitHub serves
the page, then **Live**. You can copy the link straight away.

Each shared guide is one page, the same as an **Interactive HTML** export with
the default options: all visible steps, screenshots with annotations,
descriptions, and a checklist readers can tick off in their own browser.
Hidden steps are left out, as in every export.

### Publish from Export

To choose the page's look, publish from **Export** instead:

1. Choose **Export** and pick **HTML** or **Interactive HTML**, with any
   template and options you like.
2. Turn on **Publish on the web**, choose how long to keep it online, and read
   the warning.
3. Choose **Export and publish**. StepForge saves the file as usual, then
   publishes the same page with the same progress as above and shows the
   link.

**Publish on the web** only appears for the two HTML formats. If GitHub isn't
set up yet, it's turned off and says where to set it up. If publishing fails,
the exported file is still saved.

### Update or remove a shared guide

- **Publish again** to update the page with your latest changes. The link
  stays the same, and the time you choose starts again.
- **Remove from the web** (in the publish dialog, or **Remove** in
  **Settings → Accounts → GitHub → Shared guides**) takes the page down. The
  link stops working within a few minutes. The guide stays in your library.

**Shared guides** in the GitHub settings lists everything that's online and
when each guide will be removed, with **Copy link**, **Open**, and **Remove**
buttons.

## How long guides stay online

When a guide's time is up, it's removed by whichever happens first:

- the clean-up workflow in your repository, which runs about every six hours,
  or
- StepForge, which checks shortly after it starts and whenever you open the
  shared-guides list.

So a guide can stay online for up to a few hours after it expires.

> [!NOTE]
> GitHub pauses scheduled workflows in public repositories that have had no
> activity for 60 days. The longest you can share a guide is 30 days, and
> every publish counts as activity, so this doesn't affect guides StepForge
> publishes. If you ever see the workflow disabled in the repository's
> **Actions** tab, select **Enable workflow**.

## What's in the repository

StepForge keeps the `gh-pages` branch to exactly what the site needs, and
replaces the whole branch with a **single new commit** every time it publishes
or removes a guide. Removed guides don't stay in the branch history.

| Path on `gh-pages` | What it is |
| --- | --- |
| `index.html` | A placeholder page. It never lists your guides. |
| `g/<random id>/index.html` | One shared guide. The random id makes the link hard to guess. |
| `_stepforge.json` | The list of shared guides and when they expire. GitHub Pages doesn't publish it. |

Shared pages ask search engines not to index or archive them, and don't send
their address to other sites through links. That keeps them out of search
results, but it isn't access control: **anyone with the link can open the
page.**

Don't put your own files on the `gh-pages` branch; StepForge replaces it.

## Use your own domain

To share links on your own domain, such as `guides.example.com`, set it up in
the repository's **Settings → Pages → Custom domain** as GitHub describes in
[Configuring a custom domain](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site).
You can do this at any time, including after you've shared guides. StepForge
notices the next time you publish or open **Settings → Accounts → GitHub**,
and every link it shows or copies uses your domain from then on, including
links to guides you've already shared. The old `github.io` links keep
working, because GitHub redirects them.

Links use `https://` when your domain supports it. Turn on **Enforce HTTPS**
in the Pages settings once GitHub offers it. Until then, a domain without a
certificate gets `http://` links.

## Private repositories

GitHub Pages sites are public even when the repository is private, and a
free GitHub plan can't publish Pages from a private repository. StepForge
shows a note if you choose a private repository. Use a public repository
unless you have a paid plan and know you want a private one.

## Disconnect

**Disconnect** signs this computer out of GitHub. **Shared guides stay online
until they expire.** To take them down now, remove them before you disconnect.

To fully revoke StepForge's access, open
[GitHub → Settings → Applications](https://github.com/settings/apps/authorizations)
and revoke StepForge. You can also uninstall the app from the repository, or
delete the repository to remove everything at once.

To use a different repository, choose **Advanced → Change repository**. Guides
already shared from the old repository stay there until they expire.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| The sign-in code is lost, or you closed the GitHub page | Choose **Copy code** or **Open GitHub again** under the code, or **Get a new code** to start over. Closing Settings doesn't cancel a sign-in. |
| "Your GitHub sign-in has expired or was revoked" | Choose **Sign in again**. Your repository and shared guides stay as they are. |
| **Install StepForge on GitHub** and **Sign in with GitHub** do nothing, and the panel says StepForge "isn't connected to a StepForge GitHub App" | This copy of StepForge was built without the StepForge GitHub App, which happens when you run it from source. Install an official release, or see the [maintainer guide](cloud_accounts_init_setup/GITHUB_PAGES_RELEASE.md#signing-in-from-a-development-checkout). |
| "already publishes a GitHub Pages site" or "has a gh-pages branch that StepForge didn't create" | StepForge won't replace an existing site. Create a new repository for shared guides and install StepForge on it. |
| Step 2 keeps waiting for StepForge to be installed | Install StepForge on the repository on GitHub, then come back to StepForge or choose **Check again**. |
| "StepForge can't change *owner/repo*" | Open the repository's **Settings → GitHub Apps**, choose **Configure** next to StepForge, and make sure the repository is selected and every requested permission is accepted. |
| **GitHub Pages off** | Open **Settings → Pages** in the repository, choose **Deploy from a branch**, pick `gh-pages` and `/ (root)`, and save. Then choose **Check again**. |
| **Removed only while StepForge is open** | StepForge couldn't add the clean-up workflow. Accept the **Workflows** permission for StepForge on GitHub, then choose **Check again**. |
| The dialog says GitHub is taking longer than usual, or the link shows 404 | GitHub is still publishing. Wait a few minutes and reload. If it never appears, check the **Actions** tab in the repository for a failed "pages build and deployment" run. |
| The sign-in code expired | Choose **Sign in with GitHub** again. Codes last 15 minutes. |

See the [privacy policy](PRIVACY.md#optional-github-pages-sharing) for exactly
what is sent to GitHub.

---

*Maintainers: see [GitHub App release configuration](cloud_accounts_init_setup/GITHUB_PAGES_RELEASE.md).*
