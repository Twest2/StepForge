# Publish guides to Notion, SharePoint, BookStack, GitLab Pages or Zendesk

StepForge can publish a guide straight to these sites, with its screenshots
uploaded too. Publishing the same guide again updates the page it made, so its
address stays the same.

Connect a site in **Settings → Accounts → Publishing**, then choose
**Share → Publish to Notion** (or BookStack, and so on) in the editor, or the
same item from a guide's menu in the library. Every site you're signed in to,
GitHub Pages, Confluence and Wiki.js included, is listed right in the menu;
the others are under **Share → Publish to the web**.

As with [GitHub Pages](GITHUB_PAGES.md), [Confluence](CONFLUENCE.md) and
[Wiki.js](WIKIJS.md), StepForge checks every screenshot for private details
before anything is sent, and you can review each blur first.

| Site | Sign in with | The guide becomes |
| --- | --- | --- |
| Notion | An internal integration's secret | A subpage of a page you shared with the integration |
| SharePoint | Your work or school Microsoft account | A published page on the site you chose |
| BookStack | An API token (ID and secret) | A page in the book or chapter you choose |
| GitLab Pages | A personal access token with the `api` scope | A page on your GitLab Pages site |
| Zendesk | Your email address and an API token | A draft help center article in the section you choose |

## Notion

1. Open [Notion's integrations page](https://www.notion.so/profile/integrations),
   create an **internal** integration for your workspace, and copy its secret.
2. Paste the secret into **Settings → Accounts → Publishing → Notion**.
3. In Notion, open each page you want guides to go under, and add the
   integration from the page's **•••** menu → **Connections**. Notion only
   lets the integration see pages shared with it.

When you publish, choose the page to publish under. Publishing again replaces
the content of the same page, wherever it is now.

## SharePoint

SharePoint uses the same Microsoft sign-in as OneDrive sync, and needs a work
or school account. Your organization may need to approve StepForge first.

1. In **Settings → Accounts → Publishing → SharePoint**, type the site's
   address, such as `contoso.sharepoint.com/sites/Team`. You can paste the
   address of any page on the site.
2. Choose **Sign in with Microsoft** and sign in in your browser.

Each guide becomes a published site page. Its screenshots go in the site's
**Site Assets** library, under `StepForge/<page name>`.

## BookStack

1. In BookStack, open your profile → **Access & Security** → **API Tokens**
   and create a token. Your role needs the **Access system API** permission.
2. In **Settings → Accounts → Publishing → BookStack**, type your site's
   address and paste the token ID and secret.

When you publish, choose the book or chapter. Screenshots go in the page's
image gallery. The link StepForge shows (`/link/<id>`) keeps working if the page is
moved or renamed.

## GitLab Pages

1. On gitlab.com (or your own GitLab), create a personal access token with the
   `api` scope.
2. Paste it into **Settings → Accounts → Publishing → GitLab Pages**. For your
   own GitLab, also type its address.

GitLab Pages sharing works like [GitHub Pages sharing](GITHUB_PAGES.md):

- **Anyone with the link can open a shared guide.** Publishing asks you to
  confirm that, after the same check for private details.
- **Each guide gets an unguessable link**, `…/g/<random>/`, not one made from
  its title. The site's front page never lists guides, and pages ask search
  engines not to index or archive them.
- **You choose how long it stays online: 1, 7 or 30 days.** Publishing again
  keeps the same link and starts the time again. A pipeline schedule rebuilds
  the site every hour, so a guide comes down when its time is up even while
  StepForge is closed.
- **Settings → Accounts → Publishing → GitLab Pages** lists what's shared, with
  **Copy link**, **Open**, **Extend** and **Remove**.

The first publish makes a project, `stepforge-guides`, in your namespace. Its
Pages site is public, but its files, history, pipelines and job logs are for
project members only, so nobody else can browse guides there, removed ones
included. (If you already have a `stepforge-guides` project, StepForge uses
it and changes it to these settings.) Each guide is the interactive HTML
export.

GitLab builds the site after each publish, which needs CI runners (on
gitlab.com, a verified account). StepForge waits until the guide's page loads
before showing its link, usually a minute or two. If the build fails, it says
so and links to the pipeline; if no runner picks it up, it says that instead.

## Zendesk

1. In Zendesk, open **Admin Center → Apps and integrations → Zendesk API**,
   turn on token access and add an API token.
2. In **Settings → Accounts → Publishing → Zendesk**, type your subdomain
   (`acme` for `acme.zendesk.com`), your email address and the token.

When you publish, choose the section. A new article is saved as a **draft**, so
you can review it and publish it in Zendesk. Publishing again updates the
article and leaves it published or not, as it is. Screenshots are uploaded as
the article's attachments.

## Obsidian, MkDocs and Docusaurus

These have no account to publish to: their pages are Markdown files in a
folder or repository. Use **Export → Markdown** and choose **Write for**:
**Obsidian**, **MkDocs** or **Docusaurus**, then put the file and its
screenshot folder in your vault or `docs` folder.
