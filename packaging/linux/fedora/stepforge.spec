# StepForge RPM spec. The payload is prebuilt into a staging BuildRoot by
# packaging/linux/fedora/package.sh (which stages a pruned runtime tree), so
# this spec only packages and declares metadata — it does not compile.
#
# Placeholders @VERSION@ / @MAINTAINER@ are substituted by package.sh.

%global debug_package %{nil}
%global __brp_check_rpaths %{nil}
%define _build_id_links none
# Electron and OCR binaries are prebuilt upstream. Do not strip, rewrite
# Python shebangs, or byte-compile this shared runtime payload.
%global __os_install_post %{nil}
# Do not export private bundled libraries as system RPM capabilities.
%global __provides_exclude_from ^/opt/stepforge/.*$
# Electron and Sharp resolve these private libraries from bundled runtime directories.
# Preserve automatic detection of all other system library requirements.
%global __requires_exclude ^(libffmpeg[.]so|libvips-cpp[.]so).*$

Name:           stepforge
Version:        @VERSION@
Release:        1%{?dist}
Summary:        Local-first step-by-step guide capture and export tool

License:        Apache-2.0
URL:            https://github.com/Twest2/StepForge

# Runtime shared libraries (Chromium/Electron) + capture integration.
Requires:       nodejs >= 22.12.0
Requires:       nss
Requires:       nspr
Requires:       atk
Requires:       at-spi2-atk
Requires:       cups-libs
Requires:       gtk3
Requires:       mesa-libgbm
Requires:       alsa-lib
Requires:       libxkbcommon
Requires:       at-spi2-core
Requires:       libdrm
Requires:       libXcomposite
Requires:       libXdamage
Requires:       libXfixes
Requires:       libXrandr
Requires:       libxshmfence
# Same consented portal pipeline as the Ubuntu package, on GNOME 50 (with the
# bundled Shell extension) or KDE Plasma 6 (KWin script + input devices).
# GNOME is not pulled onto Plasma systems; only a mismatched GNOME is refused.
Conflicts:      gnome-shell < 50
Conflicts:      gnome-shell >= 51
Requires:       python3
Requires:       python3-gobject
Requires:       gdk-pixbuf2
Requires:       gstreamer1
Requires:       gstreamer1-plugins-base
Requires:       pipewire-gstreamer
Requires:       glib2
Requires:       xdg-desktop-portal
Requires:       (xdg-desktop-portal-gnome or xdg-desktop-portal-kde)
Requires:       (spectacle if xdg-desktop-portal-kde)
Requires:       pipewire
Requires:       wireplumber
Recommends:     xinput
Recommends:     libsecret

# The payload is architecture-specific (bundles the Electron binary).
%description
StepForge captures step-by-step workflows as screenshots, lets you annotate
and describe each step, and exports to Markdown, PDF, DOCX, PPTX, HTML, and
more. Local-first: no telemetry, with an optional user-configured local AI
integration. This package bundles a fixed Electron runtime and only
production dependencies; it does not install anything at runtime.

%files
%defattr(-,root,root,-)
/opt/stepforge
%attr(4755,root,root) /opt/stepforge/node_modules/electron/dist/chrome-sandbox
/usr/bin/stepforge
/usr/share/applications/stepforge.desktop
/usr/share/mime/packages/stepforge.xml
/usr/share/gnome-shell/extensions/tyler@stepforge.dev
/usr/lib/udev/rules.d/60-stepforge-input.rules
/usr/share/icons/hicolor/*/apps/stepforge.png
%license /usr/share/licenses/stepforge/LICENSE

%post
# Add the StepForge DNF repository so an RPM downloaded from GitHub updates
# with dnf upgrade. Skip it when a repo file already points there (set up by
# hand, or disabled by the user). The file name and repo id match the manual
# instructions, which overwrite it. The repository only publishes x86_64.
if [ "$(uname -m)" = x86_64 ] &&
   ! grep -qs 'packages\.twestbrook\.com/rpm/stepforge-rpm' /etc/yum.repos.d/*.repo; then
  mkdir -p /etc/yum.repos.d
  cat > /etc/yum.repos.d/stepforge-rpm.repo <<'REPO'
# Added by the stepforge package so StepForge updates with dnf upgrade.
# Removed with the package. Set enabled=0 to stop updates.
[stepforge-rpm]
name=StepForge RPM Repository
baseurl=https://packages.twestbrook.com/rpm/stepforge-rpm/
enabled=1
gpgcheck=0
REPO
  chmod 0644 /etc/yum.repos.d/stepforge-rpm.repo
fi

# Make the Chromium setuid sandbox helper usable so the app launches sandboxed.
HELPER=/opt/stepforge/node_modules/electron/dist/chrome-sandbox
if [ -e "$HELPER" ]; then
  chown root:root "$HELPER" || true
  chmod 4755 "$HELPER" || true
fi
if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database -q /usr/share/applications || true; fi
if command -v update-mime-database >/dev/null 2>&1; then update-mime-database /usr/share/mime || true; fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then gtk-update-icon-cache -q /usr/share/icons/hicolor || true; fi
# Apply the mouse/touchpad access rule to devices already plugged in.
if command -v udevadm >/dev/null 2>&1; then
  udevadm control --reload-rules >/dev/null 2>&1 || true
  udevadm trigger --subsystem-match=input --action=change >/dev/null 2>&1 || true
fi

%postun
if [ "$1" = 0 ]; then
  # Drop the repository the %%post added; leave a repo file written by hand.
  if grep -qs '^# Added by the stepforge package' /etc/yum.repos.d/stepforge-rpm.repo; then
    rm -f /etc/yum.repos.d/stepforge-rpm.repo
  fi
  if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database -q /usr/share/applications || true; fi
  if command -v update-mime-database >/dev/null 2>&1; then update-mime-database /usr/share/mime || true; fi
  if command -v gtk-update-icon-cache >/dev/null 2>&1; then gtk-update-icon-cache -q /usr/share/icons/hicolor || true; fi
  if command -v udevadm >/dev/null 2>&1; then
    udevadm control --reload-rules >/dev/null 2>&1 || true
    udevadm trigger --subsystem-match=input --action=change >/dev/null 2>&1 || true
  fi
fi

%changelog
* Fri Jul 03 2026 @MAINTAINER@ - @VERSION@-1
- Production runtime-only package (pruned tree, fixed Electron runtime).
