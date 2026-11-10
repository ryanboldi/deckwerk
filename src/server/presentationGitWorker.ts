import { parentPort, workerData } from 'node:worker_threads';
import { PresentationGit, type GitStoreHost } from './presentationGit.js';
import type { PresentationGitRequest } from '../shared/presentationGit.js';
const port = parentPort!;
const git = new PresentationGit(workerData.root as string);
let sequence = 0;
const calls = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
function hostCall(job: number, method: string, args: unknown[]): Promise<unknown> {
  const id = ++sequence;
  return new Promise((resolve, reject) => { calls.set(id, { resolve, reject }); port.postMessage({ host: true, job, id, method, args }); });
}
port.on('message', (message) => {
  if (message.hostResult) {
    const callback = calls.get(message.id); calls.delete(message.id);
    if (message.error) callback?.reject(new Error(message.error)); else callback?.resolve(message.value);
    return;
  }
  void git.locked(async () => {
    const { id, deckId, actor } = message;
    const host: GitStoreHost = {
      canRead: async (deck) => Boolean(await hostCall(id, 'canRead', [deck])),
      prepareFork: async (directory) => { await hostCall(id, 'prepareFork', [directory]); },
      flush: async (deck) => { await hostCall(id, 'flush', [deck]); return () => {}; },
      check: async () => { await hostCall(id, 'check', []); },
      apply: async (deck, directory, _guard, label, rollback, files) => { await hostCall(id, 'apply', [deck, directory, label, rollback, files]); },
    };
    try {
      let value: unknown;
      if (message.method === 'idle') value = true;
      else if (message.method === 'materialize') value = await git.materialize(message.revision);
      else if (message.method === 'tracked') value = await git.tracked();
      else {
        await host.flush(deckId);
        if (message.method === 'revision') value = await git.revision(deckId, message.revision, actor, host);
        else {
          const command: PresentationGitRequest = message.command;
          switch (command.command) {
            case 'status': case 'log': value = { graph: await git.graph(deckId, actor, host) }; break;
            case 'commit': value = { ok: true, commit: await git.checkpoint(deckId, command.message, actor, host.check) }; break;
            case 'branch': value = { deckId: await git.fork(deckId, command.name, command.revision, actor, host) }; break;
            case 'tag': value = { ok: true, commit: await git.tag(deckId, command.name, command.revision, actor, host) }; break;
            case 'preview': value = { preview: await git.preview(deckId, command.action, command.revision, actor, host) }; break;
            case 'diff': value = { preview: await git.diff(deckId, command.revision, actor, host) }; break;
            case 'abort': git.abort(command.token); value = { ok: true }; break;
            case 'apply': {
              const result = await git.apply(deckId, command.token, command.choices ?? {}, command.files ?? {}, host);
              value = result.preview ? { preview: result.preview } : { ok: true, commit: result.commit }; break;
            }
          }
        }
      }
      // Large merge plans are encoded here, never on the collaboration event loop.
      const bytes = new TextEncoder().encode(JSON.stringify(value));
      port.postMessage({ id, bytes }, [bytes.buffer]);
    } catch (error) { port.postMessage({ id, error: error instanceof Error ? error.message : String(error) }); }
  });
});
