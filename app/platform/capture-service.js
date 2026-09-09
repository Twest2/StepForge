'use strict';

// Keep the proven Windows service byte-for-byte intact. Only native GNOME
// Wayland selects the new subclass; X11 and other platforms keep their path.
function captureServiceClass(platform = process.platform, env = process.env) {
  const wayland = env.XDG_SESSION_TYPE
    ? env.XDG_SESSION_TYPE.toLowerCase() === 'wayland' : Boolean(env.WAYLAND_DISPLAY);
  if (platform === 'linux' && wayland && /gnome|ubuntu/i.test(env.XDG_CURRENT_DESKTOP || '')) {
    return require('./linux/gnome-capture');
  }
  return require('../capture');
}

module.exports = { captureServiceClass };
