import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDeck, type Deck } from '../src/shared/deck.js';
import { PresentationGit, installPresentationFiles, type GitStoreHost } from '../src/server/presentationGit.js';
import type { GitAction, GitPreview } from '../src/shared/presentationGit.js';

let root: string;
let store: PresentationGit;
const actor = { name: 'Researcher', email: 'researcher@example.test' };
let host: GitStoreHost;
const deck = (): Deck => parseDeck({ version: 1, title: 'VPO-base', slides: [
  { id: 'one', elements: [{ id: 'a', type: 'text', x: 0, y: 0, w: 500, h: 100, html: 'First' }] },
  { id: 'two', elements: [{ id: 'b', type: 'text', x: 0, y: 0, w: 500, h: 100, html: 'Second' }] },
] });
const read = async (id: string): Promise<Deck> => parseDeck(JSON.parse(await readFile(join(root, id, 'deck.json'), 'utf8')));
const write = async (id: string, deck: Deck) => writeFile(join(root, id, 'deck.json'), JSON.stringify(deck, null, 2) + '\n');
async function edit(id: string, slide: number, text: string) {
  const value = await read(id);
  (value.slides[slide].elements[0] as { html: string }).html = text;
  await write(id, value);
}
const text = (deck: Deck, index: number) => (deck.slides[index].elements[0] as { html: string }).html;
const graph = (id = 'VPO-base') => store.graph(id, actor, host);
async function preview(id: string, action: GitAction, revision?: string) { return store.preview(id, action, revision, actor, host); }
async function apply(id: string, p: GitPreview, side?: 'local' | 'remote') {
  return store.apply(id, p.token, Object.fromEntries(p.plan.items.filter((i) => i.conflict).map((i) => [i.key, side ?? 'local'])),
    Object.fromEntries(p.fileConflicts.map((i) => [i.path, side ?? 'local'])), host);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'presentation-git-'));
  await mkdir(join(root, 'VPO-base', 'assets'), { recursive: true });
  await write('VPO-base', deck());
  await writeFile(join(root, 'VPO-base', 'theme.css'), '.role-title { color: red; }');
  await writeFile(join(root, 'VPO-base', 'assets', 'plot.txt'), 'original figure');
  await writeFile(join(root, 'VPO-base', 'AGENTS.md'), 'Use evidence and preserve the style.');
  await writeFile(join(root, 'VPO-base', 'access.json'), '{"owner":"original"}');
  store = new PresentationGit(root);
  host = {
    flush: async () => () => {},
    canRead: async () => true,
    prepareFork: async (dir) => writeFile(join(dir, 'access.json'), '{"owner":"fork-owner"}'),
    apply: async (id, directory, guard) => {
      guard();
      await installPresentationFiles(join(root, id), directory);
      await writeFile(join(root, id, 'deck.json'), await readFile(join(directory, 'deck.json')));
      await writeFile(join(root, id, 'theme.css'), await readFile(join(directory, 'theme.css')));
    },
  };
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('presentation Git', () => {
  it('forks a checkpoint with independent files, stable slide IDs, instructions and private permissions', async () => {
    const before = await graph();
    const fork = await store.fork('VPO-base', 'VPO-Jane-Street', undefined, actor, host);
    await edit(fork, 0, 'Audience-specific introduction');
    const commit = await store.checkpoint(fork, 'Tailor the introduction', actor);
    expect(text(await read('VPO-base'), 0)).toBe('First');
    expect((await read(fork)).slides.map((s) => s.id)).toEqual(['one', 'two']);
    expect(await readFile(join(root, fork, 'AGENTS.md'), 'utf8')).toContain('Use evidence');
    expect(await readFile(join(root, fork, 'access.json'), 'utf8')).toContain('fork-owner');
    const result = await graph(fork);
    expect(result.branches).toHaveLength(2);
    expect(result.commits.some((c) => c.id === before.branch.head)).toBe(true);
    expect(result.branch.head).toBe(commit);
    expect(result.dirty).toBe(false);
    await expect(store.fork('VPO-base', 'VPO-Jane-Street', undefined, actor, host)).rejects.toThrow('already exists');
  });

  it('merges disjoint slide changes and records both parents without renaming the audience deck', async () => {
    await store.fork('VPO-base', 'Jane', undefined, actor, host);
    await edit('Jane', 0, 'Jane introduction');
    const ours = await store.checkpoint('Jane', 'Audience', actor);
    await edit('VPO-base', 1, 'New result');
    const theirs = await store.checkpoint('VPO-base', 'New result', actor);
    const p = await preview('Jane', 'merge', 'VPO-base');
    expect(p.plan.conflicts).toBe(0);
    const result = await apply('Jane', p);
    const merged = await read('Jane');
    expect(merged.title).toBe('Jane');
    expect([text(merged, 0), text(merged, 1)]).toEqual(['Jane introduction', 'New result']);
    expect((await graph('Jane')).commits.find((c) => c.id === result.commit)!.parents).toEqual([ours, theirs]);
  });

  it('requires choices for overlapping slides and files, and refuses a stale preview', async () => {
    await store.fork('VPO-base', 'Jane', undefined, actor, host);
    await edit('Jane', 0, 'Jane text');
    await edit('VPO-base', 0, 'Base text');
    await writeFile(join(root, 'Jane', 'assets', 'plot.txt'), 'Jane figure');
    await writeFile(join(root, 'VPO-base', 'assets', 'plot.txt'), 'Base figure');
    await store.checkpoint('VPO-base', 'Changed evidence', actor);
    const p = await preview('Jane', 'merge', 'VPO-base');
    expect(p.plan.conflicts).toBeGreaterThan(0);
    expect(p.fileConflicts.map((f) => f.path)).toEqual(['assets/plot.txt']);
    await expect(store.apply('Jane', p.token, {}, {}, host)).rejects.toThrow('Resolve every slide');
    await edit('Jane', 1, 'More edits while reviewing');
    await expect(apply('Jane', p, 'remote')).rejects.toThrow('changed since');
    const fresh = await preview('Jane', 'merge', 'VPO-base');
    await apply('Jane', fresh, 'remote');
    expect(text(await read('Jane'), 0)).toBe('Base text');
    expect(text(await read('Jane'), 1)).toBe('More edits while reviewing');
    expect(await readFile(join(root, 'Jane', 'assets', 'plot.txt'), 'utf8')).toBe('Base figure');
  });

  it('resets to an old checkpoint and restores uncommitted work from a recovery ref', async () => {
    const original = (await graph()).branch.head;
    await edit('VPO-base', 0, 'Uncommitted work');
    await apply('VPO-base', await preview('VPO-base', 'reset', original));
    expect(text(await read('VPO-base'), 0)).toBe('First');
    expect((await graph()).branch.head).toBe(original);
    const recovery = (await graph()).recovery.at(-1)!;
    await apply('VPO-base', await preview('VPO-base', 'restore', recovery.name));
    expect(text(await read('VPO-base'), 0)).toBe('Uncommitted work');
    expect((await graph()).branch.head).not.toBe(original);
  });

  it('cherry-picks and reverts one checkpoint without losing later independent edits', async () => {
    await store.fork('VPO-base', 'Jane', undefined, actor, host);
    await edit('VPO-base', 1, 'New result');
    const change = await store.checkpoint('VPO-base', 'Result', actor);
    await apply('Jane', await preview('Jane', 'cherry-pick', change));
    const picked = (await graph('Jane')).branch.head;
    await edit('Jane', 0, 'Keep this introduction');
    await apply('Jane', await preview('Jane', 'revert', picked));
    expect([text(await read('Jane'), 0), text(await read('Jane'), 1)]).toEqual(['Keep this introduction', 'Second']);
  });

  it('rebases a sequence with a preview for each step and keeps old history recoverable', async () => {
    await store.fork('VPO-base', 'Jane', undefined, actor, host);
    await edit('Jane', 0, 'Jane first');
    await store.checkpoint('Jane', 'First revision', actor);
    await edit('Jane', 0, 'Jane second');
    const oldHead = await store.checkpoint('Jane', 'Second revision', actor);
    await edit('VPO-base', 1, 'Base improved');
    const newBase = await store.checkpoint('VPO-base', 'Improve result', actor);
    let p = await preview('Jane', 'rebase', 'VPO-base');
    for (let n = 0; n < 5; n++) {
      const result = await apply('Jane', p);
      if (!result.preview) break;
      p = result.preview;
    }
    const after = await graph('Jane');
    expect(after.branch.head).not.toBe(oldHead);
    expect(after.commits.some((c) => c.parents.includes(newBase))).toBe(true);
    expect(after.recovery.length).toBeGreaterThan(0);
    expect((await read('Jane')).title).toBe('Jane');
    expect([text(await read('Jane'), 0), text(await read('Jane'), 1)]).toEqual(['Jane second', 'Base improved']);
  });

  it('stashes work, pops it, and pins an immutable tag', async () => {
    const head = (await graph()).branch.head;
    await store.tag('VPO-base', 'presented', undefined, actor, host);
    await edit('VPO-base', 0, 'Draft');
    await apply('VPO-base', await preview('VPO-base', 'stash'));
    expect(text(await read('VPO-base'), 0)).toBe('First');
    expect((await graph()).stashes).toHaveLength(1);
    await apply('VPO-base', await preview('VPO-base', 'stash-pop'));
    expect(text(await read('VPO-base'), 0)).toBe('Draft');
    expect((await graph()).stashes).toHaveLength(0);
    expect((await graph()).tags).toEqual([{ name: 'presented', commit: head }]);
    await expect(store.tag('VPO-base', 'presented', undefined, actor, host)).rejects.toThrow();
  });

  it('tracks renamed folders and rejects guessed checkpoints from unrelated or hidden branches', async () => {
    const old = await graph();
    await rename(join(root, 'VPO-base'), join(root, 'Renamed'));
    expect((await graph('Renamed')).branch.id).toBe(old.branch.id);
    await mkdir(join(root, 'Other'));
    await write('Other', deck());
    await edit('Other', 0, 'Unrelated private material');
    const hidden = (await graph('Other')).branch.head;
    await expect(store.revision('Renamed', hidden, actor, host)).rejects.toThrow('accessible branch');
    await store.fork('Renamed', 'Private fork', undefined, actor, host);
    const privateHead = (await graph('Private fork')).branch.head;
    const restricted = { ...host, canRead: async (id: string) => id !== 'Private fork' };
    await expect(store.revision('Renamed', privateHead, actor, restricted)).rejects.toThrow('accessible branch');
  });
});

