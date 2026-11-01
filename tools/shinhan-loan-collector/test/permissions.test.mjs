import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const read = (name) => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

test('extension has exactly transient active-tab and scripting permissions', async () => {
  const manifest = JSON.parse(await read('manifest.json'));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual([...manifest.permissions].sort(), ['activeTab', 'scripting']);
  for (const key of ['host_permissions', 'optional_host_permissions', 'optional_permissions', 'background', 'content_scripts', 'externally_connectable', 'web_accessible_resources', 'update_url']) assert.equal(Object.hasOwn(manifest, key), false, key);
  assert.match(manifest.content_security_policy.extension_pages, /connect-src 'none'/u);
  assert.equal(manifest.action.default_popup, 'popup.html');
});

test('runtime code has no network, persistent storage, logs or automatic background collection', async () => {
  const sources = await Promise.all(['collector.js', 'popup.js', 'export.js'].map(read));
  for (const source of sources) {
    assert.doesNotMatch(source, /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource|sendBeacon|localStorage|sessionStorage|indexedDB)\b/u);
    assert.doesNotMatch(source, /chrome\.(?:storage|cookies|webRequest|alarms|history|downloads)/u);
    assert.doesNotMatch(source, /console\s*\.|\.innerHTML\s*=|\.outerHTML|document\.cookie/u);
    assert.doesNotMatch(source, /allFrames|frameIds|world\s*:\s*['"]MAIN['"]/u);
    for (const [, path] of source.matchAll(/from ['"]([^'"]+)['"]/gu)) assert.match(path, /^\.\//u);
  }
  const popup = sources[1];
  assert.match(popup, /captureButton\.addEventListener\('click', async/u);
  assert.match(popup, /exportButton\.addEventListener\('click'/u);
  assert.equal((popup.match(/executeScript\(/gu) ?? []).length, 1);
  assert.equal((popup.match(/link\.click\(\)/gu) ?? []).length, 1);
  assert.match(popup, /select\.value === '' \? null/u);
  const html = await read('popup.html');
  assert.match(html, /id="export"[^>]*disabled/u);
  assert.match(html, /<script type="module" src="popup.js"><\/script>/u);
  assert.doesNotMatch(html, /https?:\/\/|on(?:click|load)=/u);
});
