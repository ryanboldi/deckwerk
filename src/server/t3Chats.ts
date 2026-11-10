import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { T3ChatSchema, type T3Chat } from '../shared/t3Chat.js';

type Rpc = <T = any>(method: string, payload: unknown) => Promise<T>;
export interface T3ChatHost { open(deckDir: string): Promise<T3Chat> }

/** Uses T3's local auth CLI and RPC API. Credentials stay on the server. */
export async function withT3Rpc<T>(home: string, work: (rpc: Rpc) => Promise<T>): Promise<T> {
  const runtime = JSON.parse(await readFile(join(home, 'userdata/server-runtime.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:[-.][\w.-]+)?$/.test(runtime.serverVersion)) throw new Error('Unsupported T3 server version');
  const cli = join(home, 'runtime/versions', runtime.serverVersion, 't3');
  const run = promisify(execFile);
  const cliOptions = { timeout: 25_000, maxBuffer: 1024 * 1024, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } };
  const auth = JSON.parse((await run(cli, ['auth', 'session', 'issue', '--base-dir', home, '--scope', 'orchestration:read', '--scope', 'orchestration:operate', '--ttl', '2m', '--label', 'DeckWerk chat', '--json'], cliOptions)).stdout);
  let ws: WebSocket | undefined;
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  try {
    const url = new URL('/ws', runtime.origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid T3 server address');
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('orchestrationProtocol', '2');
    ws = new WebSocket(url, { headers: { Authorization: `Bearer ${auth.token}` }, handshakeTimeout: 10_000, maxPayload: 16 * 1024 * 1024 });
    ws.on('message', (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message._tag === 'Ping') { ws?.send(JSON.stringify({ _tag: 'Pong' })); return; }
        const request = pending.get(message.requestId);
        if (!request || message._tag !== 'Exit') return;
        pending.delete(message.requestId); clearTimeout(request.timer);
        if (message.exit?._tag === 'Success') request.resolve(message.exit.value);
        else request.reject(new Error('T3 could not open this chat. Check the T3 server and its default model.'));
      } catch { for (const request of pending.values()) request.reject(new Error('Invalid response from T3')); }
    });
    ws.on('close', () => { for (const request of pending.values()) request.reject(new Error('T3 disconnected while opening the chat')); });
    ws.on('error', () => { for (const request of pending.values()) request.reject(new Error('Could not connect to T3')); });
    await new Promise<void>((resolve, reject) => { ws!.once('open', resolve); ws!.once('error', () => reject(new Error('Could not connect to the T3 server'))); });
    let sequence = 0;
    const rpc: Rpc = (method, payload) => new Promise((resolve, reject) => {
      const id = String(++sequence);
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('T3 took too long to open the chat')); }, 25_000);
      pending.set(id, { resolve, reject, timer });
      ws!.send(JSON.stringify({ _tag: 'Request', id, tag: method, payload, headers: [] }));
    });
    return await work(rpc);
  } finally {
    for (const request of pending.values()) clearTimeout(request.timer);
    ws?.terminate();
    // The two-minute TTL also bounds access if the server or process stops here.
    await run(cli, ['auth', 'session', 'revoke', '--base-dir', home, auth.sessionId], cliOptions).catch(() => {});
  }
}

export class T3Chats implements T3ChatHost {
  private pending = new Map<string, Promise<T3Chat>>();
  constructor(private readonly stateDir: string, private readonly connect: <T>(work: (rpc: Rpc) => Promise<T>) => Promise<T>) {}

  open(deckDir: string): Promise<T3Chat> {
    const dir = resolve(deckDir);
    const existing = this.pending.get(dir);
    if (existing) return existing;
    const task = this.connect(async (rpc) => {
      const config = await rpc('server.getConfig', {});
      const environmentId = config.environment.environmentId;
      const key = createHash('sha256').update(`${environmentId}\n${dir}`).digest('hex');
      const file = join(this.stateDir, `${key}.json`);
      let threadId: string;
      try {
        ({ threadId } = JSON.parse(await readFile(file, 'utf8')));
        if (!/^[a-zA-Z0-9_-]+$/.test(threadId)) throw new Error('Invalid saved T3 chat');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        threadId = randomUUID();
        await mkdir(this.stateDir, { recursive: true });
        const temporary = `${file}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify({ threadId }), { mode: 0o600 });
        await rename(temporary, file);
      }
      const titles = await rpc<Record<string, string>>('orchestration.getThreadTitles', { threadIds: [threadId] });
      if (!titles[threadId]) {
        const { projectId } = await rpc('projects.ensureScratch', {});
        const modelSelection = config.settings.defaultModelSelection ?? config.settings.fallbackModelSelection;
        if (!modelSelection) throw new Error('Choose a default model in T3 on the presentation server first.');
        await rpc('orchestration.launchThread', {
          commandId: `deckwerk-chat-create-${threadId}`, threadId, projectId,
          title: `Slides: ${basename(dir)}`, modelSelection,
          runtimeMode: config.settings.defaultRuntimeMode ?? 'approval-required', interactionMode: 'default',
          workspaceStrategy: { type: 'root' }, creationSource: 'web',
          // No initialMessage: opening a chat never starts an agent.
        });
      }
      return T3ChatSchema.parse({ environmentId, threadId, context:
        `Work on the DeckWerk presentation at ${JSON.stringify(dir)} on this machine. Read AGENTS.md in that folder and its parents before editing. Create a version checkpoint before and after edits. Use slide-agent and preserve the presentation's existing visual style.\n\nMy requested changes: `,
      });
    }).finally(() => this.pending.delete(dir));
    this.pending.set(dir, task);
    return task;
  }
}
