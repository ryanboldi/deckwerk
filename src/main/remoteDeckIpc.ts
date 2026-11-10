import { rm } from 'node:fs/promises';
import { PresentationGitRequestSchema } from '@shared/presentationGit.js';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { app, ipcMain, shell } from 'electron';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { parseDeck, type Deck } from '@shared/deck.js';
import {
  IPC,
  type DeckSession,
  type RemoteDeckBinding,
  type RemoteDeckListing,
  type RemoteLocalCopy,
  type RemoteServerEntry,
  type RemoteServerInfo,
} from '@shared/ipc.js';
import type { DeckWindowState } from './deckWindows.js';
import {
  MirrorAssetUploader,
  RemoteClient,
  sha256File,
  syncMirrorFiles,
  syncMirrorHistoryFiles,
  RemoteRelay,
  SavedServers,
  bindingFor,
  fetchMissingAssets,
  listMirrors,
  prepareMirror,
  readRemoteState,
  writeRemoteBaseline,
} from './remoteDecks.js';

/**
 * IPC for server decks (remoteDecks.ts): the servers this desktop knows, the
 * decks on them, opening one as a mirror, and keeping an open mirror's
 * baseline and files in step while the editor's own bridge syncs the deck.
 */

interface RemoteIpcDeps {
  requireOwner: (event: { sender: WebContents }) => DeckWindowState;
  requireSession: (event: { sender: WebContents }) => DeckSession;
  reportOperation: (event: IpcMainInvokeEvent, id: unknown, message: string, ratio?: number | null) => void;
  openDeckForRequester: (state: DeckWindowState, dir: string, deck: Deck, event: IpcMainInvokeEvent) => DeckSession | null;
}

/** Where mirrors live: ~/.deckwerk/remote, or DECKWERK_REMOTE_ROOT (tests). */
export function remoteMirrorRoot(): string {
  return process.env.DECKWERK_REMOTE_ROOT || join(homedir(), '.deckwerk', 'remote');
}

let servers: SavedServers | null = null;
const savedServers = (): SavedServers =>
  servers ??= new SavedServers(join(app.getPath('userData'), 'remote-servers.json'));

const relay = new RemoteRelay(async (origin) => (await savedServers().list()).some((s) => s.url === origin));
let relayStarted: Promise<void> | null = null;
const startRelay = (): Promise<void> => (relayStarted ??= relay.start());

/** Per window: the uploader for the mirror it has open. */
const uploaders = new Map<DeckWindowState, { dir: string; uploader: MirrorAssetUploader }>();

/** A window closed or opened another deck: stop syncing the mirror's files for it. */
export function releaseRemoteMirror(state: DeckWindowState, keepDir?: string): void {
  const current = uploaders.get(state);
  if (!current || (keepDir && resolve(keepDir) === resolve(current.dir))) return;
  current.uploader.close();
  uploaders.delete(state);
}

export async function closeRemoteDecks(): Promise<void> {
  for (const { uploader } of uploaders.values()) uploader.close();
  uploaders.clear();
  await relay.close();
}

