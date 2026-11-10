import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { T3Chats } from '../src/server/t3Chats.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { parseDeck } from '../src/shared/deck.js';
import { saveDeck } from '../src/main/deckStore.js';
import { materializeDesktopApp, launchDesktopApp, isEditorTarget, type RunningApp } from './support/desktopApp.js';
import { Cdp, eventually, findTarget, stopBrowser } from './support/browserSession.js';

let server: RunningCollabServer | undefined;
let root: string, app: RunningApp | undefined, cdp: Cdp | undefined, main: Cdp | undefined;
afterEach(async () => {
  cdp?.close(); main?.close(); await stopBrowser(app?.process ?? null); await server?.close();
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
it('the Agent menu opens local and remote chats, with Remote reusing a No project server conversation', async () => {
  root = await mkdtemp(join(tmpdir(), 'deckwerk-t3-'));
  const deckDir = join(root, 'VPO-Base'), profile = join(root, 'profile'), appDir = join(root, 'app');
  await mkdir(join(deckDir, '.deckwerk-remote'), { recursive: true }); await mkdir(profile);
  const deck = parseDeck({ version: 1, title: 'VPO-Base', slides: [{ id: 's1', elements: [] }] });
  await saveDeck(deckDir, deck);
  await writeFile(join(deckDir, 'theme.css'), '');
  await writeFile(join(deckDir, '.deckwerk-remote/base.json'), JSON.stringify(deck));
  const launches: any[] = [];
  const existing: Record<string, string> = {};
  const t3Chats = new T3Chats(join(root, 'chats'), async work => work(async (method: string, payload: any): Promise<any> => {
    if (method === 'server.getConfig') return { environment: { environmentId: 'server-env' }, settings: { defaultModelSelection: { instanceId: 'provider', model: 'model' } } };
    if (method === 'orchestration.getThreadTitles') return existing;
    if (method === 'projects.ensureScratch') return { projectId: 'scratch' };
    existing[payload.threadId] = payload.title; launches.push(payload); return { threadId: payload.threadId };
  }));
  server = await startCollabServer({ rootDir: root, host: '127.0.0.1', port: 0, mediaRenditions: false, t3Chats });
  const origin = `http://127.0.0.1:${server.port}`;
  await writeFile(join(deckDir, '.deckwerk-remote/sync.json'), JSON.stringify({
    version: 1, server: origin, deckId: 'VPO-Base', title: deck.title, seq: 0, themeCss: '', savedAt: new Date().toISOString(),
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
  // Capture the OS link handoff; run the real buttons, save, IPC, HTTP route and chat service.
  await evaluate(`globalThis.t3Launches = []; require('electron').shell.openExternal = async url => { globalThis.t3Launches.push(url); };`);
  await eventually(() => cdp!.evaluate<string>(`window.api.getDeck().then(s => s?.deck.title ?? '')`), 'deck loaded', t => t === 'VPO-Base');
  await eventually(() => cdp!.evaluate<boolean>(`[...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Agent' && b.getBoundingClientRect().width > 0)`), 'Agent toolbar painted');
  await eventually(() => cdp!.evaluate<string>(`document.querySelector('#status')?.textContent?.replace(/\\s+/g, ' ') ?? ''`), 'opening finished', text => text === 'VPO-Base · slide 1/1');
  for (const [mode, width] of [['Remote', 1600], ['Local', 760], ['Remote', 1600]] as const) {
    await cdp.call('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    expect(await cdp.evaluate<boolean>(`[...document.querySelectorAll('#toolbar button')].some(b => b.textContent.trim().startsWith('t3 '))`)).toBe(false);
    await cdp.clickByText('button', 'Agent');
    expect(await cdp.evaluate<string>(`[...document.querySelectorAll('[role=menu]')].filter(m => m.getBoundingClientRect().width > 0).map(m => m.textContent).join(' ')`)).toContain('Agent panel…');
    await cdp.clickByText('[role=menuitem]', `t3 ${mode.toLowerCase()}`);
    const message = await eventually(() => cdp!.evaluate<string>(`document.body.innerText`), 'T3 launch completed', t => t.includes('Could not open T3:') || t.includes(mode === 'Remote' ? "presentation's T3 chat on the server" : 'local T3 chat draft'));
    expect(message).not.toContain('Could not open T3:');
    expect(message).toContain(mode === 'Remote' ? 'server' : 'local');
  }
  const links = await evaluate<string[]>('globalThis.t3Launches');
  expect(links).toHaveLength(3);
  const remote = new URL(links[0]!); const local = new URL(links[1]!);
  expect(remote.host).toBe('threads');
  expect(remote.pathname).toMatch(/^\/server-env\/[\w-]+$/);
  expect(remote.searchParams.get('prompt')).toContain(deckDir);
  expect(local.host).toBe('new'); expect(local.searchParams.has('repo')).toBe(false);
  expect(links[2]).toBe(links[0]);
  expect(launches).toHaveLength(1);
  expect(launches.every(p => p.projectId === 'scratch' && !p.initialMessage)).toBe(true);

}, 120_000);
