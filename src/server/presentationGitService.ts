import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { GitStoreHost } from './presentationGit.js';
import type { PresentationGitRequest } from '../shared/presentationGit.js';

type Job = { resolve(data: Buffer): void; reject(error: Error): void; host?: GitStoreHost; guard?: () => void };
/** One persistent worker owns Git and expensive deck parsing/merge/JSON work. */
export class PresentationGitService {
  readonly stateDir: string;
  private worker: Promise<Worker> | null = null;
  private temporary: string | null = null;
  private jobs = new Map<number, Job>();
  private sequence = 0;
  private closing = false;
  constructor(private readonly root: string) { this.stateDir = join(root, '.deckwerk-git'); }
  private start(): Promise<Worker> {
    return this.worker ??= (async () => {
      const folder = dirname(fileURLToPath(import.meta.url));
      let entry = join(folder, 'presentationGitWorker.js');
      if (!existsSync(entry)) {
        // Source runs (vite-node/tests) build the same worker shipped by electron-vite.
        this.temporary = await mkdtemp(join(tmpdir(), 'deckwerk-git-worker-'));
        entry = join(this.temporary, 'worker.cjs');
        const { build } = createRequire(import.meta.url)('esbuild') as typeof import('esbuild');
        await build({ entryPoints: [join(folder, 'presentationGitWorker.ts')], outfile: entry, bundle: true, platform: 'node', format: 'cjs', target: 'node20' });
      }
      const worker = new Worker(entry, { workerData: { root: this.root } });
      const fail = (error: Error) => { for (const job of this.jobs.values()) job.reject(error); this.jobs.clear(); };
      worker.on('error', fail);
      worker.on('exit', (code) => { if (code) fail(new Error(`Presentation history worker exited (${code})`)); this.worker = null; });
      worker.on('message', (message) => {
        if (message.host) { void this.hostCall(worker, message); return; }
        const job = this.jobs.get(message.id); this.jobs.delete(message.id);
        if (message.error) job?.reject(new Error(message.error)); else job?.resolve(Buffer.from(message.bytes));
      });
      return worker;
    })();
  }
  private async hostCall(worker: Worker, message: { id: number; job: number; method: string; args: [string, string, string, string, Parameters<GitStoreHost['apply']>[5]] }): Promise<void> {
    const job = this.jobs.get(message.job);
    try {
      if (!job?.host) throw new Error('History request no longer has a live session');
      const [id, directory, label, rollback, files] = message.args;
      let value: unknown;
      switch (message.method) {
        case 'canRead': value = await job.host.canRead(id); break;
        case 'prepareFork': await job.host.prepareFork?.(id); break;
        case 'flush': job.guard = await job.host.flush(id); break;
        case 'check': job.guard?.(); break;
        case 'apply': await job.host.apply(id, directory, job.guard ?? (() => {}), label, rollback, files); break;
        default: throw new Error('Unknown history callback');
      }
      worker.postMessage({ hostResult: true, id: message.id, value });
    } catch (error) { worker.postMessage({ hostResult: true, id: message.id, error: error instanceof Error ? error.message : String(error) }); }
  }
  private async send(message: object, host?: GitStoreHost, shutdown = false): Promise<Buffer> {
    if (this.closing && !shutdown) throw new Error('Presentation history is shutting down');
    const worker = await this.start();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => { this.jobs.set(id, { resolve, reject, host }); worker.postMessage({ ...message, id }); });
  }
  run(deckId: string, command: PresentationGitRequest, actor: { name: string; email: string }, host: GitStoreHost): Promise<Buffer> {
    return this.send({ method: 'run', deckId, command, actor }, host);
  }
  async revision(deckId: string, revision: string, actor: { name: string; email: string }, host: GitStoreHost): Promise<string> {
    return JSON.parse((await this.send({ method: 'revision', deckId, revision, actor }, host)).toString()) as string;
  }
  async materialize(revision: string): Promise<string> {
    return JSON.parse((await this.send({ method: 'materialize', revision })).toString()) as string;
  }
  async tracked(): Promise<string[]> {
    if (!existsSync(join(this.stateDir, 'branches.json'))) return [];
    return JSON.parse((await this.send({ method: 'tracked' })).toString()) as string[];
  }
  async close(): Promise<void> {
    this.closing = true;
    if (this.worker) {
      await this.send({ method: 'idle' }, undefined, true).catch(() => {});
      if (this.worker) await (await this.worker).terminate();
    }
    if (this.temporary) await rm(this.temporary, { recursive: true, force: true });
  }
}
