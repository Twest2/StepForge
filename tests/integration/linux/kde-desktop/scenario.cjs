'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { createInterface } = require('node:readline');
const { CdpClient } = require('./cdp.cjs');
const { decodePng } = require('/opt/stepforge/core/png');
const { rasterToPng } = require('/opt/stepforge/core/image-format');
const data = process.env.STEPFORGE_DATA_DIR;
const report = [];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function until(fn, label, timeout = 20000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(100);
  }
  throw new Error('Timed out: ' + label);
}
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function steps() {
  const root = path.join(data, 'library/guides');
  if (!fs.existsSync(root)) return [];
  const guide = fs.readdirSync(root).find(g => fs.existsSync(path.join(root, g, 'guide.json')));
  if (!guide) return [];
  const dir = path.join(root, guide);
  return read(path.join(dir, 'guide.json')).stepsOrder.map(id => ({ dir: path.join(dir, 'steps', id), ...read(path.join(dir, 'steps', id, 'step.json')) }));
}
const pixel = (image, x, y) => [...image.data.subarray((y * image.width + x) * 4, (y * image.width + x) * 4 + 4)];
async function image(step) { return decodePng(await rasterToPng(fs.readFileSync(path.join(step.dir, step.image.workingPath)))); }
function passed(name, details = {}) { report.push({ name, ...details }); console.log('PASS ' + name + ' ' + JSON.stringify(details)); }

