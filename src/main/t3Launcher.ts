import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { readRemoteState } from './remoteDecks.js';

export interface T3Workspace {
  server: string;
  deckId: string;
  environmentId: string;
  threadId: string;
}

export function remoteT3Link(workspaces: T3Workspace[], server: string, deckId: string): string {
  const target = workspaces.find((entry) => entry?.server === server && entry.deckId === deckId);
  if (!target) throw new Error('No remote T3 workspace is configured for this presentation.');
  const identifier = /^[a-zA-Z0-9_-]+$/;
  if (typeof target.environmentId !== 'string' || typeof target.threadId !== 'string'
    || !identifier.test(target.environmentId) || !identifier.test(target.threadId)) {
    throw new Error('The remote T3 workspace has an invalid identifier.');
  }
  return `t3code://threads/${target.environmentId}/${target.threadId}`;
}

export async function openT3Workspace(
  dir: string,
  mode: 'local' | 'remote',
  userData: string,
  openExternal: (url: string) => Promise<void>,
): Promise<void> {
  if (mode === 'local') {
    await promisify(execFile)(join(homedir(), '.local/bin/t3'), ['app', dir], {
      timeout: 25_000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, SSH_CONNECTION: undefined, SSH_TTY: undefined },
    });
    return;
  }
  if (mode !== 'remote') throw new Error('Unknown T3 workspace mode.');
  const mirror = await readRemoteState(dir);
  if (!mirror) throw new Error('Open a presentation from a server to use T3 Remote.');
  let workspaces: T3Workspace[];
  try {
    workspaces = JSON.parse(await readFile(join(userData, 't3-workspaces.json'), 'utf8'));
    if (!Array.isArray(workspaces)) throw new Error('Expected an array');
  } catch {
    throw new Error('Remote T3 workspaces have not been configured on this computer.');
  }
  await openExternal(remoteT3Link(workspaces, mirror.state.server, mirror.state.deckId));
}
