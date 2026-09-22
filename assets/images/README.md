# StepForge artwork

`StepForge_logo.png`, `StepForge_logo.ico`, and `StepForge_logo.svg` are the supplied application artwork. Keep these originals together when updating the icon.

Run `npm run icons` after replacing the originals. Commit the generated files in `app/assets/` and `packaging/assets/` alongside the sources.

- The app window uses the bundled ICO on Windows and PNG on Linux.
- Windows executable, installer, uninstaller, and shortcuts use the ICO.
- Linux packages install the generated PNG sizes into the desktop icon theme.
- Chocolatey uses the generated 128px PNG from the repository.
