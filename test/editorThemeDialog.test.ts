// @vitest-environment jsdom
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadEditorTheme, presetById, saveEditorTheme } from '../src/renderer/editorTheme.js';
import { showEditorThemeDialog } from '../src/renderer/editor/editorThemeDialog.js';

const DIALOG = '#deckwerk-editor-appearance';
const cssVar = (name: string): string => document.documentElement.style.getPropertyValue(name);
const dialog = (): HTMLElement | null => document.querySelector<HTMLElement>(DIALOG);

function card(preset: string): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>(`.editor-theme-card[data-preset="${preset}"]`)!;
}
function button(label: string): HTMLButtonElement {
  return [...document.querySelectorAll<HTMLButtonElement>(`${DIALOG} button`)]
    .find((b) => b.textContent === label)!;
}
function accentInput(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>('.editor-theme-accent')!;
}
function fontSelect(): HTMLSelectElement {
  return document.querySelector<HTMLSelectElement>(`${DIALOG} select`)!;
}

// Node's own experimental localStorage shadows jsdom's; hand the code jsdom's.
vi.stubGlobal('localStorage', new JSDOM('', { url: 'https://deckwerk.test/' }).window.localStorage);

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('style');
  document.body.replaceChildren();
});

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe('editor appearance dialog', () => {
  it('opens once, with the saved choice selected', () => {
    saveEditorTheme({ preset: 'nord', font: 'inter' });
    showEditorThemeDialog();
    showEditorThemeDialog();
    expect(document.querySelectorAll(DIALOG)).toHaveLength(1);
    expect(card('nord').getAttribute('aria-checked')).toBe('true');
    expect(card('paper').getAttribute('aria-checked')).toBe('false');
    expect(fontSelect().value).toBe('inter');
    expect(accentInput().value).toBe(presetById('nord').palette.accent);
  });

  it('previews a palette live without saving it', () => {
    showEditorThemeDialog();
    card('paper').click();
    expect(cssVar('--bg')).toBe(presetById('paper').palette.bg);
    expect(cssVar('--canvas')).toBe(presetById('paper').palette.canvas);
    expect(card('paper').getAttribute('aria-checked')).toBe('true');
    expect(localStorage.getItem('deckwerk.editorTheme')).toBeNull();
  });

  it('saves on Done', () => {
    showEditorThemeDialog();
    card('gruvbox').click();
    fontSelect().value = 'serif';
    fontSelect().dispatchEvent(new Event('change'));
    button('Done').click();
    expect(dialog()).toBeNull();
    expect(loadEditorTheme()).toEqual({ preset: 'gruvbox', font: 'serif' });
  });

  it('reverts the preview on Cancel', () => {
    saveEditorTheme({ preset: 'graphite', font: 'krypton' });
    showEditorThemeDialog();
    card('paper').click();
    button('Cancel').click();
    expect(dialog()).toBeNull();
    expect(cssVar('--bg')).toBe(presetById('graphite').palette.bg);
    expect(loadEditorTheme().preset).toBe('graphite');
  });

  it('reverts the preview on Escape without letting the key reach the editor', () => {
    showEditorThemeDialog();
    card('nord').click();
    let reachedDocument = false;
    document.addEventListener('keydown', () => { reachedDocument = true; }, { once: true });
    dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(dialog()).toBeNull();
    expect(reachedDocument).toBe(false);
    expect(cssVar('--bg')).toBe(presetById('tokyo-night').palette.bg);
  });

  it('overrides the accent and restores the preset accent', () => {
    showEditorThemeDialog();
    const reset = button('Preset accent');
    expect(reset.disabled).toBe(true);

    accentInput().value = '#ff0080';
    accentInput().dispatchEvent(new Event('input'));
    expect(cssVar('--accent')).toBe('#ff0080');
    expect(reset.disabled).toBe(false);

    reset.click();
    expect(cssVar('--accent')).toBe(presetById('tokyo-night').palette.accent);
    expect(reset.disabled).toBe(true);
  });

  it('drops a custom accent when switching palette', () => {
    showEditorThemeDialog();
    accentInput().value = '#ff0080';
    accentInput().dispatchEvent(new Event('input'));
    card('nord').click();
    expect(cssVar('--accent')).toBe(presetById('nord').palette.accent);
  });

  it('resets to the default theme', () => {
    saveEditorTheme({ preset: 'paper', font: 'serif', accent: '#123456' });
    showEditorThemeDialog();
    button('Default').click();
    button('Done').click();
    expect(loadEditorTheme()).toEqual({ preset: 'tokyo-night', font: 'krypton' });
  });
});