it('seeded history walk keeps checkpoint contents and recoverable resets consistent', async () => {
  let seed = 0x5eed;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  const snapshots = new Map<string, string[]>();
  const remember = async () => { const g = await graph(); const d = await read('VPO-base'); snapshots.set(g.branch.head, [text(d, 0), text(d, 1)]); };
  await remember();
  for (let step = 0; step < 18; step++) {
    const move = random() % 4;
    if (move < 2) {
      await edit('VPO-base', random() % 2, `Seeded edit ${step}`);
      await store.checkpoint('VPO-base', `Step ${step}`, actor); await remember();
    } else if (move === 2) {
      const commits = [...snapshots.keys()]; const target = commits[random() % commits.length];
      const before = await read('VPO-base');
      const p = await preview('VPO-base', 'reset', target); await apply('VPO-base', p);
      const after = await read('VPO-base'); expect([text(after, 0), text(after, 1)]).toEqual(snapshots.get(target));
      const recovery = (await graph()).recovery.at(-1)!;
      await apply('VPO-base', await preview('VPO-base', 'restore', recovery.commit));
      expect([text(await read('VPO-base'), 0), text(await read('VPO-base'), 1)]).toEqual([text(before, 0), text(before, 1)]);
      await remember();
    } else {
      await edit('VPO-base', 0, `Stashed ${step}`);
      await apply('VPO-base', await preview('VPO-base', 'stash'));
      await apply('VPO-base', await preview('VPO-base', 'stash-pop'));
      expect(text(await read('VPO-base'), 0)).toBe(`Stashed ${step}`); await remember();
    }
  }
}, 30_000);
