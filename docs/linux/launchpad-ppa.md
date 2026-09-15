# Publishing StepForge to Launchpad

The stable PPA is published automatically whenever GitHub publishes a stable
StepForge Release. The workflow lives at
`.github/workflows/release-ppa.yml`; it uploads a signed Debian **source**
package, and Launchpad builds and hosts the resulting `.deb`.

## One-time Launchpad setup

1. In Launchpad, activate the PPA feature and create the `stepforge` PPA for
   the `twest39` account. Its upload target is `ppa:twest39/stepforge`.
2. Confirm that the OpenPGP key used for uploads is registered on the same
   Launchpad account.
3. In GitHub, open the StepForge repository's **Settings → Secrets and
   variables → Actions** and add these repository secrets:

   | Secret | Value |
   | --- | --- |
   | `LAUNCHPAD_GPG_PRIVATE_KEY` | ASCII-armored private key for the Launchpad-registered signing key |
   | `LAUNCHPAD_GPG_KEY_ID` | Fingerprint (preferred) or long key ID for that signing key |
   | `LAUNCHPAD_GPG_PASSPHRASE` | Passphrase for the Launchpad signing key |

   Do not commit the private key to this repository. The workflow imports it
   only in the short-lived GitHub Actions runner that signs the upload.
4. Add these repository variables (their defaults are already in the workflow,
   so setting them is optional but makes the release configuration explicit):

   | Variable | Value |
   | --- | --- |
   | `LAUNCHPAD_PPA` | `ppa:twest39/stepforge` |
   | `LAUNCHPAD_SERIES` | `resolute` |

`resolute` is Ubuntu 26.04 LTS, the current StepForge GNOME 50 target. Change
the series only after validating StepForge's runtime dependencies on that
Ubuntu release.

## Release behavior

Publish a non-prerelease GitHub Release using the existing **Release** action
or the GitHub Releases page. Its tag must be numeric after the optional `v`
prefix, such as `v0.3.2.1`. The PPA workflow then:

1. checks out that tag and installs the pinned Node dependencies;
2. stages the same runtime-only payload used by `npm run package:linux:deb`;
3. creates and signs a source package for the configured Ubuntu series; and
4. uploads it with `dput` to the configured PPA.

Launchpad builds the `amd64` `.deb` and publishes it after the build passes.
GitHub prereleases are deliberately not uploaded to the stable PPA.

To confirm an upload, open the PPA's package details page and wait for the
Launchpad build to finish. A failed upload or build does not change the package
already available to apt users.

## Local source-package check

With Node dependencies and Debian development tools installed, a maintainer
can create a signed upload locally without sending it anywhere:

```bash
npm ci
sudo apt install devscripts dpkg-dev
bash scripts/launchpad/build-source-package.sh \
  --version 0.3.2.1 \
  --series resolute \
  --key YOUR_KEY_FINGERPRINT
```

The source upload appears under `build/launchpad/`. Do not run `dput` unless
you intend to publish that exact version to the PPA.
