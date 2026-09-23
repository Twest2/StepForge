# Google sign-in: maintainer guide

*For StepForge maintainers.* Users never need any of this: they click **Sign in
with Google**, pick an account, and allow access. Never ask a user for a client
ID, secret, API key, or Cloud project.

Every official build uses StepForge's single public **Desktop OAuth client**.
Each user gets their own tokens for their own account.

## How sign-in works

- The system browser opens Google's consent page (OAuth 2.0 for installed apps).
- StepForge uses **PKCE** and a random `state`, and receives the callback on a
  short-lived listener bound to `127.0.0.1`.
- The only scope requested is `https://www.googleapis.com/auth/drive.appdata`.
- There is no StepForge authentication server.

## One-time registration

1. Create the StepForge Google Cloud project and enable the Google Drive API.
2. Configure the OAuth consent screen with the StepForge name, contact
   address, homepage, privacy policy, and terms of service. The StepForge
   website provides all three (`/`, `/privacy/`, `/terms/`) and its README has
   a field-by-field checklist. The website's domain must be verified in Google
   Search Console.
3. Create an OAuth client of type **Desktop app**, restricted to the
   `drive.appdata` scope.
4. Move the app to **production** and complete any branding or verification
   Google requires. Testing mode limits sign-in to listed test users and
   shortens token lifetimes, so it isn't suitable for general release.
5. Set the GitHub Actions variable **`STEPFORGE_GOOGLE_CLIENT_ID`** to the
   client ID. It's a public application identifier, not a secret.

> [!CAUTION]
> Keep the production registration stable between releases. Changing the
> Google project changes the app-storage space, so existing users would no
> longer see their synced guides.

## Release builds

The Windows, Ubuntu, Fedora, and Launchpad release jobs run
`node scripts/configure-google-oauth.js` before packaging. It writes the
client into `app/google-oauth-config.json` inside each package. **A release job
fails if no valid client is configured**, so a build can't ship a sign-in
button that doesn't work.

To produce a signed-in build locally, set `STEPFORGE_GOOGLE_CLIENT_ID` (and
`STEPFORGE_GOOGLE_CLIENT_SECRET` if the registered client has one) in the build
shell and run the same script before packaging. Never use another
application's client ID or a placeholder.

The source tree deliberately ships an empty client ID; never commit the real
one. Builds without a client show *"Google sign-in is unavailable in this build
of StepForge"* and every local feature keeps working.

## Signing in from a development checkout

Copy the client from an installed Linux release into a gitignored,
owner-only file at the repository root:

```bash
npm run setup:google-dev
```

This reads `/opt/stepforge/app/google-oauth-config.json` and writes
`google-oauth.local.json`, which sits outside `app/` so packaging never picks
it up. Other options:

```bash
npm run setup:google-dev -- --from path/to/google-oauth-config.json
STEPFORGE_GOOGLE_CLIENT_ID=… STEPFORGE_GOOGLE_CLIENT_SECRET=… npm run setup:google-dev
npm run setup:google-dev -- --remove
```

A development build also reads both environment variables directly. Release
builds always use their stamped client and ignore them.

> [!WARNING]
> Development and release builds share the same library by default, and
> **Free up space** and **Replace Drive with this computer** affect everything
> stored for the Google account. Test against a separate library:
>
> ```bash
> STEPFORGE_DATA_DIR="$HOME/.local/share/stepforge-dev" npm start
> ```
>
> For completely separate Drive data, use a second Google account (added as a
> test user while the app is in testing).

Development builds keep their sign-in with their own library folder and never
touch the release build's saved credentials. Tokens from an earlier build with
a different client aren't reused; the user signs in again and their guides are
preserved.

## Release checklist

Automated tests mock Google, so check these by hand against the real
registration before each release that touches sync:

- [ ] **Sign in with Google** opens a consent page branded as StepForge, with
      no setup or credential fields in the app.
- [ ] Successful sign-in starts syncing; cancelling leaves sync off.
- [ ] **Test connection** passes, including the token refresh.
- [ ] With two computers on the same account: a new guide on one appears on
      the other, edits flow both ways, and editing on both before syncing
      produces a conflict copy.
- [ ] **Versions → Restore**, **Free up space**, and **Delete from Drive**
      behave as described in [GOOGLE_DRIVE.md](GOOGLE_DRIVE.md).
- [ ] **Disconnect** stops syncing and keeps local and Drive guides.

References: [OAuth for desktop apps](https://developers.google.com/identity/protocols/oauth2/native-app),
[Drive app data folder](https://developers.google.com/workspace/drive/api/guides/appdata),
[Drive uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads).
