Run `bash tests/checks/test_e2e_ui.sh` after `npm ci` with Node 22. Linux needs
`xvfb-run`, `xauth`, `dbus-run-session` and Electron's runtime libraries.
The document tests also need Poppler (`pdfinfo` and `pdftotext`).
The repository check runner includes this suite, and the dedicated UI job runs
it on every pull request. Missing Linux display tools are the only skip;
launch failures, missing document tools, crashes and failed assertions fail.

Each test launches real Electron with a fresh sample library and isolated
user-data directory. Linux uses a private Xvfb display and D-Bus session.
Actions use CDP mouse and keyboard input. DOM reads locate controls; tests do
not call renderer methods, DOM click handlers or IPC to perform app actions.
Native file pickers are answered from queues through the main inspector;
shell calls are recorded instead of opening external apps. Clipboard setup
supplies an external image, while pasting happens with Ctrl+V.

Assertions inspect persisted JSON, stored image pixels, exported Markdown and
HTML, Word's ZIP/XML and images, and PDF documents parsed by Poppler. Canvas
tests drag annotations and verify saved geometry and undo/redo. No assertions
search app source or logs. These tests do not exercise OS capture permissions,
cloud services or pasting into third-party apps.

Failure screenshots and app logs go to `.tmp/e2e-artifacts/` (uploaded by CI).
Set `STEPFORGE_E2E_ARTIFACTS` to change that location or `STEPFORGE_E2E_KEEP=1`
to retain temporary libraries for debugging. Container root can explicitly use
`STEPFORGE_ALLOW_NO_SANDBOX=1`; normal launches keep Chromium's sandbox.
