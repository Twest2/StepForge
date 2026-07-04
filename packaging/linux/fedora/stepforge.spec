# StepForge RPM spec. The payload is prebuilt into a staging BuildRoot by
# packaging/linux/fedora/package.sh (which stages a pruned runtime tree), so
# this spec only packages and declares metadata — it does not compile.
#
# Placeholders @VERSION@ / @MAINTAINER@ are substituted by package.sh.

%global debug_package %{nil}
%global __brp_check_rpaths %{nil}
%define _build_id_links none

Name:           stepforge
Version:        @VERSION@
Release:        1%{?dist}
Summary:        Local-first step-by-step guide capture and export tool

License:        MPL-2.0
URL:            https://github.com/Twest2/StepForge

# Runtime shared libraries (Chromium/Electron) + capture integration.
Requires:       nss
Requires:       nspr
Requires:       atk
Requires:       at-spi2-atk
Requires:       cups-libs
Requires:       gtk3
Requires:       mesa-libgbm
Requires:       alsa-lib
Requires:       libxkbcommon
Recommends:     xinput
Recommends:     xdg-desktop-portal
Recommends:     pipewire

# The payload is architecture-specific (bundles the Electron binary).
%description
StepForge captures step-by-step workflows as screenshots, lets you annotate
and describe each step, and exports to Markdown, PDF, DOCX, PPTX, HTML, and
more. Local-first: no telemetry, with an optional user-configured local AI
integration. This package bundles a fixed Electron runtime and only
production dependencies; it does not install anything at runtime.

%files
/opt/stepforge
/usr/bin/stepforge
/usr/share/applications/stepforge.desktop
/usr/share/mime/packages/stepforge.xml
/usr/share/icons/hicolor/*/apps/stepforge.png
%license /usr/share/licenses/stepforge/LICENSE

%post
# Make the Chromium setuid sandbox helper usable so the app launches sandboxed.
HELPER=/opt/stepforge/node_modules/electron/dist/chrome-sandbox
if [ -e "$HELPER" ]; then
  chown root:root "$HELPER" || true
  chmod 4755 "$HELPER" || true
fi
if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database -q /usr/share/applications || true; fi
if command -v update-mime-database >/dev/null 2>&1; then update-mime-database /usr/share/mime || true; fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then gtk-update-icon-cache -q /usr/share/icons/hicolor || true; fi

%postun
if [ "$1" = 0 ]; then
  if command -v update-desktop-database >/dev/null 2>&1; then update-desktop-database -q /usr/share/applications || true; fi
  if command -v update-mime-database >/dev/null 2>&1; then update-mime-database /usr/share/mime || true; fi
  if command -v gtk-update-icon-cache >/dev/null 2>&1; then gtk-update-icon-cache -q /usr/share/icons/hicolor || true; fi
fi

%changelog
* Fri Jul 03 2026 @MAINTAINER@ - @VERSION@-1
- Production runtime-only package (pruned tree, fixed Electron runtime).
