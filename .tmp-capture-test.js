// Probe desktopCapturer under WSLg: can we actually grab a screen?
const { app, desktopCapturer, screen } = require('electron');
app.whenReady().then(async () => {
  try {
    const display = screen.getPrimaryDisplay();
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 800, height: 600 },
    });
    console.log('SOURCES:', sources.length);
    for (const s of sources.slice(0, 5)) {
      console.log(' -', s.id, JSON.stringify(s.name), 'empty:', s.thumbnail.isEmpty(), 'size:', JSON.stringify(s.thumbnail.getSize()));
    }
  } catch (err) {
    console.log('CAPTURE-ERROR:', err.message);
  }
  app.quit();
});
