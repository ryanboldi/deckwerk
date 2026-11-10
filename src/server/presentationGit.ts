import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, createWriteStream } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { parseDeck, type Deck } from '../shared/deck.js';
import { planMerge, resolveMerge, unresolved, type MergeChoices, type MergePlan } from '../shared/deckMerge.js';
import { diffDecks } from '../shared/deckDiff.js';
import { validateDeckIntegrity, type AgentOperation } from '../shared/agent.js';
import { HISTORY_FILES } from '../shared/editHistory.js';
import type { GitAction, GitFileConflict, GitPreview, PresentationBranch, PresentationCommit, PresentationGraph, PresentationRef } from '../shared/presentationGit.js';

type Files = Map<string, string>;
interface BranchRecord { id: string; family: string; deckId: string; name: string }
interface Snapshot { deck: Deck; theme: string; files: Files }
interface Actor { name: string; email: string }
interface Pending {
  public: GitPreview; branch: BranchRecord; head: string; working: string; source: string;
  sourceBranch?: string; sourceHead?: string; actor: Actor; expires: number;
  base: Snapshot; ours: Snapshot; theirs: Snapshot; replay?: string[]; stash?: string;
}
export interface GitStoreHost {
  /** Save live edits first. The returned guard must reject a changed live deck. */
  flush(deckId: string): Promise<() => void>;
  /** Apply a prepared tree to the live session, preserving its collaboration protocol. */
  apply(deckId: string, directory: string, guard: () => void, label: string, rollback: string, files?: { changed: Record<string, string>; removed: Record<string, string>; deck: Deck; theme: string; ops: AgentOperation[] }): Promise<void>;
  canRead(deckId: string): Promise<boolean>;
  check?(): Promise<void>;
  prepareFork?(directory: string): Promise<void>;
}

const HASH = /^[0-9a-f]{40}$/;
const OMIT = new Set([...HISTORY_FILES, 'edit', 'chat.jsonl', 'deck-history-v2.json.gz', 'access.json', 'agent-chats.json']);
const pathOK = (path: string) => Boolean(path) && !path.includes('\\') && !/[\x00-\x1f]/.test(path)
  && path.split('/').every((part) => part && part !== '.' && part !== '..' && !part.startsWith('.'));
const equalFiles = (a: Files, b: Files) => a.size === b.size && [...a].every(([path, sha]) => b.get(path) === sha);
const changedFiles = (a: Files, b: Files) => [...new Set([...a.keys(), ...b.keys()])].filter((path) => a.get(path) !== b.get(path)).sort();
const ref = (branch: BranchRecord) => `refs/heads/${branch.id}`;

/** Private Git object storage. Live decks stay ordinary folders, one per branch. */
export class PresentationGit {
  readonly stateDir: string;
  readonly repo: string;
  private ready: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private pending = new Map<string, Pending>();

  constructor(readonly root: string) {
    this.stateDir = join(root, '.deckwerk-git');
    this.repo = join(this.stateDir, 'repo.git');
  }

  async locked<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  private init(): Promise<void> {
    return this.ready ??= (async () => {
      await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
      if (!existsSync(join(this.repo, 'HEAD'))) await this.git(['init', '--bare', this.repo], undefined, {}, false);
      await this.git(['config', 'core.logAllRefUpdates', 'always']);
      await this.git(['config', 'gc.auto', '0']);
    })();
  }

