'use strict';

const fs = require('node:fs');
const { GuideStore } = require('./store');
const { buildRenderAst } = require('./renderast');
const raster = require('./raster');
const text = require('./text-raster');
const { encodePng } = require('./png');

/**
 * The sample guide Settings → Branding's Design preview exports, so a brand
 * profile can be checked without opening a real guide. It's written to a
 * throwaway guide store in `dir` and exported like any other guide.
 */

const INK = [32, 41, 54, 255];
const MUTED = [110, 120, 134, 255];

/** A plain app window: a sidebar, a form, and a Save button. */
function sampleScreenshot(accent) {
  const W = 960;
  const H = 560;
  const img = raster.createImage(W, H, [243, 245, 248, 255]);
  raster.fillRect(img, 0, 0, W, 44, [255, 255, 255, 255]);
  raster.fillRect(img, 0, 44, W, 1, [222, 226, 232, 255]);
  text.drawText(img, 20, 13, 'Admin Center', 17, INK, { weight: 'bold' });
  raster.fillRect(img, 0, 45, 200, H - 45, [250, 251, 252, 255]);
  raster.fillRect(img, 200, 45, 1, H - 45, [222, 226, 232, 255]);
  ['Users', 'Groups', 'Devices', 'Settings'].forEach((label, i) => {
    if (i === 0) raster.fillRoundRect(img, 10, 62 + i * 40, 180, 32, 6, [229, 236, 246, 255]);
    text.drawText(img, 26, 70 + i * 40, label, 15, i === 0 ? INK : MUTED, { weight: i === 0 ? 'bold' : 'regular' });
  });
  raster.fillRoundRect(img, 232, 72, 696, 420, 10, [255, 255, 255, 255]);
  text.drawText(img, 260, 96, 'Reset password', 20, INK, { weight: 'bold' });
  [['User', 'casey@example.com'], ['New password', '••••••••••'], ['Confirm password', '••••••••••']].forEach(([label, value], i) => {
    const y = 148 + i * 82;
    text.drawText(img, 260, y, label, 14, MUTED);
    raster.fillRoundRect(img, 260, y + 24, 420, 38, 6, [222, 226, 232, 255]);
    raster.fillRoundRect(img, 261, y + 25, 418, 36, 5, [255, 255, 255, 255]);
    text.drawText(img, 274, y + 34, value, 15, INK);
  });
  raster.fillRoundRect(img, 760, 424, 140, 42, 8, accent);
  text.drawTextCentered(img, 830, 445, 'Save', 16, [255, 255, 255, 255], { weight: 'bold' });
  return img;
}

/**
 * Write the sample guide under `dir` and return its render AST with
 * `branding` (a BrandingStore.resolve() result, or null) applied.
 */
function buildSampleAst({ dir, branding = null, codeStyle, reviewDays, now = new Date() } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const store = new GuideStore(dir);
  const guide = store.createGuide({
    title: 'Reset a user’s password',
    descriptionHtml: '<p>How the service desk resets a password in the <strong>Admin Center</strong>. Takes about two minutes.</p>',
    metadata: { author: 'IT Service Desk', organization: 'Example Co.', softwareVersion: '2026.4' },
  });

  const shot = sampleScreenshot([37, 99, 235, 255]);
  const size = { width: shot.width, height: shot.height };
  store.addStep(guide.guideId, {
    title: 'Open Users in the Admin Center',
    descriptionHtml: '<p>Sign in, then choose <b>Users</b> in the sidebar. Search for the person by name or email.</p>',
    annotations: [{ type: 'rect', x: 0.01, y: 0.105, w: 0.19, h: 0.065, style: { stroke: '#E5484D', strokeWidth: 4, fill: 'transparent' } }],
  }, encodePng(shot), size);
  store.addStep(guide.guideId, {
    title: 'Enter a temporary password',
    descriptionHtml: '<p>Type a temporary password twice. <a href="https://example.com/password-policy">The password policy</a> lists the rules.</p>',
    textBlocks: [{ position: 'after-description', level: 'warn', title: 'Check who is asking', descriptionHtml: '<p>Confirm the person’s identity before you reset anything.</p>' }],
    annotations: [{ type: 'number', value: 1, x: 0.26, y: 0.3, w: 0.05, h: 0.085, style: { stroke: '#E5484D' } }],
  }, encodePng(shot), size);
  store.addStep(guide.guideId, {
    title: 'Save and tell the user',
    descriptionHtml: '<p>Choose <b>Save</b>. The user is asked to pick a new password the next time they sign in.</p>',
    textBlocks: [{ position: 'after-image', level: 'success', title: 'Tip', descriptionHtml: '<p>Send the temporary password by phone, not email.</p>' }],
    codeBlocks: [{ id: 'cb1', language: 'powershell', code: 'Set-ADAccountPassword -Identity casey -Reset\nSet-ADUser -Identity casey -ChangePasswordAtLogon $true' }],
    tableBlocks: [{ id: 'tb1', rows: [['Account type', 'Who can reset'], ['Staff', 'Service desk'], ['Admins', 'Security team']] }],
    annotations: [{ type: 'rect', x: 0.785, y: 0.75, w: 0.155, h: 0.09, style: { stroke: '#E5484D', strokeWidth: 4, fill: 'transparent' } }],
  }, encodePng(shot), size);

  return buildRenderAst(store, guide.guideId, { now, codeStyle, reviewDays, branding });
}

module.exports = { buildSampleAst, sampleScreenshot };