(async () => {
  const input = spawn('/usr/bin/python3', ['/artifacts/input.py'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const replies = [];
  let ready = false;
  createInterface({ input: input.stdout }).on('line', line => {
    const value = JSON.parse(line);
    if (value.ready) ready = true;
    else { const next = replies.shift(); if (next) value.error ? next.reject(new Error(value.error)) : next.resolve(value); }
  });
  const send = value => new Promise((resolve, reject) => { replies.push({ resolve, reject }); input.stdin.write(JSON.stringify(value) + '\n'); });
  await until(() => ready, 'Wayland input');
  let cdp;
  try {
    const target = await until(async () => {
      try { return (await (await fetch('http://127.0.0.1:9365/json/list')).json()).find(t => t.type === 'page' && t.url.includes('renderer/index.html')); } catch { return false; }
    }, 'app target');
    cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.connect();
    const evaluate = async expression => {
      const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const text = () => evaluate('document.body.innerText');
    const status = () => evaluate('document.querySelector("#capture-status")?.innerText || ""');
    const click = async label => {
      const point = await until(() => evaluate(`(() => {
        const root = document.querySelector('#modal-root')?.children.length ? document.querySelector('#modal-root') : document;
        const e = Array.from(root.querySelectorAll('button,[role="menuitem"],[role="tab"]')).find(e => (e.querySelector('.welcome-btn-label')?.textContent || e.textContent).trim() === ${JSON.stringify(label)} && e.getBoundingClientRect().width > 0);
        if(!e) return null;
        const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};
      })()`), 'button '+label);
      await cdp.send('Input.dispatchMouseEvent', {type:'mouseMoved',button:'none',...point});
      await cdp.send('Input.dispatchMouseEvent', {type:'mousePressed',button:'left',buttons:1,clickCount:1,...point});
      await cdp.send('Input.dispatchMouseEvent', {type:'mouseReleased',button:'left',buttons:0,clickCount:1,...point});
      await sleep(200);
    };
    const screenshot = name => {
      const file = '/artifacts/' + name + '.png';
      execFileSync('spectacle', ['--background','--fullscreen','--nonotify','--output', file], { stdio: 'pipe' });
      assert.ok(fs.existsSync(file));
      return decodePng(fs.readFileSync(file));
    };
    // KDE's own dialogs, found by window title through KWin's window search.
    // A dialog can appear later than expected on a slow machine, so wait for
    // it, click, and click again if it is still open.
    const hasWindow = title => execFileSync('gdbus', ['call', '--session', '--dest', 'org.kde.KWin', '--object-path', '/WindowsRunner',
      '--method', 'org.kde.krunner1.Match', title], { encoding: 'utf8' }).includes(`'${title}`);
    const answerDialog = async (title, points) => {
      await until(() => hasWindow(title), `the "${title}" dialog`, 60000);
      await sleep(500); // let it finish appearing before clicking
      for (let attempt = 0; attempt < 4; attempt++) {
        for (const point of points) await send({action:'click',...point});
        const end = Date.now() + 4000;
        while (Date.now() < end) { if (!hasWindow(title)) return; await sleep(200); }
      }
      throw new Error(`The "${title}" dialog did not close`);
    };
    const share = async () => {
      await until(async () => (await status()).includes('waiting for screen sharing'), 'sharing requested');
      // Pick the monitor, then Share.
      await answerDialog('Share screen with', [{x:460,y:260}, {x:860,y:785}]);
      await until(async () => (await status()).includes('on click'), 'recording armed');
      await sleep(500);
    };
    const key = code => send({action:'key',code,modifiers:[29,56]});
    const count = (n, label) => until(() => steps().length === n, label);
    // Approve the real KDE shortcut dialog, then use only app/desktop input.
    await answerDialog('Global Shortcuts Requested', [{x:744,y:686}]);
    await click('New Capture');
    await click('Start recording');
    await until(async () => (await text()).includes('StepForge tray icon beside the clock'), 'Plasma recording reminder');
    await click('Continue');
    await share();
    passed('real shortcut and monitor consent dialogs');
    const before = screenshot('verified-desktop-before-click');
    await send({action:'mirror',enabled:true});
    await send({action:'click',x:500,y:400});
    await count(1,'first click persisted');
    const first=steps()[0], firstImage=await image(first);
    assert.deepEqual(first.image.size,{width:1280,height:900});
    assert.equal(first.captureMetadata.windowTitle,'StepForge KDE recording target');
    assert.ok(Math.abs(first.annotations[0].x+first.annotations[0].w/2-500/1280)<1e-6);
    assert.ok(Math.abs(first.annotations[0].y+first.annotations[0].h/2-400/900)<1e-6);
    assert.deepEqual(pixel(firstImage,800,400),pixel(before,800,400));
    fs.writeFileSync('/artifacts/verified-first-capture.png', await rasterToPng(fs.readFileSync(path.join(first.dir,first.image.workingPath))));
    passed('pre-click PipeWire pixels, title, dimensions and marker');
    await sleep(1200);
    await send({action:'click',x:700,y:500});
    await count(2,'second click persisted');
    await send({action:'mirror',enabled:false});
    await key(46); // Ctrl+Alt+C
    await count(3,'capture hotkey');
    await key(25); // Ctrl+Alt+P
    await until(async () => (await status()).includes('paused'),'pause hotkey');
    await send({action:'click',x:600,y:450});
    await sleep(500);
    assert.equal(steps().length,3);
    await key(25);
    await share();
    await send({action:'mirror',enabled:true});
    await send({action:'click',x:550,y:420,button:273});
    await count(4,'right click after resume');
    assert.equal(steps().at(-1).captureMetadata.clickKind,'right');
    passed('capture hotkey, pause/resume, static frame and right-click recording');
    await send({action:'click',x:1112,y:872});
    await send({action:'mirror',enabled:false});
    await until(async () => (await status()).includes('paused'),'tray pause');
    await sleep(500);
    assert.equal(steps().length,4);
    passed('tray pause excludes its mouse click');
    await send({action:'click',x:1112,y:872,button:273});
    await send({action:'click',x:1100,y:840});
    await until(async () => (await status()).includes('stopped'),'tray finish');
    await click('More ▾');await click('Settings…');await click('Capture');
    const mode = await evaluate(`(() => { const e=Array.from(document.querySelectorAll('#modal-root select')).find(e=>Array.from(e.options).some(o=>o.value==='fullscreen')); const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,...mode});
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,...mode});
    await send({action:'key',code:108}); // down
    await send({action:'key',code:28});
    await click('Save');
    await until(() => read(path.join(data,'settings/app-settings.json')).capture.mode==='window','window mode saved');
    await click('Start recording');await share();
    await send({action:'mirror',enabled:true});
    await send({action:'click',x:520,y:410});
    await count(5,'window step');
    const win=steps().at(-1);
    assert.equal(win.captureMetadata.mode,'window');
    assert.equal(win.image.size.width,800);
    assert.ok(win.image.size.height>550&&win.image.size.height<650);
    assert.equal(win.captureMetadata.windowTitle,'StepForge KDE recording target');
    await send({action:'click',x:1112,y:872,button:273});
    await send({action:'click',x:1100,y:840});
    await send({action:'mirror',enabled:false});
    await until(async () => (await status()).includes('stopped'),'finish active window recording');
    await sleep(600);
    assert.equal(steps().length,5);
    passed('window crop and Finish excludes both tray/menu clicks',win.image.size);
    await click('Capture ▾');await click('Capture region');await sleep(2000);
    await send({action:'press',x:300,y:300});await send({action:'move',x:500,y:420});await send({action:'move',x:700,y:550});await send({action:'release',x:700,y:550});await sleep(300);await send({action:'key',code:28});
    await count(6,'selected region');
    const region=steps().at(-1), regionImage=await image(region);
    assert.equal(region.captureMetadata.mode,'region');
    assert.ok(regionImage.width>=400&&regionImage.width<=401);
    assert.ok(regionImage.height>=250&&regionImage.height<=251);
    assert.deepEqual(pixel(regionImage,200,100),pixel(regionImage,300,150));
    passed('Spectacle region selection',region.image.size);
    await click('Capture ▾');await click('Capture region');await sleep(2000);await send({action:'key',code:1});await sleep(400);
    assert.equal(steps().length,6);
    passed('region cancellation leaves guide unchanged');
    screenshot('verified-editor');
    fs.writeFileSync('/artifacts/desktop-test-results.json',JSON.stringify({passed:report,steps:steps().map(s=>({id:s.stepId,title:s.title,size:s.image.size,metadata:s.captureMetadata}))},null,2));
    console.log('Full Plasma desktop integration passed.');
  } finally { if(cdp) cdp.close(); input.kill('SIGTERM'); }
})().catch(e => { console.error(e);process.exitCode=1; });