  private async git(args: string[], input?: string | Buffer, extra: NodeJS.ProcessEnv = {}, inRepo = true): Promise<Buffer> {
    return new Promise((accept, reject) => {
      const child = spawn('git', ['-c', 'core.hooksPath=/dev/null', ...(inRepo ? [`--git-dir=${this.repo}`] : []), ...args], {
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', ...extra },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const output: Buffer[] = []; const errors: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => output.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => errors.push(chunk));
      child.on('error', reject);
      child.stdin.on('error', () => {});
      child.on('close', (code) => code === 0 ? accept(Buffer.concat(output))
        : reject(new Error(Buffer.concat(errors).toString().trim() || `Git ${args[0]} failed (${code})`)));
      child.stdin.end(input);
    });
  }
  private async text(args: string[], input?: string, extra?: NodeJS.ProcessEnv): Promise<string> {
    return (await this.git(args, input, extra)).toString().trim();
  }
  private async atomic(path: string, value: unknown): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, path);
  }
  private async records(): Promise<BranchRecord[]> {
    try { return JSON.parse(await readFile(join(this.stateDir, 'branches.json'), 'utf8')) as BranchRecord[]; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  private directory(deckId: string): string {
    if (!pathOK(deckId)) throw new Error('Invalid presentation path');
    return join(this.root, ...deckId.split('/'));
  }
  private async record(branch: BranchRecord): Promise<void> {
    const records = await this.records();
    await this.atomic(join(this.stateDir, 'branches.json'), [...records.filter((b) => b.id !== branch.id), branch]);
  }
  private async head(branch: BranchRecord): Promise<string> { return this.text(['rev-parse', '--verify', ref(branch)]); }
  private async actorEnv(actor: Actor): Promise<NodeJS.ProcessEnv> {
    const name = actor.name.replace(/[\r\n<>]/g, '').trim() || 'DeckWerk user';
    const email = actor.email.replace(/[\r\n<>]/g, '').trim() || 'deckwerk@localhost';
    return { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
  }
  private async commitTree(tree: string, parents: string[], message: string, actor: Actor): Promise<string> {
    if (!message.trim()) throw new Error('Enter a checkpoint message');
    return this.text(['commit-tree', tree, ...parents.flatMap((parent) => ['-p', parent])], message.trim() + '\n', await this.actorEnv(actor));
  }
  private async filesAt(revision: string): Promise<Files> {
    const files: Files = new Map();
    const raw = await this.git(['ls-tree', '-rz', '--full-tree', revision]);
    for (const entry of raw.toString().split('\0').filter(Boolean)) {
      const match = /^100644 blob ([0-9a-f]{40})\t([\s\S]+)$/.exec(entry);
      if (!match || !pathOK(match[2])) throw new Error('Unsupported or unsafe file in presentation history');
      files.set(match[2], match[1]);
    }
    return files;
  }
  private async blob(data: string): Promise<string> { return this.text(['hash-object', '-w', '--stdin'], data); }
  private async tree(files: Files): Promise<string> {
    const index = join(this.stateDir, `index-${randomUUID()}`);
    const env = { GIT_INDEX_FILE: index };
    try {
      await this.git(['read-tree', '--empty'], undefined, env);
      const entries = [...files].sort(([a], [b]) => a.localeCompare(b));
      for (const [path, hash] of entries) if (!pathOK(path) || !HASH.test(hash)) throw new Error('Unsafe snapshot entry');
      await this.git(['update-index', '-z', '--index-info'], entries.map(([path, hash]) => `100644 ${hash}\t${path}\0`).join(''), env);
      return await this.text(['write-tree'], undefined, env);
    } finally { await rm(index, { force: true }); }
  }
  private async workingFiles(deckId: string): Promise<Files> {
    const dir = this.directory(deckId);
    const files: Files = new Map();
    const walk = async (folder: string): Promise<void> => {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || (folder === dir && OMIT.has(entry.name))) continue;
        const full = join(folder, entry.name);
        const path = relative(dir, full).split(sep).join('/');
        if (!pathOK(path)) throw new Error(`Unsupported filename: ${path}`);
        if (entry.isSymbolicLink()) throw new Error(`Snapshot cannot include a symlink: ${path}`);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) files.set(path, await this.text(['hash-object', '-w', '--no-filters', full]));
      }
    };
    await walk(dir);
    if (!files.has('deck.json')) throw new Error('This folder is not a presentation');
    return files;
  }
  private async snapshot(files: Files): Promise<Snapshot> {
    if (!files.has('deck.json')) throw new Error(`Snapshot has no deck.json (${[...files.keys()].join(', ')})`);
    const deck = parseDeck(JSON.parse((await this.git(['cat-file', 'blob', files.get('deck.json')!])).toString()));
    const themeHash = files.get(deck.theme);
    const theme = themeHash ? (await this.git(['cat-file', 'blob', themeHash])).toString() : '';
    return { deck, theme, files };
  }
  async tracked(): Promise<string[]> { return (await this.records()).map((branch) => branch.deckId).filter((id) => existsSync(join(this.directory(id), 'deck.json'))); }