export function registerRemoteDeckIpc(deps: RemoteIpcDeps): void {
  const { requireOwner, requireSession, reportOperation, openDeckForRequester } = deps;

  const clientFor = async (serverId: string): Promise<RemoteClient> =>
    new RemoteClient((await savedServers().get(serverId)).url);

  /** The open mirror this request is about, refusing one the window no longer has. */
  const requireMirror = (event: IpcMainInvokeEvent, dir: string): { state: DeckWindowState; dir: string } => {
    const state = requireOwner(event);
    const session = requireSession(event);
    if (resolve(dir) !== resolve(session.dir)) throw new Error('That server deck is no longer open in this window');
    return { state, dir: session.dir };
  };

  const historyMirror = async (event: IpcMainInvokeEvent) => {
    const session = requireSession(event);
    const { state, dir } = requireMirror(event, session.dir);
    const remote = await readRemoteState(dir);
    const saved = remote && (await savedServers().list()).find((s) => s.url === remote.state.server);
    if (!remote || !saved) throw new Error('Open a presentation from a saved server to use branches');
    return { state, dir, deckId: remote.state.deckId, client: new RemoteClient(saved.url) };
  };
  ipcMain.handle(IPC.presentationGit, async (event, request: unknown) => {
    const command = PresentationGitRequestSchema.parse(request);
    const mirror = await historyMirror(event);
    const work = async () => {
      const before = command.command === 'apply' ? await mirror.client.files(mirror.deckId) : [];
      const result = await mirror.client.presentationGit(mirror.deckId, command);
      if (command.command === 'apply' && 'ok' in result) {
        const after = new Set((await mirror.client.files(mirror.deckId)).map((f) => f.path));
        for (const file of before) {
          if (!file.path.startsWith('assets/') || file.path.split('/').some((part) => !part || part.startsWith('.')) || file.path.includes('\\') || after.has(file.path)) continue;
          const path = join(mirror.dir, file.path);
          if (await sha256File(path).catch(() => '') === file.sha256) await rm(path, { force: true });
        }
        await syncMirrorFiles(mirror.client, mirror.dir, mirror.deckId);
      }
      return result;
    };
    return uploaders.get(mirror.state)?.uploader.exclusive(work) ?? work();
  });
  ipcMain.handle(IPC.remoteHistoryFiles, async (event, removed: unknown) => {
    if (!removed || typeof removed !== 'object' || Array.isArray(removed) || Object.values(removed).some((value) => typeof value !== 'string')) throw new Error('Invalid history files');
    const mirror = await historyMirror(event);
    const sync = () => syncMirrorHistoryFiles(mirror.client, mirror.dir, mirror.deckId, removed as Record<string, string>);
    await (uploaders.get(mirror.state)?.uploader.exclusive(sync) ?? sync());
  });
  ipcMain.handle(IPC.presentationPdf, async (event, revision: unknown) => {
    if (typeof revision !== 'string' || !/^[0-9a-f]{40}$/.test(revision)) throw new Error('Choose a checkpoint first');
    const { client, deckId } = await historyMirror(event);
    const url = new URL('/api/git/pdf', client.origin);
    url.searchParams.set('deck', deckId); url.searchParams.set('revision', revision);
    await shell.openExternal(url.href);
  });

  ipcMain.handle(IPC.remoteServers, async (): Promise<RemoteServerEntry[]> => savedServers().list());

  ipcMain.handle(IPC.remoteServerAdd, async (_event, url: string, name?: string): Promise<RemoteServerEntry & { info: RemoteServerInfo }> => {
    const probe = await savedServers().add(url, name).then(async (saved) => {
      try {
        return { saved, info: await new RemoteClient(saved.url).info() };
      } catch (error) {
        // Only keep servers that answered like a deck server.
        await savedServers().remove(saved.id);
        throw error;
      }
    });
    return { ...probe.saved, info: probe.info };
  });

  ipcMain.handle(IPC.remoteServerRemove, async (_event, id: string): Promise<void> => {
    await savedServers().remove(id);
  });

  ipcMain.handle(IPC.remoteListing, async (_event, serverId: string): Promise<RemoteDeckListing> =>
    (await clientFor(serverId)).listing());

  ipcMain.handle(IPC.remoteCreate, async (event, serverId: string, name: string, operationId?: string): Promise<string> => {
    requireOwner(event);
    const saved = await savedServers().get(serverId);
    reportOperation(event, operationId, `Creating the presentation on ${saved.name}`);
    return new RemoteClient(saved.url).createDeck(name);
  });

  ipcMain.handle(
    IPC.remoteOpen,
    async (
      event,
      serverId: string,
      deckId: string,
      operationId?: string,
      options?: { offline?: boolean },
    ): Promise<DeckSession | null> => {
      const client = await clientFor(serverId);
      if (!options?.offline) reportOperation(event, operationId, `Connecting to ${new URL(client.origin).host}`, 0);
      const { dir, deck } = await prepareMirror(client, remoteMirrorRoot(), deckId, (message, fraction) => {
        reportOperation(event, operationId, message, fraction ?? null);
      }, { offline: Boolean(options?.offline) });
      reportOperation(event, operationId, 'Opening the presentation', 0.95);
      return openDeckForRequester(requireOwner(event), dir, deck, event);
    },
  );

  ipcMain.handle(IPC.remoteLocalCopies, async (_event, serverId: string): Promise<RemoteLocalCopy[]> => {
    const copies = await listMirrors(remoteMirrorRoot(), (await savedServers().get(serverId)).url);
    return copies.map(({ deckId, title, savedAt }) => ({ deckId, title, savedAt }));
  });

  ipcMain.handle(IPC.remoteBinding, async (event, dir: string): Promise<RemoteDeckBinding | null> => {
    const { state, dir: mirror } = requireMirror(event, dir);
    const remote = await readRemoteState(mirror).catch(() => null);
    if (!remote) {
      releaseRemoteMirror(state);
      return null;
    }
    const saved = (await savedServers().list()).find((s) => s.url === remote.state.server) ?? null;
    let wsUrl: string | null = null;
    if (saved) {
      await startRelay();
      wsUrl = relay.urlFor(saved.url, remote.state.deckId);
      if (!uploaders.has(state)) {
        const uploader = new MirrorAssetUploader(new RemoteClient(saved.url), mirror, remote.state.deckId, (error) => {
          console.error(`Could not sync files of ${remote.state.deckId}:`, error);
        });
        uploader.start();
        uploaders.set(state, { dir: mirror, uploader });
      }
    }
    return bindingFor(mirror, saved, remote, wsUrl, userInfo().username || 'Desktop');
  });

  ipcMain.handle(
    IPC.remoteBaselineSave,
    async (event, dir: string, baseline: { deck: Deck; themeCss: string; seq: number }): Promise<void> => {
      const { dir: mirror } = requireMirror(event, dir);
      const remote = await readRemoteState(mirror);
      if (!remote) throw new Error('This folder is not a server deck');
      const deck = parseDeck(baseline.deck);
      await writeRemoteBaseline(mirror, {
        server: remote.state.server, deckId: remote.state.deckId, title: deck.title,
      }, { deck, themeCss: String(baseline.themeCss ?? ''), seq: Number(baseline.seq) || 0 });
    },
  );

  ipcMain.handle(IPC.remoteFilesSync, async (event, dir: string): Promise<void> => {
    const { state } = requireMirror(event, dir);
    await uploaders.get(state)?.uploader.flush();
  });

  ipcMain.handle(IPC.remoteAssetsFetch, async (event, dir: string, deck: Deck): Promise<string[]> => {
    const { dir: mirror } = requireMirror(event, dir);
    const remote = await readRemoteState(mirror);
    const saved = remote && (await savedServers().list()).find((s) => s.url === remote.state.server);
    if (!remote || !saved) return [];
    return fetchMissingAssets(new RemoteClient(saved.url), mirror, remote.state.deckId, parseDeck(deck));
  });
}
