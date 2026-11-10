import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseDeck } from '../src/shared/deck.js';
import { saveDeck } from '../src/main/deckStore.js';
import { materializeDesktopApp, launchDesktopApp, isEditorTarget, type RunningApp } from './support/desktopApp.js';
import { Cdp, eventually, findTarget, stopBrowser } from './support/browserSession.js';

let root: string, app: RunningApp | undefined, cdp: Cdp | undefined, main: Cdp | undefined;
afterEach(async () => {
  cdp?.close(); main?.close(); await stopBrowser(app?.process ?? null);
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
it('both T3 buttons open without creating a project, including an unmapped remote deck', async () => {
  root = await mkdtemp(join(tmpdir(), 'deckwerk-t3-'));
  const deckDir = join(root, 'VPO-Base'), profile = join(root, 'profile'), appDir = join(root, 'app');
  await mkdir(join(deckDir, '.deckwerk-remote'), { recursive: true }); await mkdir(profile);
  const deck = parseDeck({ version: 1, title: 'VPO-Base', slides: [{ id: 's1', elements: [] }] });
  await saveDeck(deckDir, deck);
  await writeFile(join(deckDir, 'theme.css'), '');
  await writeFile(join(deckDir, '.deckwerk-remote/base.json'), JSON.stringify(deck));
  await writeFile(join(deckDir, '.deckwerk-remote/sync.json'), JSON.stringify({
    version: 1, server: 'http://127.0.0.1:9', deckId: 'VPO-Base', title: deck.title, seq: 0, themeCss: '', savedAt: new Date().toISOString(),
  }));
  await materializeDesktopApp(appDir, 'deckwerk-t3-test');
  app = await launchDesktopApp(appDir, [deckDir, '--inspect=0'], { profileDir: profile });
  const target = await findTarget(app.debugPort, isEditorTarget, app.log);
  cdp = await Cdp.connect(target.webSocketDebuggerUrl!);
  await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  const inspector = await fetch(`http://127.0.0.1:${app.inspectorPort}/json/list`).then(r => r.json()) as Array<{ webSocketDebuggerUrl: string }>;
  main = await Cdp.connect(inspector[0]!.webSocketDebuggerUrl);
  const evaluate = async <T>(expression: string): Promise<T> => {
    const result = await main!.call('Runtime.evaluate', { expression, includeCommandLineAPI: true, returnByValue: true }) as { result: { value: T } };
    return result.result.value;
  };
  // Only the OS handoff is captured. The real buttons, save, IPC, mirror/config
  // reads and launcher run, without opening T3 or touching the user's clipboard.
  await evaluate(`globalThis.t3Launches = []; globalThis.t3Context = '';
    require('electron').clipboard.writeText = text => { globalThis.t3Context = text; };
    require('electron').shell.openExternal = async url => { globalThis.t3Launches.push({url}); };
    const cp = require('node:child_process'); const original = cp.execFile;
    cp.execFile = function(file, args, options, callback) {
      if (file === '/usr/bin/open' || file.endsWith('/t3')) {
        globalThis.t3Launches.push({file, args}); callback(null, '', ''); return {};
      }
      return original.apply(this, arguments);
    }; require('node:module').syncBuiltinESMExports();`);
  await eventually(() => cdp!.evaluate<string>(`window.api.getDeck().then(s => s?.deck.title ?? '')`), 'deck loaded', t => t === 'VPO-Base');
  await eventually(() => cdp!.evaluate<boolean>(`[...document.querySelectorAll('button')].some(b => ['More', 'Open with T3 Remote'].includes(b.textContent.trim()) && b.getBoundingClientRect().width > 0)`), 'T3 toolbar painted');
  await eventually(() => cdp!.evaluate<string>(`document.querySelector('#status')?.textContent?.replace(/\\s+/g, ' ') ?? ''`), 'opening finished', text => text === 'VPO-Base · slide 1/1');
  for (const mode of ['Remote', 'Local']) {
    const visible = await cdp.evaluate<boolean>(`[...document.querySelectorAll('button')].some(b => b.textContent === 'Open with T3 ${mode}' && b.getBoundingClientRect().width > 0)`);
    if (!visible) await cdp.clickByText('button', 'More');
    await cdp.clickByText(visible ? 'button' : '[role=menuitem]', `Open with T3 ${mode}`);
    const message = await eventually(() => cdp!.evaluate<string>(`document.body.innerText`), 'T3 launch completed', t => t.includes('Could not open T3:') || t.includes(`${mode === 'Remote' ? 'server' : 'local'} deck context copied`));
    expect(message).not.toContain('Could not open T3:');
    expect(message).toContain(mode === 'Remote' ? 'server' : 'local');
    const context = await evaluate<string>('globalThis.t3Context');
    expect(context).toContain('VPO-Base');
    expect(context).toContain(mode === 'Remote' ? 'http://127.0.0.1:9' : deckDir);
    await evaluate(`globalThis.t3Context = ''`);
  }
  const launches = await evaluate<Array<{ file?: string; args?: string[]; url?: string }>>('globalThis.t3Launches');
  expect(launches).toHaveLength(2);
  expect(launches.every(l => l.url === 't3code://' || (l.file === '/usr/bin/open' && l.args?.join(' ') === '-b com.t3tools.t3code'))).toBe(true);
}, 120_000);
