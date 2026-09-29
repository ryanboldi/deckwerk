// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyEditorTheme,
  DEFAULT_EDITOR_THEME,
  EDITOR_FONTS,
  EDITOR_THEME_PRESETS,
  installEditorTheme,
  loadEditorTheme,
  presetById,
  saveEditorTheme,
} from '../src/renderer/editorTheme.js';

const STORAGE_KEY = 'deckwerk.editorTheme';
const root = (): HTMLElement => document.documentElement;
const cssVar = (name: string): string => root().style.getPropertyValue(name);

/** Every custom property a theme writes; the stylesheets must declare each one. */
const THEMED_VARS = [
  '--bg', '--panel', '--panel-2', '--line', '--text', '--muted', '--accent',
  '--accent-soft', '--green', '--yellow', '--danger', '--canvas', '--mono',
];

// Node's own experimental localStorage shadows jsdom's; hand the code jsdom's.
vi.stubGlobal('localStorage', new JSDOM('', { url: 'https://deckwerk.test/' }).window.localStorage);

beforeEach(() => {
  localStorage.clear();
  root().removeAttribute('style');
  delete root().dataset['editorTheme'];
});

afterEach(() => {
  localStorage.clear();
});

describe('editor theme presets', () => {
  it('have unique ids and a complete, valid palette', () => {
    const ids = EDITOR_THEME_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of EDITOR_THEME_PRESETS) {
      const { scheme, ...colors } = preset.palette;
      expect(['dark', 'light']).toContain(scheme);
      expect(Object.keys(colors).sort()).toEqual(
        ['accent', 'bg', 'canvas', 'danger', 'green', 'line', 'muted', 'panel', 'panel2', 'text', 'yellow'],
      );
      for (const [key, value] of Object.entries(colors)) {
        expect(value, `${preset.id}.${key}`).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });

  it('offer unique font ids', () => {
    const ids = EDITOR_FONTS.map((font) => font.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('default to the look the stylesheet already ships', () => {
    const css = readFileSync(resolve(__dirname, '../src/renderer/appChrome.css'), 'utf8');
    const palette = presetById(DEFAULT_EDITOR_THEME.preset).palette;
    expect(css).toContain(`--bg: ${palette.bg};`);
    expect(css).toContain(`--accent: ${palette.accent};`);
    expect(css).toContain(`--canvas: ${palette.canvas};`);
  });
});

describe('applyEditorTheme', () => {
  it('writes the palette, font and scheme onto the root element', () => {
    const nord = presetById('nord').palette;
    applyEditorTheme({ preset: 'nord', font: 'system-sans' });
    expect(cssVar('--bg')).toBe(nord.bg);
    expect(cssVar('--panel-2')).toBe(nord.panel2);
    expect(cssVar('--text')).toBe(nord.text);
    expect(cssVar('--accent')).toBe(nord.accent);
    expect(cssVar('--mono')).toContain('system-ui');
    expect(root().dataset['editorTheme']).toBe('dark');
    for (const name of THEMED_VARS) expect(cssVar(name), name).not.toBe('');
  });

  it('themes the canvas behind the slide', () => {
    applyEditorTheme({ preset: 'paper', font: 'krypton' });
    expect(cssVar('--canvas')).toBe(presetById('paper').palette.canvas);
    expect(root().dataset['editorTheme']).toBe('light');
  });

  it('lets an accent override the preset and derives the soft wash from it', () => {
    applyEditorTheme({ preset: 'tokyo-night', font: 'krypton', accent: '#ff0080' });
    expect(cssVar('--accent')).toBe('#ff0080');
    expect(cssVar('--accent-soft').replace(/\s+/g, ' ')).toMatch(/^rgb\(255 0 128 \/ 12%\)$/);
  });

  it('falls back to the first preset and font for unknown ids', () => {
    applyEditorTheme({ preset: 'no-such-theme', font: 'no-such-font' });
    expect(cssVar('--bg')).toBe(EDITOR_THEME_PRESETS[0]!.palette.bg);
    expect(cssVar('--mono')).toBe(EDITOR_FONTS[0]!.stack);
  });
});

describe('editor theme persistence', () => {
  it('loads the default when nothing is saved', () => {
    expect(loadEditorTheme()).toEqual(DEFAULT_EDITOR_THEME);
  });

  it('round-trips a saved choice', () => {
    saveEditorTheme({ preset: 'gruvbox', font: 'inter', accent: '#123456' });
    expect(loadEditorTheme()).toEqual({ preset: 'gruvbox', font: 'inter', accent: '#123456' });
  });

  it('ignores corrupt or mistyped storage', () => {
    localStorage.setItem(STORAGE_KEY, '{not json');
    expect(loadEditorTheme()).toEqual(DEFAULT_EDITOR_THEME);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ preset: 7, font: null, accent: 3 }));
    expect(loadEditorTheme()).toEqual(DEFAULT_EDITOR_THEME);
  });

  it('applies the saved theme on install and follows changes from other windows', () => {
    saveEditorTheme({ preset: 'graphite', font: 'krypton' });
    installEditorTheme();
    expect(cssVar('--bg')).toBe(presetById('graphite').palette.bg);

    // Another window saves; this one hears it through the storage event.
    saveEditorTheme({ preset: 'paper', font: 'krypton' });
    window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY }));
    expect(cssVar('--bg')).toBe(presetById('paper').palette.bg);
    expect(cssVar('--canvas')).toBe(presetById('paper').palette.canvas);

    window.dispatchEvent(new StorageEvent('storage', { key: 'something-else' }));
    expect(cssVar('--bg')).toBe(presetById('paper').palette.bg);
  });
});

describe('editor stylesheets', () => {
  const chrome = readFileSync(resolve(__dirname, '../src/renderer/appChrome.css'), 'utf8');
  const editor = readFileSync(resolve(__dirname, '../src/renderer/editor/editor.css'), 'utf8');

  it('declare every variable a theme sets', () => {
    for (const name of THEMED_VARS) expect(chrome, name).toMatch(new RegExp(`${name}:`));
  });

  it('paint the canvas well from the theme, not a fixed color', () => {
    // Later rules win, so the last .canvas-host background is the one that shows.
    const rules = [...editor.matchAll(/^\.canvas-host\s*\{[^}]*background:\s*([^;]+);/gm)];
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.at(-1)![1]!.trim()).toBe('var(--canvas)');
  });
});
