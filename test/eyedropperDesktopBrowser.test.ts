import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { electronBinary, eventually } from './support/browserSession.js';
import { launchDesktopEditor, type DesktopEditor } from './support/desktopEditorSession.js';

/**
 * The colour picker's eyedropper in the desktop app, where Chromium's own
 * EyeDropper does not exist: the window is captured, shown as a still with a
 * loupe of magnified pixels, and a click takes the pixel under the pointer.
 * Real pointer and key input throughout.
 */
let desktop: DesktopEditor | null = null;

afterEach(async () => {
  await desktop?.close();
  desktop = null;
});

describe.skipIf(!electronBinary)('the eyedropper in the desktop editor', () => {
  it('picks the slide background into a shape fill, and Escape changes nothing', { timeout: 120_000 }, async () => {
    desktop = await launchDesktopEditor('body-text', '<p>Body copy</p>');
    const cdp = desktop.cdp;
    await cdp.evaluate(`[...document.querySelectorAll('.shape-menu-trigger')]
      .find((node) => node.getBoundingClientRect().width > 0 && node.textContent?.trim() === 'Shape')?.click()`);
    await cdp.clickByText('.shape-menu-item', 'Rectangle', 'Rectangle');
    const shapeFill = () => cdp.evaluate<string | null>(`(() => {
      const node = [...document.querySelectorAll('#canvas [data-element-id^="shape"] svg rect')].at(-1);
      return node ? node.getAttribute('fill') : null;
    })()`);
    const before = (await eventually(shapeFill, 'no rectangle was inserted'))!;

    // A point on the slide clear of every object, and what is painted there.
    const spot = await cdp.evaluate<{ x: number; y: number; hex: string }>(`(() => {
      const slide = document.querySelector('#canvas .slide');
      const r = slide.getBoundingClientRect();
      const [red, green, blue] = getComputedStyle(slide).backgroundColor.match(/\\d+/g).map(Number);
      const hex = '#' + [red, green, blue].map((n) => n.toString(16).padStart(2, '0')).join('');
      return { x: r.left + r.width * 0.04, y: r.top + r.height * 0.94, hex };
    })()`);
    expect(spot.hex).not.toBe(before.toLowerCase());

    const openPicker = async () => {
      await cdp.evaluate(`[...document.querySelectorAll('.field-color')]
        .find((field) => field.getBoundingClientRect().width > 0 && field.querySelector('span')?.textContent === 'Fill')
        .querySelector('.color-picker-trigger').click()`);
      await eventually(async () => cdp.evaluate<boolean>(
        `Boolean(document.querySelector('.color-picker-popover .color-picker-eyedropper'))`),
      'the colour picker offers no eyedropper');
      await cdp.click('.color-picker-popover .color-picker-eyedropper', 'eyedropper');
      await eventually(async () => cdp.evaluate<boolean>(`Boolean(document.querySelector('.eyedropper-overlay'))`),
        'the eyedropper never showed the window still');
    };
    const mouse = (type: string, x: number, y: number) => cdp.call('Input.dispatchMouseEvent', {
      type, x, y, button: type === 'mouseMoved' ? 'none' : 'left',
      buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1,
    });

    // Escape leaves without picking.
    await openPicker();
    await cdp.key('Escape', 27);
    await eventually(async () => cdp.evaluate<boolean>(`!document.querySelector('.eyedropper-overlay')`),
      'Escape did not close the eyedropper');
    expect(await shapeFill()).toBe(before);

    // Hover: the loupe shows the magnified pixels and names the one under the pointer.
    await openPicker();
    await mouse('mouseMoved', spot.x - 3, spot.y);
    await mouse('mouseMoved', spot.x, spot.y);
    const loupe = await eventually(async () => cdp.evaluate<{ readout: string; size: number } | null>(`(() => {
      const loupe = document.querySelector('.eyedropper-loupe');
      if (!loupe || loupe.style.visibility === 'hidden') return null;
      return { readout: loupe.querySelector('.eyedropper-readout').textContent,
        size: loupe.querySelector('canvas').getBoundingClientRect().width };
    })()`), 'the loupe never appeared');
    expect(loupe!.readout).toBe(spot.hex);
    expect(loupe!.size).toBeGreaterThan(100);
    if (process.env.DECKWERK_TEST_SHOTS) {
      const { data } = await cdp.call('Page.captureScreenshot', { format: 'png' }) as { data: string };
      await writeFile(join(process.env.DECKWERK_TEST_SHOTS, 'eyedropper.png'), Buffer.from(data, 'base64'));
    }

    // Click: that colour is the fill, and the picker is still open to refine it.
    await mouse('mousePressed', spot.x, spot.y);
    await mouse('mouseReleased', spot.x, spot.y);
    await eventually(async () => (await shapeFill())?.toLowerCase() === spot.hex, 'the picked colour never became the fill');
    expect(await cdp.evaluate<boolean>(`!document.querySelector('.eyedropper-overlay')`)).toBe(true);
    expect(await cdp.evaluate<boolean>(`Boolean(document.querySelector('.color-picker-popover'))`)).toBe(true);
    expect(await cdp.evaluate<string>(`document.querySelector('.color-picker-popover input[aria-label="Hex color"]').value`))
      .toBe(spot.hex);
  });
});
