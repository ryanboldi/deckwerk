import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { electronChildEnv, electronFailure, headlessElectronArgs } from '../cli/electronDisplay.js';
import type { PresentationGitService } from './presentationGitService.js';

interface PrintServer { port: number; close(): Promise<void> }

/** Runs identically in the packaged app or a standalone headless Electron helper. */
async function printInBrowser(BrowserWindow: typeof import('electron').BrowserWindow, url: string): Promise<Buffer> {
  const window = new BrowserWindow({ show: false, width: 1280, height: 900,
    webPreferences: { offscreen: true, backgroundThrottling: false, sandbox: true, nodeIntegration: false, contextIsolation: true } });
  try {
    await window.loadURL(url);
    const deadline = Date.now() + 90_000;
    while (true) {
      const status = await window.webContents.executeJavaScript('({ready:document.documentElement.dataset.ready,error:document.documentElement.dataset.error})') as { ready?: string; error?: string };
      if (status.error) throw new Error(status.error);
      if (status.ready === 'true') break;
      if (status.ready === 'partial') throw new Error('Some slide media did not finish rendering. The PDF was not published.');
      if (Date.now() > deadline) throw new Error('PDF rendering timed out');
      await new Promise((done) => setTimeout(done, 100));
    }
    return await window.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
  } finally { window.destroy(); }
}

export class PresentationPdfs {
  private jobs = new Map<string, Promise<string>>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly git: Pick<PresentationGitService, 'stateDir' | 'materialize'>, private readonly serve: (root: string) => Promise<PrintServer>) {}

  get(revision: string): Promise<string> {
    if (!/^[0-9a-f]{40}$/.test(revision)) return Promise.reject(new Error('Invalid PDF revision'));
    const cached = join(this.git.stateDir, 'pdf', `${revision}.pdf`);
    if (existsSync(cached)) return Promise.resolve(cached);
    const existing = this.jobs.get(revision);
    if (existing) return existing;
    const next = this.queue.then(() => this.render(revision, cached));
    this.queue = next.catch(() => {});
    this.jobs.set(revision, next);
    void next.finally(() => this.jobs.delete(revision)).catch(() => {});
    return next;
  }
  private async render(revision: string, output: string): Promise<string> {
    const snapshot = await this.git.materialize(revision);
    const work = join(this.git.stateDir, `pdf-job-${randomUUID()}`);
    await mkdir(work);
    const deckId = 'presentation';
    await rename(snapshot, join(work, deckId));
    let server: PrintServer | undefined;
    try {
      server = await this.serve(work);
      const url = `http://127.0.0.1:${server.port}/print.html?deck=${deckId}&mode=final&automated=1`;
      const electron = createRequire(import.meta.url)('electron') as string | typeof import('electron');
      let pdf: Buffer;
      if (typeof electron !== 'string') pdf = await printInBrowser(electron.BrowserWindow, url);
      else {
        const script = join(work, 'print.cjs');
        const target = join(work, 'rendered.pdf');
        await writeFile(script, `const {app,BrowserWindow}=require('electron');\napp.disableHardwareAcceleration();\napp.whenReady().then(async()=>{const data=await (${printInBrowser.toString()})(BrowserWindow,${JSON.stringify(url)});require('node:fs').writeFileSync(${JSON.stringify(target)},data);app.exit(0)}).catch(e=>{console.error(e.stack||e);app.exit(1)});\n`);
        await new Promise<void>((accept, reject) => {
          const child = spawn(electron, [script, ...headlessElectronArgs()], { env: electronChildEnv(), stdio: ['ignore', 'ignore', 'pipe'] });
          let stderr = '';
          child.stderr.on('data', (chunk) => { stderr = (stderr + String(chunk)).slice(-20_000); });
          const timer = setTimeout(() => { child.kill(); reject(new Error('PDF helper timed out')); }, 120_000);
          child.on('error', (error) => { clearTimeout(timer); reject(error); });
          child.on('close', (code) => { clearTimeout(timer); code === 0 ? accept() : reject(electronFailure(stderr, 'PDF helper failed')); });
        });
        pdf = await readFile(target);
      }
      if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('Renderer did not produce a PDF');
      await mkdir(join(this.git.stateDir, 'pdf'), { recursive: true });
      const temporary = `${output}.${randomUUID()}.tmp`;
      await writeFile(temporary, pdf);
      await rename(temporary, output);
      return output;
    } finally { await server?.close(); await rm(work, { recursive: true, force: true }); }
  }
}
