# Publishing StepForge in the Microsoft Store

This guide is for the maintainer. It covers the one-time Partner Center setup,
then what to do for each release. Users install by following
[Install StepForge from the Microsoft Store](microsoft-store.md).

The Store package is an `.appx` built by `npm run package:windows:store`
(`scripts/package-windows-store.js`). It isn't signed here: Microsoft signs it
when it passes certification. That signature is why Store users get no
SmartScreen warning. Publishing costs nothing: Microsoft doesn't charge
individual developers to register.

## One-time setup

### 1. Create a developer account

1. Go to [storedeveloper.microsoft.com](https://storedeveloper.microsoft.com)
   and choose **Get started** for an individual developer.
2. Sign in with your personal Microsoft account and fill in your details.
3. Pick a **publisher display name**. The Store shows it as the developer of
   StepForge, and it has to be unique in the Store.
4. Verify your identity with a government ID and a selfie when asked.

Verification usually finishes within a day or two. Partner Center emails you
when the account is ready.

### 2. Reserve the name

1. Open [Partner Center → Apps and games](https://partner.microsoft.com/dashboard/apps-and-games/overview).
2. Choose **New product → MSIX or PWA app**.
3. Enter **StepForge**, choose **Check availability**, then **Reserve product
   name**.

If **StepForge** is already taken, reserve a close variant such as **StepForge
Guides**. The Store shows that name in the listing and the Start menu, and the
package has to use exactly the name you reserved, so you enter it in the next
step. Only the name changes: the app, its data and its updates work the same.

### 3. Copy the identity into the repository

Put the name you reserved, and the values Partner Center assigned with it, into
`packaging/windows/store/identity.json`. For the last four, open the app in
Partner Center, then **Product management → Product identity**:

| `identity.json` key | Where it comes from | Looks like |
| --- | --- | --- |
| `displayName` | The name you reserved in step 2 | `StepForge` |
| `identityName` | Package/Identity/Name | `12345YourName.StepForge` |
| `publisher` | Package/Identity/Publisher | `CN=1A2B3C4D-…` |
| `publisherDisplayName` | Package/Properties/PublisherDisplayName | your publisher display name |
| `productId` | Store ID | `9N…`, 12 characters |

Commit the file. These values aren't secret: they're in the manifest of every
installed copy. `npm test` checks the file. While all five are empty, the
release workflow skips the Store package.

The Store ID also lets **Settings → About → Open Microsoft Store** open
StepForge's Store page directly. Without it, that button opens the Store's
updates page instead.

### 4. Point the docs at the listing (after the first release is live)

The docs link to a Store search for StepForge, which works before and after the
listing exists. Once the listing is live, you can swap
`https://apps.microsoft.com/search?query=StepForge` for
`https://apps.microsoft.com/detail/<Store ID>` in `README.md`,
`docs/windows_installation.md` and `docs/windows/microsoft-store.md`.

## Each release

1. Run the **Release** workflow as usual. Once `identity.json` is filled in,
   the **Build Windows installer** job also uploads an artifact named
   **microsoft-store-package**. It holds `StepForge <version> Microsoft
   Store.appx`, built from the same stamped checkout as the `.exe`. It isn't
   attached to the GitHub release.
2. Open the workflow run's **Summary**, download **microsoft-store-package**,
   and unzip it.
3. In Partner Center, open StepForge. For the first release choose **Start
   your submission**; after that, **Update** on the latest submission.
4. Under **Packages**, remove the previous package (for an update), upload the
   new `.appx`, and wait for it to be validated.
5. Choose **Submit for certification**.

Certification usually takes a few hours and sometimes up to three days. Then
the Store offers the update, and Windows installs it on users' PCs over the
next day or so. **Settings → About → Check for updates** may show a release
before the Store has it; the hint tells Store users that this can take a day or
two.

### Store version numbers

The Store reserves the fourth part of a version number and needs it to be 0,
and every package must have a higher version than the last one. The build turns
StepForge's version `a.b.c.d` into `a.b.(c×100+d).0`:

| StepForge version | Store package version |
| --- | --- |
| 1.5.3 | 1.5.300.0 |
| 1.5.3.1 | 1.5.301.0 |
| 1.6 | 1.6.0.0 |

So the fourth part of a StepForge version must stay below 100. Users see the
normal StepForge version in Settings → About.

## The first submission's other pages

Partner Center asks for these once. Later submissions copy them, and you only
change what's new.

**Pricing and availability:** Free, all markets, Public.

**Properties:**

- Category: **Productivity**.
- Privacy policy URL: `https://github.com/Twest2/StepForge/blob/main/docs/PRIVACY.md`.
- Website: `https://github.com/Twest2/StepForge`.
- Support contact: `https://github.com/Twest2/StepForge/issues`.

**Age ratings:** answer the IARC questionnaire for a productivity or utility
app. If it asks whether users can share content, say yes: users can publish
their own guides to the web (GitHub Pages) and to Confluence or Wiki.js.

**Store listing (English):**

- Description: the README introduction works.
- At least one screenshot: PNG, 1366×768 or larger. The editor with a recorded
  guide open shows the most.
- Short description, for example: "Record clicks as step-by-step guides with
  screenshots, then edit and export them to PDF, Word, HTML and more."

**Submission options → Restricted capabilities.** The package declares
`runFullTrust`, as every desktop (Electron) app does. Give this reason:

> StepForge is a desktop application. While the user is recording a guide, it
> needs full trust to detect their mouse clicks and take screenshots, and it
> saves guides to folders the user chooses.

**Notes for certification:**

> No account or sign-in is needed. To test: open StepForge, choose New guide,
> then Capture → Start capture session. Click anywhere on screen a few times,
> then stop the recording from the StepForge icon in the notification area.
> Each click becomes a step with a screenshot. Cloud sync, publishing and AI features are optional and
> off by default.

## Trying a package before you submit (optional)

This needs a Windows PC with **Developer Mode** turned on (**Settings → System →
For developers**). Uninstall any other StepForge first. Then, in PowerShell:

```powershell
$appx = "$HOME\Downloads\StepForge 1.6.0 Microsoft Store.appx"
$dir = "$env:TEMP\stepforge-appx"
Copy-Item $appx "$env:TEMP\stepforge.zip"
Expand-Archive "$env:TEMP\stepforge.zip" $dir -Force
Add-AppxPackage -Register "$dir\AppxManifest.xml"
```

StepForge then runs as it would from the Store. Check that:

- **Settings → About** shows the library in `%USERPROFILE%\StepForge`, not
  under `AppData` or `Documents`.
- **Check for updates** offers **Open Microsoft Store** for a newer release,
  and never **Update now**.
- `stepforge.exe --mcp` starts from a new terminal, and **Settings → AI → AI
  agents** shows that command.

Remove it afterwards with
`Get-AppxPackage *StepForge* | Remove-AppxPackage`.

The **Unit tests (windows-latest)** CI job also builds a package with a
placeholder identity on every pull request and uploads it as
**microsoft-store-test-package**. You can try that one the same way, but you
can't submit it, and it shows the repository's unreleased version number.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| The build says `identity.json` is missing or has an invalid value | Copy the values again from **Product management → Product identity**. All five must be filled in, except `productId`, which may be empty. |
| Partner Center says the package identity or publisher doesn't match | `identityName`, `publisher` and `publisherDisplayName` must match Product identity exactly, including case. |
| Partner Center says the display name isn't reserved | `displayName` must be exactly a name reserved for this app, including case and spaces. Reserved names are listed under **Product management → Manage app names**. |
| Partner Center says the version must be higher | Every submission needs a new StepForge version. Rebuilding the same version gives the same Store version. |
| The submission fails certification | Partner Center's report lists each failed test. Fix it, release a new version, and submit again. |
