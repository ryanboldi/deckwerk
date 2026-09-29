/**
 * Editor themes: the look of DeckWerk's own chrome — toolbar, panels, dialogs.
 * Deck themes (a deck's theme.css) style the slides and are untouched here.
 *
 * The chrome is already drawn from CSS custom properties on :root (see
 * appChrome.css and editor.css), so a theme is just a set of overrides written
 * to the root element's inline style. The choice lives in localStorage, which
 * every same-origin window shares; the storage event carries a change made in
 * one window to the others.
 */

export interface EditorThemePalette {
  scheme: 'dark' | 'light';
  bg: string;
  panel: string;
  panel2: string;
  line: string;
  text: string;
  muted: string;
  accent: string;
  green: string;
  yellow: string;
  danger: string;
  /** The well the slide sits in on the canvas. */
  canvas: string;
}

export interface EditorThemePreset {
  id: string;
  label: string;
  palette: EditorThemePalette;
}

export interface EditorFont {
  id: string;
  label: string;
  stack: string;
}

export interface EditorThemeChoice {
  preset: string;
  font: string;
  /** Overrides the preset's accent when set. */
  accent?: string;
}

export const EDITOR_THEME_PRESETS: readonly EditorThemePreset[] = [
  {
    id: 'tokyo-night',
    label: 'Tokyo Night',
    palette: {
      scheme: 'dark', bg: '#16161e', panel: '#1a1b26', panel2: '#20212e', line: '#2c2e3d',
      text: '#c0caf5', muted: '#565f89', accent: '#7aa2f7', green: '#9ece6a', yellow: '#e0af68', danger: '#f7768e',
      canvas: '#101017',
    },
  },
  {
    id: 'graphite',
    label: 'Graphite',
    palette: {
      scheme: 'dark', bg: '#161619', panel: '#1d1d21', panel2: '#27272c', line: '#313138',
      text: '#ececf1', muted: '#8f8f9c', accent: '#4f8ef7', green: '#4ade80', yellow: '#f59e0b', danger: '#e5544b',
      canvas: '#101013',
    },
  },
  {
    id: 'gruvbox',
    label: 'Gruvbox',
    palette: {
      scheme: 'dark', bg: '#1d2021', panel: '#282828', panel2: '#32302f', line: '#45403d',
      text: '#ebdbb2', muted: '#928374', accent: '#fe8019', green: '#b8bb26', yellow: '#fabd2f', danger: '#fb4934',
      canvas: '#151718',
    },
  },
  {
    id: 'nord',
    label: 'Nord',
    palette: {
      scheme: 'dark', bg: '#242933', panel: '#2e3440', panel2: '#3b4252', line: '#434c5e',
      text: '#eceff4', muted: '#7b88a1', accent: '#88c0d0', green: '#a3be8c', yellow: '#ebcb8b', danger: '#bf616a',
      canvas: '#1f232b',
    },
  },
  {
    id: 'paper',
    label: 'Paper',
    palette: {
      scheme: 'light', bg: '#eceae4', panel: '#f7f6f2', panel2: '#e6e3dc', line: '#d3cfc6',
      text: '#2b2a27', muted: '#7a766d', accent: '#2f6fdf', green: '#3f8f3a', yellow: '#b7791f', danger: '#c8413a',
      canvas: '#d9d6ce',
    },
  },
];

export const EDITOR_FONTS: readonly EditorFont[] = [
  { id: 'krypton', label: 'Monaspace Krypton', stack: '"Monaspace Krypton", monospace' },
  { id: 'system-mono', label: 'System mono', stack: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' },
  { id: 'system-sans', label: 'System sans', stack: 'system-ui, -apple-system, "Segoe UI", sans-serif' },
  { id: 'inter', label: 'Inter', stack: 'Inter, system-ui, sans-serif' },
  { id: 'serif', label: 'Serif', stack: 'ui-serif, "New York", Georgia, serif' },
];

export const DEFAULT_EDITOR_THEME: EditorThemeChoice = { preset: 'tokyo-night', font: 'krypton' };

const STORAGE_KEY = 'deckwerk.editorTheme';

export function presetById(id: string): EditorThemePreset {
  return EDITOR_THEME_PRESETS.find((preset) => preset.id === id) ?? EDITOR_THEME_PRESETS[0]!;
}

export function fontById(id: string): EditorFont {
  return EDITOR_FONTS.find((font) => font.id === id) ?? EDITOR_FONTS[0]!;
}

export function loadEditorTheme(): EditorThemeChoice {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<EditorThemeChoice> | null;
    if (!parsed || typeof parsed !== 'object') return { ...DEFAULT_EDITOR_THEME };
    return {
      preset: typeof parsed.preset === 'string' ? parsed.preset : DEFAULT_EDITOR_THEME.preset,
      font: typeof parsed.font === 'string' ? parsed.font : DEFAULT_EDITOR_THEME.font,
      ...(typeof parsed.accent === 'string' ? { accent: parsed.accent } : {}),
    };
  } catch {
    return { ...DEFAULT_EDITOR_THEME };
  }
}

export function saveEditorTheme(choice: EditorThemeChoice): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(choice));
  } catch {
    // Storage can be unavailable; the theme still applies for this session.
  }
}

/** `#rrggbb` at the given alpha, for the translucent accent wash. */
function withAlpha(hex: string, alpha: number): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match) return hex;
  const n = parseInt(match[1]!, 16);
  return `rgb(${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255} / ${alpha * 100}%)`;
}

export function applyEditorTheme(choice: EditorThemeChoice, root: HTMLElement = document.documentElement): void {
  const palette = presetById(choice.preset).palette;
  const accent = choice.accent ?? palette.accent;
  const vars: Record<string, string> = {
    '--bg': palette.bg,
    '--panel': palette.panel,
    '--panel-2': palette.panel2,
    '--line': palette.line,
    '--text': palette.text,
    '--muted': palette.muted,
    '--accent': accent,
    '--accent-soft': withAlpha(accent, palette.scheme === 'light' ? 0.16 : 0.12),
    '--green': palette.green,
    '--yellow': palette.yellow,
    '--danger': palette.danger,
    '--canvas': palette.canvas,
    '--mono': fontById(choice.font).stack,
  };
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  root.style.colorScheme = palette.scheme;
  root.dataset['editorTheme'] = palette.scheme;
}

/** Apply the saved theme now and follow changes made in other windows. */
export function installEditorTheme(): void {
  applyEditorTheme(loadEditorTheme());
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY) applyEditorTheme(loadEditorTheme());
  });
}
