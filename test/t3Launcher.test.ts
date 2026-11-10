import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openT3Workspace } from '../src/main/t3Launcher.js';
import { RemoteClient } from '../src/main/remoteDecks.js';
import { t3ChatLink } from '../src/shared/t3Chat.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 't3-launch-')); roots.push(root);
  const dir = join(root, 'VPO-Base');
  await mkdir(join(dir, '.deckwerk-remote'), { recursive: true });
  await writeFile(join(dir, '.deckwerk-remote/base.json'), JSON.stringify({ version: 1, title: 'Base', slides: [] }));
  await writeFile(join(dir, '.deckwerk-remote/sync.json'), JSON.stringify({ version: 1, server: 'https://lab.ts.net:9450', deckId: 'VPO-Base' }));
  return { root, dir, open: vi.fn(async (_url: string) => {}) };
}
it('Remote opens a chat on the server with an unsent presentation prompt', async () => {
  const { dir, open } = await fixture();
  const chat = { environmentId: 'remote-environment', threadId: 'chat-1', context: 'Work on /presentations/VPO-Base' };
  const remote = vi.spyOn(RemoteClient.prototype, 't3Chat').mockResolvedValue(chat);
  await openT3Workspace(dir, 'remote', open);
  expect(remote).toHaveBeenCalledWith('VPO-Base');
  const url = new URL(open.mock.calls[0]![0]);
  expect(url.host).toBe('threads');
  expect(url.pathname).toBe('/remote-environment/chat-1');
  expect(url.searchParams.get('prompt')).toBe(chat.context);
  expect(url.searchParams.has('repo')).toBe(false);
});
it('Local opens a No project chat draft with the local deck folder', async () => {
  const { dir, open } = await fixture();
  await openT3Workspace(dir, 'local', open);
  const url = new URL(open.mock.calls[0]![0]);
  expect(url.host).toBe('new');
  expect(url.searchParams.get('prompt')).toContain(dir);
  expect(url.searchParams.has('repo')).toBe(false);
});
it('reports server failure instead of merely bringing T3 forward', async () => {
  const { dir, open } = await fixture();
  vi.spyOn(RemoteClient.prototype, 't3Chat').mockRejectedValue(new Error('RyBox is offline'));
  await expect(openT3Workspace(dir, 'remote', open)).rejects.toThrow('RyBox is offline');
  expect(open).not.toHaveBeenCalled();
});
it('rejects Remote for a presentation that has no server', async () => {
  const { root, open } = await fixture();
  await expect(openT3Workspace(root, 'remote', open)).rejects.toThrow('Open a presentation from a server');
});
it('encodes the prompt as data and rejects untrusted link targets', () => {
  const context = 'Jane & Co? #plan\n$(do not execute)';
  expect(new URL(t3ChatLink({ environmentId: 'remote', threadId: 'chat', context })).searchParams.get('prompt')).toBe(context);
  expect(() => t3ChatLink({ environmentId: '../new?run=1', threadId: 'chat', context })).toThrow();
});
