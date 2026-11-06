'use strict';

// Keep the proven Windows service byte-for-byte intact. Only native GNOME and
// KDE Plasma 6 Wayland select their subclasses; X11 and other platforms keep
// their path.
function captureServiceClass(platform = process.platform, env = process.env) {
  const desktop = require('./linux/desktop').waylandCaptureDesktop(platform, env);
  if (desktop === 'gnome') return require('./linux/gnome-capture');
  if (desktop === 'plasma') return require('./linux/kde-capture');
  return require('../capture');
}

module.exports = { captureServiceClass };
