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
   - **Confluence Cloud:** enter your Atlassian email address and an API token.
     **Create an API token** opens Atlassian's token page.
   - **Data Center or Server:** use one of these.
     - **Personal access token.** Create one on your site (**Create a token on
       your site** opens the page) and paste it in.
     - **Sign in with your browser**, for single sign-on or a smart card.
       Your site's own login page opens in a StepForge window. Sign in as
       usual; the window closes by itself when you're done.
4. Choose the space for new pages and, if you like, a parent page to put them
   under.

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
