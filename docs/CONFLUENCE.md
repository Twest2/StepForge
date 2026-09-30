# Publish guides to Confluence

StepForge can publish a guide as a Confluence page, with its screenshots
attached. Publishing the same guide again updates that page, so its link
never changes. This works with **Confluence Cloud** and with **Confluence Data
Center or Server** sites run by your organization.

If you'd rather import by hand, **Export → Confluence** still makes a Word file
for Confluence's importer.

## Connect your site

1. Open **Settings → Accounts → Confluence**.
2. Type your site's address, such as `confluence.example.com` or
   `yourcompany.atlassian.net`, and choose **Continue**. You can also paste
   the address of any page on the site.
3. Sign in:
   - **Confluence Cloud:** enter your Atlassian email address and an
     [API token](#create-an-api-token-confluence-cloud).
   - **Data Center or Server:** use one of these.
     - **[Personal access token](#create-a-personal-access-token-data-center).**
       Paste it in.
     - **Sign in with your browser**, for single sign-on or a smart card.
       Your site's own login page opens in a StepForge window. Sign in as
       usual; the window closes by itself when you're done.
4. Choose the space for new pages and, if you like, a parent page to put them
   under.

## Tokens

A token is like a password made only for an app. StepForge uses it to create
and update pages as you, so your real password (or your smart card) never goes
into StepForge. It can only do what you can do in Confluence. You can delete
it at any time, which cuts off StepForge without affecting your own sign-in.
StepForge stores it encrypted on your computer.

### Create a personal access token (Data Center)

Personal access tokens need Confluence Data Center or Server 7.9 or later.

1. Open your Confluence site in your browser and sign in as usual.
2. Select your profile picture at the top right, then **Settings**.
3. Select **Personal Access Tokens**, then **Create token**.
4. Name it `StepForge` and choose when it expires, for example in 90 days.
5. Select **Create** and copy the token. Confluence only shows it once.
6. Paste it into **Settings → Accounts → Confluence** in StepForge.

StepForge's **Create a token on your site** link opens the token page
directly. When the token expires, publishing says Confluence didn’t accept the
sign-in: make a new token, then **Disconnect** and connect again with it.

If there's no **Personal Access Tokens** option, your administrators have
turned tokens off. Use **Sign in with your browser** instead.

On a site that asks for your smart card, you need both: the card gets you to
the site, and the token tells Confluence who you are once you're there.

### Create an API token (Confluence Cloud)

1. Open [your Atlassian account's API tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
   (StepForge's **Create an API token** link goes there).
2. Select **Create API token**, name it `StepForge`, and choose when it
   expires.
3. Copy the token. Atlassian only shows it once.
4. Paste it into StepForge along with the email address you sign in to
   Atlassian with.

## Publish a guide

Choose **Share → Publish to Confluence…** in the editor, or **Publish to
Confluence…** from a guide's menu in the library. Pick the space and choose
**Publish**.

Before anything is sent, StepForge checks the guide's screenshots for private
details and blurs what it finds ([how](GETTING_STARTED.md#find-private-details)).
Choose **Review** to check the blurs. Screenshots are attached as
`step-001.png` and so on, so step titles never end up in file names.

If the space already has a page with the guide's title, StepForge asks before
replacing it. Confluence keeps the old version in the page history.

## Smart cards (CAC and PIV)

Many government and corporate sites ask for your smart card before they show
anything. StepForge handles this the same way your browser does:

- Insert your card before you connect or publish. When the site asks for it,
  your computer shows its usual PIN prompt.
- If your card holds several certificates, StepForge picks the one meant for
  signing in to websites. If it can't tell, it asks you, and it remembers your
  choice for that site.
- **Windows** uses the smart card support that's already set up for your
  browser. **Linux** needs the card's software registered with the system's
  certificate database, the same setup Chrome needs (for example OpenSC added
  with `modutil`).
- Your organization's root certificates (for example DoD roots) must be
  installed on the computer, as they are for your browser. Otherwise
  StepForge says it doesn't trust the site.

If publishing doesn't work, ask your Confluence administrator:

1. Is the site Confluence Data Center (and which version) or Atlassian
   Government Cloud? Personal access tokens need Data Center 7.9 or later.
2. Can users create personal access tokens? If not, use **Sign in with your
   browser**.
3. Is StepForge allowed on your work computer?

## Disconnect

**Disconnect** removes StepForge's saved sign-in and its Confluence cookies
from this computer. Pages you published stay in Confluence. To revoke a token,
delete it on your site (Data Center) or in your Atlassian account (Cloud).
