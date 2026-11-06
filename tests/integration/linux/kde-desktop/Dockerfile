FROM node:22-bookworm-slim AS node
FROM ubuntu:26.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    plasma-workspace plasma-desktop kwin-wayland xwayland xdg-desktop-portal-kde \
    pipewire wireplumber kde-spectacle dbus-x11 udev \
    python3-pywayland python3-cffi-backend python3-gi-cairo gir1.2-gtk-4.0 \
    plasma-wayland-protocols pkg-config libwayland-dev mesa-utils \
    && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY stepforge.deb /tmp/stepforge.deb
RUN apt-get update && apt-get install -y /tmp/stepforge.deb \
    && rm -rf /var/lib/apt/lists/* /tmp/stepforge.deb
COPY fixture /fixture
ENTRYPOINT ["bash", "/fixture/run.sh"]
