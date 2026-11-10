import { prepareMirror, RemoteClient, SavedServers } from '../src/main/remoteDecks.js';
import { LocalAgentRegistry } from '../src/server/localAgents.js';
import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseDeck } from '../src/shared/deck.js';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { materializeDesktopApp, launchDesktopApp, isEditorTarget, type RunningApp } from './support/desktopApp.js';
import { Cdp, eventually, findTarget, stopBrowser } from './support/browserSession.js';
let root: string, app: RunningApp | undefined, server: RunningCollabServer | undefined, cdp: Cdp | undefined;
afterEach(async () => { cdp?.close(); await stopBrowser(app?.process ?? null); await server?.close(); if (root) await rm(root, { recursive: true, force: true }); });
async function openBranches(): Promise<void> {
  const expanded = await cdp!.evaluate<boolean>(`[...document.querySelectorAll('button')].some(b => b.textContent === 'Branches' && b.getBoundingClientRect().width > 0)`);
  if (expanded) await cdp!.clickByText('button', 'Branches');
  else { await cdp!.clickByText('button', 'File'); await cdp!.clickByText('[role=menuitem]', 'Branches…'); }
}
it('the compiled native app opens a server branch graph and forks into another offline mirror', async () => {
  root = await mkdtemp(join(tmpdir(), 'deckwerk-git-desktop-'));
  const decks = join(root, 'presentations'), profile = join(root, 'profile'), appDir = join(root, 'app');
  await mkdir(join(decks, 'Base'), { recursive: true }); await mkdir(profile);
  await saveDeck(join(decks, 'Base'), parseDeck({ version: 1, title: 'Base', slides: [{ id: 's1', elements: [] }] }));
  await writeFile(join(decks, 'Base', 'theme.css'), '');
  server = await startCollabServer({ rootDir: decks, host: '127.0.0.1', port: 0, mediaRenditions: false, localAgents: new LocalAgentRegistry({ name: 'Test agent' }) });
  await materializeDesktopApp(appDir, 'deckwerk-presentation-history-test');
  const serverUrl = `http://127.0.0.1:${server.port}`;
  await new SavedServers(join(profile, 'remote-servers.json')).add(serverUrl, 'Test server');
  const mirror = await prepareMirror(new RemoteClient(serverUrl), join(root, 'mirrors'), 'Base');
  app = await launchDesktopApp(appDir, [mirror.dir], { profileDir: profile, env: { DECKWERK_REMOTE_ROOT: join(root, 'mirrors') } });
  const target = await findTarget(app.debugPort, isEditorTarget, app.log); cdp = await Cdp.connect(target.webSocketDebuggerUrl!);
  await eventually(() => cdp!.evaluate<boolean>('Boolean(window.api?.addRemoteServer)'), 'preload ready');
  await eventually(() => cdp!.evaluate<string>(`window.api.getDeck().then(s => s?.deck.title ?? '')`), 'native presentation opened', (title) => title === 'Base');
  await eventually(() => cdp!.evaluate<string>(`document.querySelector('.remote-status')?.textContent ?? ''`), 'native server connected', (text) => !text.toLowerCase().includes('offline') && text.includes('Test server'));
  await openBranches();
  await eventually(() => cdp!.evaluate<number>(`document.querySelectorAll('.history-commits button').length`), 'native graph');
  await cdp.typeInto('input[placeholder="VPO-Jane-Street"]', 'Audience');
  await cdp.clickByText('button', 'Fork here');
  const forkWindow = await findTarget(app.debugPort, (candidate) => isEditorTarget(candidate) && candidate.id !== target.id, app.log);
  cdp.close(); cdp = await Cdp.connect(forkWindow.webSocketDebuggerUrl!);
  await eventually(() => cdp!.evaluate<string>(`window.api.getDeck().then(s => s?.deck.title ?? '')`), 'forked native presentation', (title) => title === 'Audience');
  const session = await cdp.evaluate<{ dir: string }>(`window.api.getDeck()`); expect(session.dir).toContain('mirrors'); expect(session.dir).toContain('Audience');
  await openBranches();
  await eventually(() => cdp!.evaluate<number>(`document.querySelectorAll('.history-branch').length`), 'both native branches', (n) => n === 2);
}, 120_000);
