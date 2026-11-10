import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { parseDeck, type Deck } from '../src/shared/deck.js';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import type { GitPreview, PresentationGitRequest, PresentationGitResponse, PresentationGraph } from '../src/shared/presentationGit.js';
import { OfflineReplica } from './support/offlineReplica.js';
import { productionCollabClientDir } from './support/collabClient.js';
import { launchBrowser, Cdp, eventually, type RunningBrowser, findTarget, stopBrowser } from './support/browserSession.js';

let root: string, server: RunningCollabServer, origin: string;
let browser: RunningBrowser | undefined;
let cdp: Cdp | undefined;
const replicas: OfflineReplica[] = [];
const deck = (): Deck => parseDeck({ version: 1, title: 'Base', slides: [
  { id: 'one', elements: [{ id: 'a', type: 'text', x: 60, y: 60, w: 700, h: 100, html: 'First slide' }] },
  { id: 'two', elements: [{ id: 'b', type: 'text', x: 60, y: 60, w: 700, h: 100, html: 'Second slide' }] },
] });
async function request(id: string, command: PresentationGitRequest): Promise<PresentationGitResponse> {
  const response = await fetch(`${origin}/api/git?deck=${encodeURIComponent(id)}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) });
  const body = await response.json(); if (!response.ok) throw new Error(JSON.stringify(body)); return body;
}
async function graph(id = 'Base'): Promise<PresentationGraph> { const r = await request(id, { command: 'status' }); if (!('graph' in r)) throw new Error('Missing graph'); return r.graph; }
async function preview(id: string, revision: string): Promise<GitPreview> { const r = await request(id, { command: 'preview', action: 'merge', revision }); if (!('preview' in r)) throw new Error('Missing preview'); return r.preview; }
async function replica(id: string): Promise<OfflineReplica> {
  const client = new OfflineReplica(`ws://127.0.0.1:${server.port}/ws?deck=${id}`, { name: 'Test editor' }).connect(); replicas.push(client);
  await client.until(() => client.connected && Boolean(client.deck), 'connected'); return client;
}
const text = (d: Deck | null, n: number) => (d!.slides[n].elements[0] as { html: string }).html;
async function edit(client: OfflineReplica, n: number, value: string) {
  client.edit('Edit', (deck) => { (deck.slides[n].elements[0] as { html: string }).html = value; });
  await client.until(() => client.bridge.unconfirmed === 0, 'edit acknowledged');
}
beforeEach(async () => {
  globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
  root = await mkdtemp(join(tmpdir(), 'git-server-'));
  await mkdir(join(root, 'Base')); await saveDeck(join(root, 'Base'), deck()); await writeFile(join(root, 'Base', 'theme.css'), 'body { color: #000; }');
  server = await startCollabServer({ rootDir: root, clientDir: await productionCollabClientDir(), host: '127.0.0.1', port: 0, mediaRenditions: false });
  origin = `http://127.0.0.1:${server.port}`;
}, 120_000);
afterEach(async () => {
  vi.useRealTimers();
  cdp?.close(); cdp = undefined; await stopBrowser(browser?.process ?? null); browser = undefined;
  replicas.splice(0).forEach((r) => r.close()); await server?.close(); await rm(root, { recursive: true, force: true });
});

describe('presentation Git live server', () => {
  it('forks, merges into live peers, rejects stale previews, and keeps recovery points', async () => {
    const base = await replica('Base'); await graph();
    expect(await request('Base', { command: 'branch', name: 'Audience' })).toEqual({ deckId: 'Audience' });
    const audience = await replica('Audience');
    await edit(audience, 0, 'Audience introduction'); await request('Audience', { command: 'commit', message: 'Audience intro' });
    await edit(base, 1, 'New base result'); await request('Base', { command: 'commit', message: 'Updated result' });
    const p = await preview('Audience', 'Base'); expect(p.plan.conflicts).toBe(0);
    await request('Audience', { command: 'apply', token: p.token });
    await audience.until(() => text(audience.deck, 1) === 'New base result', 'live merged result');
    expect(text(audience.deck, 0)).toBe('Audience introduction');
    const g = await graph('Audience'); expect(g.commits.find((c) => c.id === g.branch.head)?.parents).toHaveLength(2); expect(g.recovery).toHaveLength(1); expect(g.dirty).toBe(false);
    const stale = await preview('Audience', 'Base'); await edit(audience, 0, 'More edits');
    await expect(request('Audience', { command: 'apply', token: stale.token })).rejects.toThrow('changed');
    expect(text(audience.deck, 0)).toBe('More edits');
  }, 30_000);

  it('automatically checkpoints tracked presentations after a minute without duplicating unchanged states', async () => {
    await graph(); await server.close();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    server = await startCollabServer({ rootDir: root, host: '127.0.0.1', port: 0, mediaRenditions: false }); origin = `http://127.0.0.1:${server.port}`;
    const base = await replica('Base'); await edit(base, 0, 'Automatic saved edit');
    vi.advanceTimersByTime(60_000);
    await eventually(() => graph(), 'automatic checkpoint', (g) => g.commits[0].message === 'Automatic checkpoint');
    const first = await graph(); expect(first.dirty).toBe(false);
    vi.advanceTimersByTime(60_000);
    const second = await graph(); expect(second.branch.head).toBe(first.branch.head);
  }, 15_000);

  it('applies file-only history without an invalid empty transaction or a lost next edit', async () => {
    const base = await replica('Base'); const before = await graph();
    await mkdir(join(root, 'Base', 'assets')); await writeFile(join(root, 'Base', 'assets', 'spare.txt'), 'new file');
    await request('Base', { command: 'commit', message: 'Add supporting file' });
    const response = await request('Base', { command: 'preview', action: 'reset', revision: before.branch.head });
    if (!('preview' in response)) throw new Error('Missing preview');
    await request('Base', { command: 'apply', token: response.preview.token });
    await edit(base, 0, 'Edit after file-only reset');
    expect((await graph()).dirty).toBe(true);
    expect((await readFile(join(root, 'Base', 'deck.json'), 'utf8'))).toContain('Edit after file-only reset');
  });

  it('keeps history and PDF access private to the owner, including forks', async () => {
    await server.close();
    await writeFile(join(root, 'Base', 'access.json'), JSON.stringify({ owner: 'owner@example.test', visibility: 'private', sharedWith: [{ login: 'reader@example.test', role: 'view' }] }));
    server = await startCollabServer({ rootDir: root, host: '127.0.0.1', port: 0, accessControl: { admin: 'owner@example.test' } }); origin = `http://127.0.0.1:${server.port}`;
    const g = await graph();
    for (const path of [`/api/git?deck=Base`, `/api/git/pdf?deck=Base&revision=${g.branch.head}`]) {
      const response = await fetch(origin + path, { headers: { 'tailscale-user-login': 'reader@example.test' } }); expect(response.status).toBe(403);
    }
    await request('Base', { command: 'branch', name: 'PrivateFork' });
    const access = JSON.parse(await readFile(join(root, 'PrivateFork', 'access.json'), 'utf8'));
    expect(access.owner).toBe('owner@example.test'); expect(access.visibility).toBe('private'); expect(access.sharedWith).toEqual([]);
  });

  it('renders an immutable two-page PDF and serves the same bytes after live edits', async () => {
    const g = await graph();
    const url = `${origin}/api/git/pdf?deck=Base&revision=${g.branch.head}`;
    const first = await fetch(url); expect(first.status, await first.clone().text()).toBe(200);
    const bytes = Buffer.from(await first.arrayBuffer()); expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(bytes.toString('latin1').match(/\/Type\s*\/Page\b/g)?.length).toBe(2);
    const base = await replica('Base'); await edit(base, 0, 'Changed later'); await request('Base', { command: 'commit', message: 'Later' });
    expect(Buffer.from(await (await fetch(url)).arrayBuffer()).equals(bytes)).toBe(true);
    expect(first.headers.get('x-deckwerk-revision')).toBe(g.branch.head);
  }, 120_000);

  it('opens the graph and forks through real browser input', async () => {
    browser = await launchBrowser(`${origin}/history.html?deck=Base`, join(root, '.browser'));
    const target = await findTarget(browser.debugPort, (target) => target.url.includes('/history.html'), browser.log); cdp = await Cdp.connect(target.webSocketDebuggerUrl!);
    await eventually(() => cdp!.evaluate<boolean>(`document.querySelectorAll('.history-commits button').length > 0`), 'history graph', Boolean);
    await cdp.call('Page.captureScreenshot', { format: 'png' }).then(async ({ data }: { data: string }) => writeFile('/tmp/deckwerk-history-ui.png', Buffer.from(data, 'base64')));
    await cdp.typeInto('input[placeholder="VPO-Jane-Street"]', 'Jane Street');
    await cdp.clickByText('button', 'Fork here');
    await eventually(() => cdp!.evaluate<string>('location.search'), 'fork opened', (search) => search.includes('Jane%20Street'));
    const g = await graph('Jane Street'); expect(g.branches).toHaveLength(2);
  }, 60_000);
});
