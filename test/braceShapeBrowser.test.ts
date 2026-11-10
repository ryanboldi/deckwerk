import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { emptyDeck, type Deck } from '../src/shared/deck.js';
import { DEFAULT_BRACE_DEPTH, braceTip } from '../src/shared/brace.js';
import { lineEndpoints } from '../src/renderer/editor/canvas.js';
import {
  Cdp,
  electronBinary,
  eventually,
  findTarget,
  launchBrowser,
  stopBrowser,
  type RunningBrowser,
} from './support/browserSession.js';
import { collabClientDir } from './support/collabClient.js';

/**
 * A curly brace from the Shape menu, shaped with real pointer input.
 *
 * The brace has a line's two endpoint handles and one more at its point.
 * Dragging the point across the chord flips which way the brace points and
 * sets the radius of all four curls at once; dragging an endpoint reshapes
 * the brace with the point following the new midpoint.
 */
const DECK_ID = 'brace-shape';

type ShapeEl = Extract<Deck['slides'][number]['elements'][number], { type: 'shape' }>;

let workDir = '';
let server: RunningCollabServer | null = null;
let browser: RunningBrowser | null = null;
let editor: Cdp | null = null;

afterEach(async () => {
  editor?.close();
  editor = null;
  await stopBrowser(browser?.process ?? null);
  browser = null;
  await server?.close();
  server = null;
  if (workDir) await rm(workDir, { recursive: true, force: true });
  workDir = '';
});

describe.skipIf(!electronBinary)('a curly brace with a point to drag', () => {
  it('inserts a brace, flips it by its point and stretches it by an endpoint', { timeout: 120_000 }, async () => {
    workDir = await mkdtemp(join(tmpdir(), 'brace-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const clientDir = await collabClientDir();
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(deckDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    await saveDeck(deckDir, emptyDeck('Brace'));
    await writeFile(join(deckDir, 'theme.css'), '.slide { background: #fff; }\n', 'utf8');
    server = await startCollabServer({ rootDir: decksRoot, clientDir, host: '127.0.0.1', port: 0 });
    browser = await launchBrowser(`http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=Brace`, profileDir);
    const target = await findTarget(browser.debugPort, (c) => c.url.includes(`deck=${DECK_ID}`), browser.log);
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    await eventually(async () => editor!.evaluate<boolean>(`Boolean(document.querySelector('.shape-menu-trigger'))`), 'no toolbar');
    // The toolbar keeps a compact copy of its controls; open the visible one.
    await editor.evaluate(`[...document.querySelectorAll('.shape-menu-trigger')]
      .find((node) => node.getBoundingClientRect().width > 0 && node.textContent?.trim() === 'Shape')?.click()`);
    await editor.clickByText('.shape-menu-item', 'Curly brace', 'Curly brace');
    const saved = async () => {
      const response = await fetch(`http://127.0.0.1:${server!.port}/api/deck?deck=${DECK_ID}`);
      return (await response.json() as Deck).slides[0].elements.find((e) => e.type === 'shape') as ShapeEl | undefined;
    };
    const inserted = (await eventually(saved, 'no brace was inserted', (el) => el?.shape === 'brace'))!;
    expect(inserted.braceDepth).toBe(DEFAULT_BRACE_DEPTH);
    expect(await editor.evaluate<number>(`document.querySelectorAll('.handle-endpoint').length`)).toBe(2);
    expect(await editor.evaluate<number>(`document.querySelectorAll('.handle-brace-tip').length`)).toBe(1);

    const slide = await editor.evaluate<{ left: number; top: number; scale: number }>(`(() => {
      const r = document.querySelector('#canvas .slide').getBoundingClientRect();
      return { left: r.left, top: r.top, scale: r.width / 1920 };
    })()`);
    const screen = (p: { x: number; y: number }) => ({ x: slide.left + p.x * slide.scale, y: slide.top + p.y * slide.scale });
    const mouse = (type: string, p: { x: number; y: number }) => editor!.call('Input.dispatchMouseEvent', {
      type, x: p.x, y: p.y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1,
    });
    const drag = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
      const a = screen(from);
      const b = screen(to);
      await mouse('mouseMoved', a);
      await mouse('mousePressed', a);
      await mouse('mouseMoved', { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      await mouse('mouseMoved', b);
      await mouse('mouseReleased', b);
    };

    // The handle is drawn where the point is.
    const tip = braceTip(inserted);
    const drawn = await editor.evaluate<{ x: number; y: number }>(`(() => {
      const r = document.querySelector('.handle-brace-tip').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    expect(drawn.x).toBeCloseTo(screen(tip).x, 0);
    expect(drawn.y).toBeCloseTo(screen(tip).y, 0);

    // Drag the point 70px to the other side of the chord: the brace flips.
    const chordY = inserted.y + inserted.h / 2;
    await drag(tip, { x: tip.x, y: chordY - 70 });
    const flipped = (await eventually(saved, 'the brace never flipped in the saved deck',
      (el) => (el?.braceDepth ?? 0) < 0))!;
    expect(Math.abs(flipped.braceDepth! + 70)).toBeLessThanOrEqual(2);

    // Drag the end 200px further right: longer brace, same depth, point at the new middle.
    const { end } = lineEndpoints(flipped);
    await drag(end, { x: end.x + 200, y: end.y });
    const stretched = (await eventually(saved, 'the endpoint never moved in the saved deck',
      (el) => (el?.w ?? 0) > flipped.w + 150))!;
    expect(stretched.braceDepth).toBe(flipped.braceDepth);
    expect(lineEndpoints(stretched).start.x).toBeCloseTo(lineEndpoints(flipped).start.x, 0);
    if (process.env.DECKWERK_TEST_SHOTS) {
      const { data } = await editor.call('Page.captureScreenshot', { format: 'png' }) as { data: string };
      await writeFile(join(process.env.DECKWERK_TEST_SHOTS, 'brace.png'), Buffer.from(data, 'base64'));
    }
  });
});
