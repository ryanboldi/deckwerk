import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { saveDeck } from '../src/main/deckStore.js';
import { startCollabServer, type RunningCollabServer } from '../src/server/collabServer.js';
import { emptyDeck, type Deck } from '../src/shared/deck.js';
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
 * Changing a value in the Props panel rebuilds it, and the rebuild used to
 * throw the panel back to its top — a control far down it could not be
 * adjusted twice without scrolling back to it. Real clicks on the panel.
 */
const DECK_ID = 'panel-scroll';

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

const text = (id: string, y: number) => ({
  id, type: 'text', x: 200, y, w: 900, h: 160, rot: 0, z: 1, opacity: 1, class: ['role-body'], style: {},
  html: `<p>${id}</p>`, align: 'left', valign: 'top',
});

describe.skipIf(!electronBinary)('the Props panel', () => {
  it('stays where it was scrolled when a value changes', { timeout: 120_000 }, async () => {
    workDir = await mkdtemp(join(tmpdir(), 'panel-scroll-'));
    const decksRoot = join(workDir, 'decks');
    const deckDir = join(decksRoot, DECK_ID);
    const profileDir = join(workDir, 'electron-profile');
    await mkdir(deckDir, { recursive: true });
    await mkdir(profileDir, { recursive: true });
    const deck = emptyDeck('Panel scroll');
    deck.slides[0].elements = [text('first', 150), text('second', 600)] as Deck['slides'][number]['elements'];
    await saveDeck(deckDir, deck);
    await writeFile(join(deckDir, 'theme.css'), '.slide { background: #fff; }\n', 'utf8');
    server = await startCollabServer({ rootDir: decksRoot, clientDir: await collabClientDir(), host: '127.0.0.1', port: 0 });
    browser = await launchBrowser(`http://127.0.0.1:${server.port}/?deck=${DECK_ID}&name=Scroll`, profileDir);
    const target = await findTarget(browser.debugPort, (c) => c.url.includes(`deck=${DECK_ID}`), browser.log);
    editor = await Cdp.connect(target.webSocketDebuggerUrl!);
    const cdp = editor;
    await eventually(async () => cdp.evaluate<boolean>(`Boolean(document.querySelector('#canvas [data-element-id="second"]'))`), 'no canvas');
    // A short window, so the text panel is taller than its column.
    await cdp.call('Emulation.setDeviceMetricsOverride', { width: 1400, height: 640, deviceScaleFactor: 1, mobile: false });
    await new Promise((resolve) => setTimeout(resolve, 300));

    const select = async (id: string) => {
      const at = await cdp.evaluate<{ x: number; y: number }>(`(() => {
        const r = document.querySelector('#canvas [data-element-id="${id}"]').getBoundingClientRect();
        return { x: r.left + 10, y: r.top + r.height / 2 };
      })()`);
      await cdp.clickAt(at.x, at.y);
      await new Promise((resolve) => setTimeout(resolve, 300));
    };
    /** The panel's scrolling column: the nearest scrolled-capable ancestor of the inspector. */
    const SCROLLER = `(() => {
      for (let at = document.querySelector('.editor-inspector'); at; at = at.parentElement) {
        if (at.scrollHeight > at.clientHeight + 20 && /auto|scroll/.test(getComputedStyle(at).overflowY)) return at;
      }
      return null;
    })()`;
    const scrollTop = () => cdp.evaluate<number>(`${SCROLLER}.scrollTop`);

    await select('first');
    expect(await cdp.evaluate<boolean>(`Boolean(${SCROLLER})`), 'the panel does not scroll in this window').toBe(true);
    await cdp.evaluate(`(() => { const s = ${SCROLLER}; s.scrollTop = s.scrollHeight; })()`);
    const scrolled = await scrollTop();
    expect(scrolled).toBeGreaterThan(50);

    // Click alignment buttons in the panel, which is now scrolled to its end.
    for (const title of ['Align centre', 'Align right']) {
      const button = await cdp.evaluate<{ x: number; y: number } | null>(`(() => {
        const b = [...document.querySelectorAll('.editor-inspector button')]
          .find((n) => n.title === ${JSON.stringify(title)} && n.getBoundingClientRect().height > 0);
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`);
      expect(button, `${title} is visible in the scrolled panel`).not.toBeNull();
      await cdp.clickAt(button!.x, button!.y);
      await eventually(async () => {
        const response = await fetch(`http://127.0.0.1:${server!.port}/api/deck?deck=${DECK_ID}`);
        const el = (await response.json() as Deck).slides[0].elements.find((e) => e.id === 'first');
        return el?.type === 'text' && el.align === (title === 'Align centre' ? 'center' : 'right');
      }, `${title} never reached the deck`);
      expect(await scrollTop(), `after ${title}`).toBe(scrolled);
    }
  });
});