  async ensure(deckId: string, actor: Actor): Promise<BranchRecord> {
    await this.init();
    const directory = this.directory(deckId);
    const sidecar = join(directory, '.deckwerk-branch.json');
    if (existsSync(sidecar)) {
      const { id } = JSON.parse(await readFile(sidecar, 'utf8')) as { id: string };
      const record = (await this.records()).find((b) => b.id === id);
      if (!record) throw new Error('Presentation branch metadata is missing; restore its Git backup');
      if (record.deckId !== deckId) { record.deckId = deckId; await this.record(record); }
      return record;
    }
    const id = randomUUID();
    const branch = { id, family: id, deckId, name: deckId.split('/').at(-1)! };
    const tree = await this.tree(await this.workingFiles(deckId));
    const commit = await this.commitTree(tree, [], 'Initial presentation checkpoint', actor);
    await this.git(['update-ref', ref(branch), commit]);
    await this.record(branch);
    await this.atomic(sidecar, { id });
    return branch;
  }
  private async visible(branch: BranchRecord, host: GitStoreHost): Promise<BranchRecord[]> {
    const result: BranchRecord[] = [];
    for (const candidate of await this.records()) {
      if (candidate.family === branch.family && existsSync(join(this.directory(candidate.deckId), 'deck.json')) && await host.canRead(candidate.deckId)) result.push(candidate);
    }
    return result;
  }
  private async refs(prefix: string): Promise<PresentationRef[]> {
    const lines = await this.text(['for-each-ref', '--format=%(refname) %(objectname)', prefix]);
    return lines.split('\n').filter(Boolean).map((line) => {
      const [name, commit] = line.split(' '); return { name: name.slice(prefix.length), commit };
    });
  }
  private async resolveRevision(branch: BranchRecord, requested: string, host: GitStoreHost): Promise<string> {
    const visible = await this.visible(branch, host);
    const named = visible.find((b) => b.id === requested || b.deckId === requested || b.name === requested);
    if (named) return this.head(named);
    const ownHead = await this.head(branch);
    const match = /^HEAD(?:~([0-9]{1,4}))?$/.exec(requested);
    let hash: string;
    if (match) hash = await this.text(['rev-parse', '--verify', `${ownHead}${match[1] ? `~${match[1]}` : ''}^{commit}`]);
    else if (/^[0-9a-f]{7,40}$/.test(requested)) hash = await this.text(['rev-parse', '--verify', `${requested}^{commit}`]);
    else {
      const known = [...await this.refs(`refs/tags/${branch.family}/`), ...await this.refs(`refs/recovery/${branch.id}/`), ...await this.refs(`refs/stash/${branch.id}/`)];
      const found = known.find((r) => r.name === requested);
      if (!found) throw new Error('Unknown branch, checkpoint, tag, or recovery point');
      hash = found.commit;
    }
    // Guessed object hashes must not reveal another presentation's history.
    const allowed = [...await Promise.all(visible.map((b) => this.head(b))),
      ...(await this.refs(`refs/recovery/${branch.id}/`)).map((r) => r.commit),
      ...(await this.refs(`refs/stash/${branch.id}/`)).map((r) => r.commit)];
    for (const tip of allowed) {
      try { await this.git(['merge-base', '--is-ancestor', hash, tip]); return hash; } catch { /* next visible tip */ }
    }
    throw new Error('That checkpoint is not in the history of an accessible branch');
  }
  async graph(deckId: string, actor: Actor, host: GitStoreHost): Promise<PresentationGraph> {
    const branch = await this.ensure(deckId, actor);
    const branches: PresentationBranch[] = await Promise.all((await this.visible(branch, host)).map(async (b) => ({ ...b, head: await this.head(b) })));
    const head = await this.head(branch);
    const recovery = await this.refs(`refs/recovery/${branch.id}/`);
    const stashes = await this.refs(`refs/stash/${branch.id}/`);
    const tips = [...new Set([...branches.map((b) => b.head), ...recovery.map((r) => r.commit), ...stashes.map((r) => r.commit)])];
    const log = await this.text(['log', '--topo-order', '-150', '--format=%H%x00%P%x00%s%x00%an%x00%aI', ...tips, '--']);
    const commits: PresentationCommit[] = log.split('\n').filter(Boolean).map((line) => {
      const [id, parents, message, author, date] = line.split('\0');
      return { id, parents: parents ? parents.split(' ') : [], message, author, date };
    });
    const files = await this.workingFiles(deckId);
    const changed = changedFiles(await this.filesAt(head), files);
    const tags: PresentationRef[] = [];
    for (const tag of await this.refs(`refs/tags/${branch.family}/`)) {
      try { await this.resolveRevision(branch, tag.commit, host); tags.push(tag); } catch { /* inaccessible */ }
    }
    return { branch: { ...branch, head }, branches, commits, tags, recovery, stashes, dirty: changed.length > 0, changedFiles: changed };
  }
  async checkpoint(deckId: string, message: string, actor: Actor, guard?: () => Promise<void>): Promise<string> {
    const branch = await this.ensure(deckId, actor);
    const head = await this.head(branch);
    const files = await this.workingFiles(deckId);
    if (equalFiles(files, await this.filesAt(head))) return head;
    const commit = await this.commitTree(await this.tree(files), [head], message, actor);
    await guard?.();
    await this.git(['update-ref', '-m', message, ref(branch), commit, head]);
    return commit;
  }
  async fork(deckId: string, name: string, revision: string | undefined, actor: Actor, host: GitStoreHost): Promise<string> {
    const source = await this.ensure(deckId, actor);
    const base = revision ? await this.resolveRevision(source, revision, host) : await this.checkpoint(deckId, 'Checkpoint before fork', actor, host.check);
    const label = name.trim();
    if (!label || label.length > 100 || !pathOK(label) || label.includes('/')) throw new Error('Use a presentation name without slashes or leading dots');
    const folder = deckId.includes('/') ? deckId.slice(0, deckId.lastIndexOf('/')) + '/' : '';
    const targetId = folder + label;
    const target = this.directory(targetId);
    if (existsSync(target)) throw new Error('A presentation with that name already exists');
    const branch = { id: randomUUID(), family: source.family, deckId: targetId, name: label };
    const files = await this.filesAt(base);
    const snapshot = await this.snapshot(files);
    files.set('deck.json', await this.blob(JSON.stringify({ ...snapshot.deck, title: label }, null, 2) + '\n'));
    const commit = await this.commitTree(await this.tree(files), [base], `Fork ${source.name} as ${label}`, actor);
    const stage = await this.materialize(commit);
    try {
      await this.atomic(join(stage, '.deckwerk-branch.json'), { id: branch.id });
      await host.prepareFork?.(stage);
      await host.check?.();
      await rename(stage, target);
      await this.git(['update-ref', ref(branch), commit]);
      await this.record(branch);
    } catch (error) { await rm(stage, { recursive: true, force: true }); throw error; }
    return targetId;
  }
  async tag(deckId: string, name: string, revision: string | undefined, actor: Actor, host: GitStoreHost): Promise<string> {
    const branch = await this.ensure(deckId, actor);
    const commit = revision ? await this.resolveRevision(branch, revision, host) : await this.checkpoint(deckId, `Checkpoint for ${name}`, actor, host.check);
    const tag = `refs/tags/${branch.family}/${name}`;
    await this.git(['check-ref-format', tag]);
    await this.git(['update-ref', tag, commit, '0000000000000000000000000000000000000000']);
    return commit;
  }
  private async mergeSnapshots(base: Snapshot, ours: Snapshot, theirs: Snapshot, preserveTitle = true): Promise<{ plan: MergePlan; conflicts: GitFileConflict[] }> {
    // A fork's audience/name is its identity, not a change to import from its base.
    const otherDeck = preserveTitle ? { ...theirs.deck, title: ours.deck.title } : theirs.deck;
    const baseDeck = preserveTitle ? { ...base.deck, title: ours.deck.title } : base.deck;
    const plan = planMerge({ base: baseDeck, local: ours.deck, remote: otherDeck, baseTheme: base.theme, localTheme: ours.theme, remoteTheme: theirs.theme });
    const conflicts: GitFileConflict[] = [];
    for (const path of new Set([...base.files.keys(), ...ours.files.keys(), ...theirs.files.keys()])) {
      if (path === 'deck.json' || path === ours.deck.theme || path === theirs.deck.theme) continue;
      const b = base.files.get(path), l = ours.files.get(path), r = theirs.files.get(path);
      if (l !== r && l !== b && r !== b) conflicts.push({ path, ours: l ?? null, theirs: r ?? null });
    }
    return { plan, conflicts };
  }
  private async mergedFiles(pending: Pending, choices: MergeChoices, fileChoices: Record<string, 'local' | 'remote'>): Promise<Files> {
    const { public: preview, base, ours, theirs } = pending;
    if (unresolved(preview.plan, choices).length) throw new Error('Resolve every slide conflict before applying');
    for (const conflict of preview.fileConflicts) if (!fileChoices[conflict.path]) throw new Error(`Choose which file to keep: ${conflict.path}`);
    const result = resolveMerge(preview.plan, choices);
    const problems = validateDeckIntegrity(result.deck);
    if (problems.length) throw new Error(problems.join('\n'));
    const files: Files = new Map();
    for (const path of new Set([...base.files.keys(), ...ours.files.keys(), ...theirs.files.keys()])) {
      if (path === 'deck.json' || path === ours.deck.theme || path === theirs.deck.theme) continue;
      const b = base.files.get(path), l = ours.files.get(path), r = theirs.files.get(path);
      const chosen = fileChoices[path] === 'local' ? l : fileChoices[path] === 'remote' ? r : l === r ? l : l === b ? r : l;
      if (chosen) files.set(path, chosen);
    }
    files.set('deck.json', await this.blob(JSON.stringify(result.deck, null, 2) + '\n'));
    files.set(result.deck.theme, await this.blob(result.themeCss ?? ours.theme));
    return files;
  }
  async preview(deckId: string, action: GitAction, revision: string | undefined, actor: Actor, host: GitStoreHost): Promise<GitPreview> {
    const branch = await this.ensure(deckId, actor);
    const head = await this.head(branch);
    const working = await this.tree(await this.workingFiles(deckId));
    const ours = await this.snapshot(await this.filesAt(working));
    let source = head;
    let baseId = head;
    let replay: string[] | undefined;
    let stash: string | undefined;
    if (action === 'stash-pop') {
      const stashes = await this.refs(`refs/stash/${branch.id}/`);
      const chosen = revision ? stashes.find((s) => s.name === revision || s.commit === revision) : stashes.at(-1);
      if (!chosen) throw new Error('No saved stash');
      source = chosen.commit; stash = chosen.name;
      baseId = await this.text(['rev-parse', `${source}^`]);
    } else if (action !== 'stash') {
      if (!revision) throw new Error('Choose a branch or checkpoint');
      source = await this.resolveRevision(branch, revision, host);
      if (action === 'merge' || action === 'rebase') {
        baseId = await this.text(['merge-base', head, source]);
        if (action === 'rebase') {
          if (!equalFiles(ours.files, await this.filesAt(head))) throw new Error('Commit or stash your edits before rebasing');
          const merges = await this.text(['rev-list', '--merges', `${baseId}..${head}`]);
          if (merges) throw new Error('This range contains merge commits. Merge the source branch instead, preserving its history.');
          replay = (await this.text(['rev-list', '--reverse', `${baseId}..${head}`])).split('\n').filter(Boolean);
        }
      } else if (action === 'cherry-pick' || action === 'revert') {
        const parents = (await this.text(['show', '-s', '--format=%P', source])).split(' ').filter(Boolean);
        if (parents.length !== 1) throw new Error('Choose a non-merge checkpoint with one parent');
        baseId = action === 'revert' ? source : parents[0];
        if (action === 'revert') source = parents[0];
      }
    }
    let base = await this.snapshot(await this.filesAt(baseId));
    let theirs = await this.snapshot(await this.filesAt(source));
    if (action === 'reset' || action === 'restore' || action === 'stash') base = ours;
    if (action === 'rebase') {
      // Replay oldest to newest; each step has an explicit parent and its own conflicts.
      if (replay!.length) {
        const first = replay![0];
        base = await this.snapshot(await this.filesAt(`${first}^`));
        theirs = await this.snapshot(await this.filesAt(first));
      } else { base = ours; }
    }
    const target = action === 'rebase' && replay!.length ? await this.snapshot(await this.filesAt(source)) : ours;
    if (action === 'rebase') target.deck = { ...target.deck, title: ours.deck.title };
    const { plan, conflicts } = await this.mergeSnapshots(base, target, theirs, action !== 'reset' && action !== 'restore' && action !== 'stash');
    const token = randomUUID();
    const preview: GitPreview = { token, action, target: head, source: action === 'rebase' && replay?.length ? replay[0] : source, message: `${action} ${revision ?? ''}`.trim(), plan,
      files: changedFiles(target.files, theirs.files), fileConflicts: conflicts, steps: replay?.length ?? 1 };
    const sourceBranch = (await this.visible(branch, host)).find((b) => b.id === revision || b.deckId === revision || b.name === revision);
    this.pending.set(token, { public: preview, branch, head, working, source, actor, expires: Date.now() + 20 * 60_000,
      base, ours: target, theirs, replay, stash, sourceBranch: sourceBranch?.id, sourceHead: sourceBranch ? await this.head(sourceBranch) : undefined });
    for (const [key, entry] of this.pending) if (entry.expires < Date.now()) this.pending.delete(key);
    return preview;
  }
  abort(token: string): void { this.pending.delete(token); }
  async apply(deckId: string, token: string, choices: MergeChoices, files: Record<string, 'local' | 'remote'>, host: GitStoreHost): Promise<{ commit?: string; preview?: GitPreview }> {
    const pending = this.pending.get(token);
    if (!pending || pending.expires < Date.now() || pending.branch.deckId !== deckId) throw new Error('This preview expired. Preview the operation again.');
    const guard = await host.flush(deckId);
    if (await this.head(pending.branch) !== pending.head || await this.tree(await this.workingFiles(deckId)) !== pending.working) throw new Error('The presentation changed since this preview. Preview again before applying.');
    if (pending.sourceBranch) {
      const source = (await this.records()).find((b) => b.id === pending.sourceBranch)!;
      if (!(await host.canRead(source.deckId)) || await this.head(source) !== pending.sourceHead) throw new Error('The source branch changed. Preview again.');
    }
    const action = pending.public.action;
    const merged = await this.mergedFiles(pending, choices, files);
    const tree = await this.tree(merged);
    let parent = pending.head;
    const workingCommit = await this.commitTree(pending.working, [pending.head], `Recovery before ${action}`, pending.actor);
    const recoveryName = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    await this.git(['update-ref', `refs/recovery/${pending.branch.id}/${recoveryName}`, workingCommit]);
    if (pending.working !== await this.text(['rev-parse', `${pending.head}^{tree}`])) parent = workingCommit;
    let commit: string;
    if (action === 'reset') commit = pending.source;
    else if (action === 'stash') {
      await this.git(['update-ref', `refs/stash/${pending.branch.id}/${recoveryName}`, workingCommit]);
      commit = pending.head;
    } else if (action === 'rebase') {
      const replay = pending.replay!;
      const original = replay.shift();
      const message = original ? await this.text(['show', '-s', '--format=%B', original]) : 'Rebase';
      commit = original || tree !== await this.text(['rev-parse', `${pending.source}^{tree}`])
        ? await this.commitTree(tree, [pending.source], message, pending.actor) : pending.source;
      if (replay.length) {
        const next = replay[0];
        pending.source = commit;
        pending.base = await this.snapshot(await this.filesAt(`${next}^`));
        pending.ours = await this.snapshot(merged);
        pending.theirs = await this.snapshot(await this.filesAt(next));
        const result = await this.mergeSnapshots(pending.base, pending.ours, pending.theirs);
        pending.public = { ...pending.public, source: next, plan: result.plan, files: changedFiles(pending.ours.files, pending.theirs.files), fileConflicts: result.conflicts, steps: replay.length };
        return { preview: pending.public };
      }
    } else commit = await this.commitTree(tree, action === 'merge' ? [...new Set([parent, pending.source])] : [parent], pending.public.message, pending.actor);
    const directory = await this.materialize(action === 'reset' || action === 'stash' ? commit : tree);
    const rollback = await this.materialize(workingCommit);
    try {
      guard();
      const beforeFiles = await this.filesAt(pending.working);
      const afterFiles = action === 'reset' || action === 'stash' ? await this.filesAt(commit) : merged;
      const paths = changedFiles(beforeFiles, afterFiles).filter((path) => path.startsWith('assets/'));
      const beforeSnapshot = await this.snapshot(beforeFiles), afterSnapshot = await this.snapshot(afterFiles);
      await host.apply(deckId, directory, guard, `Git ${pending.public.message}`, rollback, {
        deck: afterSnapshot.deck, theme: afterSnapshot.theme, ops: diffDecks(beforeSnapshot.deck, afterSnapshot.deck),
        changed: Object.fromEntries(paths.filter((path) => afterFiles.has(path)).map((path) => [path, afterFiles.get(path)!])),
        removed: Object.fromEntries(paths.filter((path) => !afterFiles.has(path)).map((path) => [path, beforeFiles.get(path)!])),
      });
      await this.git(['update-ref', '-m', pending.public.message, ref(pending.branch), commit, pending.head]);
      if (pending.stash) await this.git(['update-ref', '-d', `refs/stash/${pending.branch.id}/${pending.stash}`]);
      this.pending.delete(token);
      return { commit };
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(rollback, { recursive: true, force: true });
    }
  }
  async diff(deckId: string, revision: string, actor: Actor, host: GitStoreHost): Promise<GitPreview> {
    return this.preview(deckId, 'restore', revision, actor, host);
  }
  async revision(deckId: string, requested: string, actor: Actor, host: GitStoreHost): Promise<string> {
    return this.resolveRevision(await this.ensure(deckId, actor), requested, host);
  }
  /** Materialize blobs as plain files; no checkout hooks, filters or symlinks. */
  async materialize(revision: string): Promise<string> {
    const work = await mkdtemp(join(this.stateDir, 'snapshot-'));
    try {
      for (const [path, hash] of await this.filesAt(revision)) {
        const destination = join(work, path);
        await mkdir(dirname(destination), { recursive: true });
        const child = spawn('git', [`--git-dir=${this.repo}`, 'cat-file', 'blob', hash], { stdio: ['ignore', 'pipe', 'pipe'] });
        const done = new Promise<void>((accept, reject) => { child.on('error', reject); child.on('close', (code) => code === 0 ? accept() : reject(new Error('Could not read snapshot asset'))); });
        await Promise.all([pipeline(child.stdout, createWriteStream(destination)), done]);
      }
      return work;
    } catch (error) { await rm(work, { recursive: true, force: true }); throw error; }
  }
}

/** Install a prepared snapshot, preserving runtime markers, access controls and edit logs. */
export async function installPresentationFiles(target: string, snapshot: string): Promise<void> {
  const update = async (from: string, to: string): Promise<void> => {
    await mkdir(to, { recursive: true });
    const incoming = new Set((await readdir(from)).filter((name) => !name.startsWith('.') && (to !== target || !OMIT.has(name))));
    for (const entry of await readdir(to, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || (to === target && OMIT.has(entry.name)) || (to === target && (entry.name === 'deck.json' || entry.name === 'theme.css'))) continue;
      if (!incoming.has(entry.name)) await rm(join(to, entry.name), { recursive: true, force: true });
    }
    for (const name of incoming) {
      if (to === target && (name === 'deck.json' || name === 'theme.css')) continue;
      const source = join(from, name), destination = join(to, name);
      const info = await lstat(source);
      if (info.isSymbolicLink()) throw new Error('Snapshot contains a symlink');
      if (info.isDirectory()) await update(source, destination);
      else {
        const temporary = join(dirname(destination), `.${name}.${randomUUID()}.tmp`);
        await cp(source, temporary);
        await rename(temporary, destination);
      }
    }
  };
  await update(snapshot, target);
}
