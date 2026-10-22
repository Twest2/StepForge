# Publish guides to Wiki.js

> **Beta.** Publishing to Wiki.js is new. It works with **Wiki.js 2.x**
> sites; Wiki.js 3 isn't supported yet.

StepForge can publish a guide as a Wiki.js page, with its screenshots uploaded
to the wiki. Publishing the same guide again updates that page, so its address
never changes.

If you'd rather upload by hand, **Export → Wiki.js** still makes a Markdown
file and a folder of screenshots.

## Connect your wiki

1. Open **Settings → Accounts → Wiki.js**.
2. Type your wiki's address, such as `wiki.example.com`, and choose
   **Continue**. You can also paste the address of any page on the wiki.
3. Sign in with one of these:
   - **Your username and password**, the ones you use on the wiki's own
     sign-in page. If the wiki has more than one way to sign in with a
     password (for example its own accounts and your company directory),
     choose which under **Sign in with**. If your account uses
     [two-step verification](#two-step-verification), StepForge then asks
     for a code.
   - **An [API key](#api-keys)**. Paste it in and choose **Connect**.

StepForge stores your password or API key encrypted with your operating
system's credential store. With a password, StepForge signs in again by itself
whenever Wiki.js needs it to.

Use an API key instead of a password when:

- the wiki only offers single sign-on (for example Microsoft, Google or Okta).
  StepForge says so after **Continue**;
- Wiki.js asks you to change your password, or to set up two-step
  verification. StepForge can't complete those steps; do them on the wiki in
  your browser, or use an API key.

## Two-step verification

If your account uses two-step verification, signing in takes your password
and then the 6-digit code from your authenticator app:

1. Enter your username and password and choose **Sign in**.
2. StepForge shows a **Verification code** field. Enter the code your app
   shows now and choose **Verify**.

You don't need a code each time you publish. StepForge keeps your Wiki.js
session, encrypted like your password, and Wiki.js renews it while you use
it. Wiki.js renews a session that's been unused for up to 14 days by default
(your administrator can change this under **Administration → Security**).

StepForge asks for a code again when Wiki.js has ended your session, for
example after a longer break, or if an administrator signed you out:

- **Publish to Wiki.js** asks for the code, then carries on publishing.
- **Settings → Accounts → Wiki.js** shows **Signed out on the wiki** with a
  code field.

If two-step verification is turned off for your account later, StepForge
notices the next time it signs in, and stops asking for codes.

If your account doesn't have two-step verification set up yet and the wiki
requires it, set it up on the wiki in your browser first, then sign in here.

## API keys

API keys are made by a Wiki.js administrator, and act for a group of users
rather than a person.

1. Sign in to the wiki as an administrator and open **Administration → API
   Access**. (StepForge's **Open API Access on your wiki** link goes there.)
2. If API access is off, turn it on first.
3. Choose **New API Key**. Name it `StepForge`, choose when it expires, and
   give it full access or a group that can write pages and upload files
   (`write:pages` and `write:assets`) where your guides go.
4. Copy the key. Wiki.js only shows it once.
5. Paste it into **Settings → Accounts → Wiki.js** in StepForge.

When the key expires or is revoked, publishing says Wiki.js didn't accept it:
make a new one, then **Sign out** and connect again with it.

## Publish a guide

Choose **Share → Publish to Wiki.js…** in the editor, or **Publish to
Wiki.js…** from a guide's menu in the library. Then check:

- **Path**: where the page goes, such as `guides/reset-a-password`. It
  starts as `guides/` (or the last folder you published to) followed by the
  guide's title. Use letters, numbers, dashes and underscores, with `/`
  between folders. Wiki.js keeps a few first words for itself, such as `login`
  or a language code like `en`.
- **Title**: the page title. It starts as the guide's title.
- **Language**: the page's language code, `en` unless your wiki uses others.

Choose **Publish**. When it's done, StepForge shows the page's link.

Before anything is sent, StepForge checks the guide's screenshots for private
details and blurs what it finds ([how](GETTING_STARTED.md#find-private-details)).
Choose **Review** to check the blurs.

The page is written in Markdown, published, and visible to everyone who can
read that part of the wiki. Its screenshots go in the wiki's assets, in a
folder with the same path as the page (for example
`guides/reset-a-password/step-001.png`), so step titles never end up in file
names.

### Publishing again

StepForge remembers each guide's page, so publishing again updates the same
page and replaces its screenshots. Wiki.js keeps the old version in the page's
history.

If someone edited the page on the wiki since you last published it, StepForge
asks first, and says who edited it and when: "This page was edited on the
wiki by Jane Doe on Oct 20 since you last published. Publishing will replace
those edits."

- **Open page** shows the page in your browser, so you can see the edits
  (the page's history lists them). The question stays open.
- **Publish anyway** replaces the page with the guide.
- **Cancel** keeps the wiki's version.

If your account can write pages but not manage them, Wiki.js doesn't tell
StepForge who made the edit, so the question leaves the name out.

StepForge also asks before replacing a page it didn't publish from this guide.

Tags added to the page on the wiki are kept when it's updated.

## Permissions

To publish, your account (or the API key's group) needs to be allowed to write
pages and upload files (`write:pages` and `write:assets`) at the page's path.
If publishing says you don't have permission, ask your wiki administrator to
check your group's permissions and page rules in **Administration → Groups**.

Wiki.js limits the size of uploaded files (5 MB by default). If a screenshot is
larger, an administrator can raise the limit.

## Sign out

**Sign out** removes the saved password or API key from this computer. Pages
you published stay on the wiki. To cut off an API key completely, revoke it in
**Administration → API Access**.
