import { basename } from 'node:path';
import { readRemoteState, RemoteClient } from './remoteDecks.js';
import { t3ChatLink } from '../shared/t3Chat.js';

export async function openT3Workspace(
  dir: string,
  mode: 'local' | 'remote',
  openExternal: (url: string) => Promise<void>,
): Promise<string> {
  if (mode === 'local') {
    const url = new URL('t3code://new');
    url.searchParams.set('prompt', `Work on the DeckWerk presentation ${JSON.stringify(basename(dir))} in ${JSON.stringify(dir)} on this Mac. Read AGENTS.md in the presentation folder and its parents. Create a version checkpoint before and after edits. Use slide-agent and preserve the existing visual style.\n\nMy requested changes: `);
    await openExternal(url.href);
    return 'Opened a local T3 chat draft. Add your changes and press Send in T3.';
  }
  if (mode !== 'remote') throw new Error('Unknown T3 workspace mode.');
  const mirror = await readRemoteState(dir);
  if (!mirror) throw new Error('Open a presentation from a server to use T3 Remote.');
  const chat = await new RemoteClient(mirror.state.server).t3Chat(mirror.state.deckId);
  await openExternal(t3ChatLink(chat));
  return 'Opened the presentation\'s T3 chat on the server. Add your changes and press Send in T3.';
}
