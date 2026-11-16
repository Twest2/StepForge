'use strict';

// Settings → AI with an OpenAI-compatible server: Test connection says what
// is wrong, offers a fix for it, and the fix is what Save keeps. The server
// is a local stand-in that answers the way an organization's LiteLLM gateway
// does: model names carry a prefix, an unknown model is refused with 403, and
// a reasoning model refuses any temperature but its default.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { withApp, readAppSettings } = require('./lib/fixtures');
const { eventually } = require('./lib/flows');

const MODELS = ['protected.gpt-5.6-terra', 'protected.gpt-4.1'];
const TEMPERATURE_ERROR = '🚫 **Invalid Request Error**\n\nlitellm.BadRequestError: Unsupported value: \'temperature\' does not support 0.2 with this model. Only the default (1) value is supported.\n\n*Error Code: 400*';

async function gateway(t) {
  const chats = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'GET' && req.url === '/openai/models') {
      res.end(JSON.stringify({ data: MODELS.map((id) => ({ id })) }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/openai/chat/completions') { res.statusCode = 404; res.end('{}'); return; }
    const request = JSON.parse(body);
    chats.push(request);
    if (!MODELS.includes(request.model)) { res.statusCode = 403; res.end('{"detail":"403: Forbidden"}'); return; }
    if ('temperature' in request) { res.statusCode = 400; res.end(JSON.stringify({ detail: TEMPERATURE_ERROR })); return; }
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'OK' } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { chats, url: `http://127.0.0.1:${server.address().port}/openai` };
}

/** Scrolls Settings with the mouse wheel until `selector` is fully on screen. */
async function scrollTo(app, selector) {
  const inView = () => app.evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    const view = document.querySelector('#modal-root .settings-content').getBoundingClientRect();
    const r = node && node.getBoundingClientRect();
    return Boolean(r) && r.top >= view.top && r.bottom <= view.bottom;
  })()`);
  await eventually(async () => {
    if (await inView()) return true;
    await app.wheel('#modal-root .settings-content', 300);
    return false;
  }, `${selector} on screen`);
}

const statusText = (app) => app.evaluate(`document.querySelector('#modal-root .ai-status-text')?.textContent || ''`);

test('Test connection names a wrong model and a refused temperature, and its fixes are saved', (t) => withApp('ai-settings-diagnosis', { sample: false }, async (app, env) => {
  const server = await gateway(t);
  await app.clickWhere('.welcome-btn', "el => el.querySelector('.welcome-btn-label')?.textContent === 'Settings'");
  await app.waitForVisible('.settings-nav');
  await app.clickText('AI', { scope: '.settings-nav' });
  await app.clickText('Enable AI', { scope: '#modal-root' });
  await app.selectOption('#modal-root select:has(option[value="openai"])', 'OpenAI-compatible server');
  await app.setValue('#modal-root input[type="url"]', server.url);
  await app.setValue('#modal-root input[list="openai-models"]', 'gpt-5.6-terra');
  await scrollTo(app, '#modal-root .settings-test');

  // A 403 that looks like a key problem: the server lists the model under another name.
  await app.clickText('Test connection', { scope: '#modal-root' });
  await eventually(async () => (await statusText(app)) === 'The server has no model named “gpt-5.6-terra”. Did you mean “protected.gpt-5.6-terra”?', 'model diagnosis');
  assert.deepEqual(await app.evaluate(`[...document.querySelectorAll('#openai-models option')].map((o) => o.value)`), MODELS, 'the Model box suggests the listed models');
  await app.clickText('Use “protected.gpt-5.6-terra”', { scope: '#modal-root' });

  // Then the model refuses StepForge's default temperature.
  await eventually(async () => /doesn’t accept a temperature of 0\.2/.test(await statusText(app)), 'temperature diagnosis');
  await scrollTo(app, '#modal-root .settings-test');
  await app.clickText('Details', { scope: '#modal-root' });
  const details = await app.evaluate(`[...document.querySelectorAll('#modal-root .ai-status-details dd')].map((dd) => dd.textContent)`);
  assert.deepEqual(details.slice(0, 2), [`POST ${server.url}/chat/completions`, '400']);
  assert.match(details[2], /^🚫 Invalid Request Error litellm\.BadRequestError: Unsupported value: 'temperature' does not support 0\.2/);
  await scrollTo(app, '#modal-root .ai-status-actions');
  await app.clickText('Use model default', { scope: '#modal-root' });

  await eventually(async () => (await statusText(app)) === `Connected to ${server.url} with protected.gpt-5.6-terra. Choose Save to keep the change.`, 'connected');
  assert.equal('temperature' in server.chats.at(-1), false, 'the last test sent no temperature');
  assert.equal(await app.evaluate(`document.querySelector('#modal-root .ai-temperature input').hidden`), true, 'no value box for Model default');

  await app.clickText('Save', { scope: '#modal-root' });
  await app.waitForGone('.settings-nav');
  const ai = await eventually(() => {
    const saved = readAppSettings(env.dataDir).ai;
    return saved?.provider === 'openai' && saved;
  }, 'AI settings saved');
  assert.equal(ai.temperature, null);
  assert.equal(ai.openai.model, 'protected.gpt-5.6-terra');
  assert.equal(ai.openai.baseUrl, server.url);
}));

test('a custom temperature is saved and kept within 0 to 2', () => withApp('ai-settings-temperature', { sample: false }, async (app, env) => {
  await app.clickWhere('.welcome-btn', "el => el.querySelector('.welcome-btn-label')?.textContent === 'Settings'");
  await app.waitForVisible('.settings-nav');
  await app.clickText('AI', { scope: '.settings-nav' });
  await app.clickText('Enable AI', { scope: '#modal-root' });
  await scrollTo(app, '#modal-root .ai-temperature');
  assert.equal(await app.evaluate(`document.querySelector('#modal-root .ai-temperature select').value`), 'custom', 'Custom 0.2 by default');
  assert.equal(await app.evaluate(`document.querySelector('#modal-root .ai-temperature input').value`), '0.2');
  await app.setValue('#modal-root .ai-temperature input', '5');
  await app.key('Tab');
  await eventually(async () => (await app.evaluate(`document.querySelector('#modal-root .ai-temperature input').value`)) === '2', 'clamped to 2');
  await app.setValue('#modal-root .ai-temperature input', '0.7');
  await app.clickText('Save', { scope: '#modal-root' });
  await app.waitForGone('.settings-nav');
  await eventually(() => readAppSettings(env.dataDir).ai?.temperature === 0.7, 'temperature 0.7 saved');

  await app.clickWhere('.welcome-btn', "el => el.querySelector('.welcome-btn-label')?.textContent === 'Settings'");
  await app.waitForVisible('.settings-nav');
  await app.clickText('AI', { scope: '.settings-nav' });
  await scrollTo(app, '#modal-root .ai-temperature');
  assert.equal(await app.evaluate(`document.querySelector('#modal-root .ai-temperature input').value`), '0.7', 'reopening Settings shows it');
}));
