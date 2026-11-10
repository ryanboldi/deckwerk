import { expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCollabServer } from '../src/server/collabServer.js';
import { saveDeck } from '../src/main/deckStore.js';
import { parseDeck } from '../src/shared/deck.js';

it('only the server owner can create a chat, with an explicit desktop bridge request', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'deckwerk-chat-access-'));
  const dir = join(rootDir, 'Talk');
  await mkdir(dir);
  await saveDeck(dir, parseDeck({ version: 1, title: 'Talk', slides: [{ id: 's1', elements: [] }] }));
  await writeFile(join(dir, 'theme.css'), '');
  await writeFile(join(dir, 'access.json'), JSON.stringify({ owner: 'owner@example.com', visibility: 'private', sharedWith: [{ login: 'editor@example.com', role: 'edit' }] }));
  const open = vi.fn(async () => ({ environmentId: 'server', threadId: 'chat', context: 'Talk' }));
  const server = await startCollabServer({ rootDir, host: '127.0.0.1', port: 0, mediaRenditions: false, accessControl: { admin: 'owner@example.com' }, t3Chats: { open } });
  try {
    const url = `http://127.0.0.1:${server.port}/api/t3-chat?deck=Talk`;
    for (const [login, bridge, method, status] of [
      ['editor@example.com', '1', 'POST', 403],
      ['owner@example.com', '', 'POST', 405],
      ['owner@example.com', '1', 'GET', 405],
    ] as const) {
      expect((await fetch(url, { method, headers: { 'tailscale-user-login': login, 'x-deckwerk-bridge': bridge } })).status).toBe(status);
      expect(open).not.toHaveBeenCalled();
    }
    const response = await fetch(url, { method: 'POST', headers: { 'tailscale-user-login': 'owner@example.com', 'x-deckwerk-bridge': '1' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ environmentId: 'server', threadId: 'chat', context: 'Talk' });
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(dir);
  } finally { await server.close(); await rm(rootDir, { recursive: true, force: true }); }
});
