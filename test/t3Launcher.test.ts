import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openT3Workspace, remoteT3Link } from '../src/main/t3Launcher.js';

vi.mock('node:child_process', async (original) => ({
  ...await original<typeof import('node:child_process')>(),
  execFile: vi.fn((_file, _args, _options, callback) => { callback(null, '', ''); }),
}));
const roots: string[] = [];
afterEach(async () => { vi.clearAllMocks(); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 't3-launch-')); roots.push(root);
  const dir = join(root, 'VPO-Base');
  await mkdir(join(dir, '.deckwerk-remote'), { recursive: true });
  await writeFile(join(dir, '.deckwerk-remote/base.json'), JSON.stringify({ version: 1, title: 'Base', slides: [] }));
  await writeFile(join(dir, '.deckwerk-remote/sync.json'), JSON.stringify({ version: 1, server: workspace.server, deckId: 'VPO-Base' }));
  return { root, dir, open: vi.fn(async (_url: string) => {}), copy: vi.fn((_text: string) => {}) };
}

const workspace = { server: 'https://lab.ts.net:9450', deckId: 'Talk with spaces', environmentId: 'environment-1', threadId: 'thread-2' };
describe('T3 deck workspace links', () => {
  it('opens the configured remote thread for the exact server and deck', () => {
    expect(remoteT3Link([workspace], workspace.server, workspace.deckId)).toBe('t3code://threads/environment-1/thread-2');
  });
  it('lets new decks and forks open T3 without selecting another deck’s agent', () => {
    expect(remoteT3Link([workspace], workspace.server, 'VPO-Base')).toBeNull();
    expect(remoteT3Link([workspace], 'https://other.ts.net', workspace.deckId)).toBeNull();
  });
  it('rejects identifiers that can change the link target or inject a query', () => {
    for (const environmentId of ['../../new', 'one?prompt=edit', '']) {
      expect(() => remoteT3Link([{ ...workspace, environmentId }], workspace.server, workspace.deckId)).toThrow('invalid identifier');
    }
  });
  it.each([undefined, '[]', '{broken', '{}', JSON.stringify([workspace])])('opens an unmapped deck with optional config %s', async config => {
    const { root, dir, open, copy } = await fixture();
    if (config !== undefined) await writeFile(join(root, 't3-workspaces.json'), config);
    expect(await openT3Workspace(dir, 'remote', root, open, copy)).toContain('server deck context copied');
    expect(copy).toHaveBeenCalledOnce();
    expect(copy.mock.calls[0]![0]).toContain('https://lab.ts.net:9450/?deck=VPO-Base');
    if (process.platform === 'darwin') expect(execFile).toHaveBeenCalledWith('/usr/bin/open', ['-b', 'com.t3tools.t3code'], expect.any(Object), expect.any(Function));
    else expect(open).toHaveBeenCalledWith('t3code://');
  });
  it('reuses an exact existing conversation without opening another project', async () => {
    const { root, dir, open, copy } = await fixture();
    await writeFile(join(root, 't3-workspaces.json'), JSON.stringify([{ ...workspace, deckId: 'VPO-Base' }]));
    await openT3Workspace(dir, 'remote', root, open, copy);
    expect(open).toHaveBeenCalledWith('t3code://threads/environment-1/thread-2');
    expect(execFile).not.toHaveBeenCalled();
    expect(copy).toHaveBeenCalledOnce();
  });
  it('keeps the clipboard untouched if opening a mapped conversation fails', async () => {
    const { root, dir, open, copy } = await fixture();
    await writeFile(join(root, 't3-workspaces.json'), JSON.stringify([{ ...workspace, deckId: 'VPO-Base' }]));
    open.mockRejectedValueOnce(new Error('T3 is not installed'));
    await expect(openT3Workspace(dir, 'remote', root, open, copy)).rejects.toThrow('not installed');
    expect(copy).not.toHaveBeenCalled();
  });
  it('requires a server deck for Remote and copies a local folder for Local', async () => {
    const { root, dir, open, copy } = await fixture();
    await expect(openT3Workspace(root, 'remote', root, open, copy)).rejects.toThrow('Open a presentation from a server');
    expect(copy).not.toHaveBeenCalled();
    await openT3Workspace(dir, 'local', root, open, copy);
    expect(copy.mock.calls[0]![0]).toContain(JSON.stringify(dir));
    expect(copy.mock.calls[0]![0]).toContain('Work on this Mac');
    expect(vi.mocked(execFile).mock.calls.every(call => !call[1]?.includes('app'))).toBe(true);
  });
});
