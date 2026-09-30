# OneDrive and Dropbox sign-in: maintainer guide

*For StepForge maintainers.* Users never need any of this: they choose
**Sign in with Microsoft** or **Sign in with Dropbox** and allow access. See
[CLOUD_ACCOUNTS.md](../CLOUD_ACCOUNTS.md) for the user guide.

Nextcloud and WebDAV need no registration; they work in every build.

OneDrive and Dropbox each need one app registration for StepForge. Both are
**public clients using PKCE**: there is no secret, and the IDs below are
public identifiers, not credentials. Each user signs in to their own account
and gets their own tokens.

## OneDrive (Microsoft Entra)

1. Sign in to the [Microsoft Entra admin center](https://entra.microsoft.com)
   (any Microsoft account works) and open **App registrations → New
   registration**.
2. **Name:** `StepForge`. OneDrive shows StepForge's folder as
   `Apps/StepForge`, taken from this name, so don't rename the app later.
3. **Supported account types:** *Accounts in any organizational directory
   and personal Microsoft accounts*.
4. **Redirect URI:** platform *Public client/native (mobile & desktop)*,
   value `http://localhost`. Microsoft ignores the port for `localhost`, so
   StepForge can use any free port.
5. After it's created, open **Authentication** and set **Allow public client
   flows** to *Yes*.
6. Open **API permissions → Add a permission → Microsoft Graph → Delegated**
   and add `Files.ReadWrite.AppFolder`, `User.Read` and `offline_access`.
   Don't add `Files.ReadWrite` or `Files.ReadWrite.All`; StepForge only needs
   its own folder. No admin consent is needed for personal accounts; some
   organizations require an administrator to approve new apps.
7. Copy the **Application (client) ID** from **Overview** and set the GitHub
   Actions variable **`STEPFORGE_ONEDRIVE_CLIENT_ID`** to it.


## Dropbox

1. Open the [Dropbox App Console](https://www.dropbox.com/developers/apps) and
   choose **Create app**.
2. **Scoped access**, **App folder**, name `StepForge`. Dropbox creates
   `Apps/StepForge` for each user.
3. On **Permissions**, tick `files.metadata.read`, `files.content.read`,
   `files.content.write` and `account_info.read`, then **Submit**.
4. On **Settings → OAuth 2 → Redirect URIs**, add all three:
   `http://localhost:38461/`, `http://localhost:38462/`,
   `http://localhost:38463/`. Dropbox matches ports exactly, so StepForge tries
   these in order in case one is busy.
5. Leave **Allow public clients (Implicit Grant & PKCE)** set to *Allow*.
6. Set the GitHub Actions variable **`STEPFORGE_DROPBOX_APP_KEY`** to the **App
   key**. The app secret isn't used.
7. A new Dropbox app is limited to 500 users until it's approved. Before a
   wide release, choose **Apply for production** on the app's settings page.

> [!CAUTION]
> Keep both registrations stable between releases. A new registration signs
> everyone out and, for Dropbox and OneDrive, uses a different app folder, so
> synced guides would seem to disappear.

## Release builds

The Windows, Ubuntu, Fedora and Launchpad release jobs run
`node scripts/configure-cloud-apps.js`, which writes both IDs into
`app/cloud-apps-config.json` inside the package. **A release job fails if
either one is missing**, so a build never ships a sign-in button that can't
work. The source tree keeps both empty; never commit real values.

## Development builds

A development checkout reads the IDs from the environment
(`STEPFORGE_ONEDRIVE_CLIENT_ID`, `STEPFORGE_DROPBOX_APP_KEY`) or from a
gitignored `cloud-apps.local.json` at the repository root:

```json
{ "onedriveClientId": "…", "dropboxAppKey": "…" }
```

Without them, OneDrive and Dropbox show "unavailable in this build" and
everything else works.

## Release checklist

Automated tests mock both services, so check these by hand before a release
that touches sync:

- [ ] **Sign in with Microsoft** works with a personal account, and the
      consent page asks only for StepForge's own folder.
- [ ] **Sign in with Dropbox** works, and `Apps/StepForge` appears.
- [ ] Nextcloud: signing in through the browser works, and so does a user
      name and app password.
- [ ] Switching from one service to another asks first, and guides upload to
      the new one.
- [ ] **Test connection** passes on each service.
