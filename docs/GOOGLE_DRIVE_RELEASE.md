# Google sign-in: maintainer release configuration

End users only click **Sign in with Google**, choose their account, and allow
access. Never ask them for a key, client ID, client secret, or Cloud project.
Every official StepForge installation uses StepForge's public Desktop OAuth
application ID; each user receives their own account tokens.

## One-time registration for StepForge

The maintainer must register StepForge with Google before shipping sign-in:

1. Create StepForge's Google Cloud project and enable Google Drive access.
2. Configure the consent screen with the StepForge app name and the project's
   required contact, homepage, and privacy information.
3. Create a **Desktop app** OAuth client. Use only the narrow
   `https://www.googleapis.com/auth/drive.appdata` permission.
4. Configure the OAuth app for production distribution. Test-mode accounts and
   token lifetimes are not suitable for a general release. Complete any Google
   branding/verification requirements applicable to the registration.
5. Set the repository Actions variable **STEPFORGE_GOOGLE_CLIENT_ID** to the
   public client ID. This is an application identifier, not a secret or API key.
   Alternatively, commit that public ID into `app/google-oauth-config.json`.

There is no StepForge authentication server to deploy. The desktop client uses
PKCE, random state, the system browser, and a short-lived loopback callback.
Google's installed-app documentation lists `client_secret` as optional; this
flow sends no client secret in either code exchange or token refresh. Verify
both against the actual registered Desktop client before release.

## Build configuration

The Windows, Ubuntu, Fedora, and Launchpad release jobs run
`node scripts/configure-google-oauth.js` before packaging. The script embeds
the same public registration in `app/google-oauth-config.json` in each package.
Release jobs fail if no valid application ID is configured, instead of shipping
an apparently working sign-in button that cannot authenticate.

For a local maintainer build, set `STEPFORGE_GOOGLE_CLIENT_ID` in the build
shell and run the same script before launching/packaging. This is build-time
configuration only; users do not set environment variables or edit files.
Do not use another application's Google client ID or a fabricated placeholder.

The source checkout deliberately has an empty ID until StepForge's real
registration is supplied. Development/test builds without it keep local
features working and display “Google sign-in is unavailable in this build of
StepForge.” They do not ask users to configure it themselves.

Tokens stored by an earlier build with a different user-supplied registration
are not reused by the official client. The user signs in again; guides are
preserved. Changing Google projects also changes the associated app-storage
space, so keep StepForge's production registration stable between releases.

## Release verification

Follow the two-device checklist in [GOOGLE_DRIVE.md](GOOGLE_DRIVE.md). Also
check that the shipped sign-in button opens Google's consent page branded as
StepForge, no credential/setup fields appear, successful sign-in starts sync,
cancellation leaves sharing off, and the connection test refreshes tokens
successfully. Automated tests mock Google; they cannot validate the project's
production configuration or consent screen.

References: [Google Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app),
[Drive app storage](https://developers.google.com/workspace/drive/api/guides/appdata).
