import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { readRemoteState } from './remoteDecks.js';

export interface T3Workspace {
  server: string;
  deckId: string;
  environmentId: string;
  threadId: string;
}

export function remoteT3Link(workspaces: T3Workspace[], server: string, deckId: string): string | null {
  const target = workspaces.find((entry) => entry?.server === server && entry.deckId === deckId);
  if (!target) return null;
  const identifier = /^[a-zA-Z0-9_-]+$/;
  if (typeof target.environmentId !== 'string' || typeof target.threadId !== 'string'
    || !identifier.test(target.environmentId) || !identifier.test(target.threadId)) {
    throw new Error('The remote T3 workspace has an invalid identifier.');
  }
  return `t3code://threads/${target.environmentId}/${target.threadId}`;
}

async function openT3Application(openExternal: (url: string) => Promise<void>): Promise<void> {
  if (process.platform === 'darwin') {
    await promisify(execFile)('/usr/bin/open', ['-b', 'com.t3tools.t3code'], {
      timeout: 25_000,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, SSH_CONNECTION: undefined, SSH_TTY: undefined },
    });
  } else {
    await openExternal('t3code://');
  }
}

export async function openT3Workspace(
  dir: string,
  mode: 'local' | 'remote',
  userData: string,
  openExternal: (url: string) => Promise<void>,
  copyText: (text: string) => void,
): Promise<string> {
  const guardrails = 'Read the presentation’s AGENTS.md and its parent instructions before editing. Create a version checkpoint before and after edits. Wait for my requested changes.';
  if (mode === 'local') {
    await openT3Application(openExternal);
    copyText(`DeckWerk presentation: ${JSON.stringify(basename(dir))}\nWork on this Mac, in the local presentation folder: ${JSON.stringify(dir)}\n${guardrails}`);
    return 'Opened T3; local deck context copied. Paste into a conversation on this Mac.';
  }
  if (mode !== 'remote') throw new Error('Unknown T3 workspace mode.');
  const mirror = await readRemoteState(dir);
  if (!mirror) throw new Error('Open a presentation from a server to use T3 Remote.');
  let workspaces: T3Workspace[] = [];
  try {
    workspaces = JSON.parse(await readFile(join(userData, 't3-workspaces.json'), 'utf8'));
    if (!Array.isArray(workspaces)) workspaces = [];
  } catch {
    // A mapping is optional. New decks and forks have none.
  }
  const link = remoteT3Link(workspaces, mirror.state.server, mirror.state.deckId);
  const editor = new URL(mirror.state.server);
  if (!['http:', 'https:'].includes(editor.protocol) || editor.username || editor.password) {
    throw new Error('The presentation has an invalid server address.');
  }
  editor.pathname = '/'; editor.search = ''; editor.hash = '';
  editor.searchParams.set('deck', mirror.state.deckId);
  if (link) await openExternal(link);
  else await openT3Application(openExternal);
  copyText(`DeckWerk presentation: ${JSON.stringify(mirror.state.deckId)}\nWork on the server hosting ${editor.origin}, in this presentation’s folder under its presentations root. Use a T3 conversation running on that server.\nEditor: ${editor.href}\n${guardrails}`);
  return link
    ? 'Opened the saved T3 conversation; server deck context copied. Paste it before requesting edits.'
    : 'Opened T3; server deck context copied. Paste into a conversation on the presentation server.';
}
