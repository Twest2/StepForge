# Publish guides to Notion, SharePoint, BookStack, GitLab Pages or Zendesk

StepForge can publish a guide straight to these sites, with its screenshots
uploaded too. Publishing the same guide again updates the page it made, so its
address stays the same.

Connect a site in **Settings → Accounts → Publishing**, then choose
**Share → Publish to more sites** in the editor, or **Publish to more sites**
from a guide's menu in the library.

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

The first publish makes a **public** project, `stepforge-guides`, in your
namespace, with a `.gitlab-ci.yml` that serves its `public/` folder. Each guide
is `public/<guide name>/index.html`, the interactive HTML export. Anyone with
the link can open it.

GitLab builds the site after each publish, which takes a minute or two and
needs CI runners. On gitlab.com that means a verified account. Unlike GitHub
Pages sharing, guides stay up until you delete them from the project.

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
