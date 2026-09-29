import {
  applyEditorTheme,
  DEFAULT_EDITOR_THEME,
  EDITOR_FONTS,
  EDITOR_THEME_PRESETS,
  type EditorThemeChoice,
  loadEditorTheme,
  presetById,
  saveEditorTheme,
} from '../editorTheme.js';

const DIALOG_ID = 'deckwerk-editor-appearance';

/**
 * Editor appearance: pick the chrome's palette, font and accent. Every change
 * previews live; Cancel restores what was there when the dialog opened.
 */
export function showEditorThemeDialog(): void {
  if (document.getElementById(DIALOG_ID)) return;

  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const original = loadEditorTheme();
  let draft: EditorThemeChoice = { ...original };

  const overlay = document.createElement('div');
  overlay.id = DIALOG_ID;
  overlay.className = 'workflow-overlay';

  const dialog = document.createElement('section');
  dialog.className = 'workflow-dialog editor-theme-dialog';
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'editor-theme-title');

  const title = document.createElement('h2');
  title.id = 'editor-theme-title';
  title.textContent = 'Editor appearance';
  const hint = document.createElement('p');
  hint.className = 'editor-theme-hint';
  hint.textContent = 'Styles DeckWerk itself. Your slides keep their deck theme.';

  const presets = document.createElement('div');
  presets.className = 'editor-theme-presets';
  presets.setAttribute('role', 'radiogroup');
  presets.setAttribute('aria-label', 'Palette');

  const fontSelect = document.createElement('select');
  fontSelect.className = 'bar-select';
  for (const font of EDITOR_FONTS) {
    const option = document.createElement('option');
    option.value = font.id;
    option.textContent = font.label;
    option.style.fontFamily = font.stack;
    fontSelect.appendChild(option);
  }

  const accentInput = document.createElement('input');
  accentInput.type = 'color';
  accentInput.className = 'editor-theme-accent';
  const accentReset = document.createElement('button');
  accentReset.type = 'button';
  accentReset.textContent = 'Preset accent';

  const render = (): void => {
    applyEditorTheme(draft);
    for (const card of presets.querySelectorAll<HTMLButtonElement>('.editor-theme-card')) {
      card.setAttribute('aria-checked', String(card.dataset['preset'] === draft.preset));
    }
    fontSelect.value = draft.font;
    accentInput.value = draft.accent ?? presetById(draft.preset).palette.accent;
    accentReset.disabled = draft.accent === undefined;
  };

  for (const preset of EDITOR_THEME_PRESETS) {
    const p = preset.palette;
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'editor-theme-card';
    card.dataset['preset'] = preset.id;
    card.setAttribute('role', 'radio');
    // The swatch paints the preset in its own colors, whatever is active now.
    const swatch = document.createElement('span');
    swatch.className = 'editor-theme-swatch';
    swatch.style.background = p.bg;
    swatch.style.borderColor = p.line;
    const bar = document.createElement('span');
    bar.style.background = p.panel;
    bar.style.borderBottom = `1px solid ${p.line}`;
    const line1 = document.createElement('span');
    line1.style.background = p.text;
    const line2 = document.createElement('span');
    line2.style.background = p.muted;
    const dot = document.createElement('span');
    dot.style.background = p.accent;
    swatch.append(bar, line1, line2, dot);
    const label = document.createElement('span');
    label.className = 'editor-theme-card-label';
    label.textContent = preset.label;
    card.append(swatch, label);
    card.addEventListener('click', () => {
      draft = { ...draft, preset: preset.id };
      delete draft.accent;
      render();
    });
    presets.appendChild(card);
  }

  fontSelect.addEventListener('change', () => {
    draft = { ...draft, font: fontSelect.value };
    render();
  });
  accentInput.addEventListener('input', () => {
    draft = { ...draft, accent: accentInput.value };
    render();
  });
  accentReset.addEventListener('click', () => {
    draft = { ...draft };
    delete draft.accent;
    render();
  });

  const row = (labelText: string, ...controls: HTMLElement[]): HTMLElement => {
    const wrap = document.createElement('label');
    wrap.className = 'editor-theme-row';
    const text = document.createElement('span');
    text.textContent = labelText;
    wrap.append(text, ...controls);
    return wrap;
  };

  const actions = document.createElement('div');
  actions.className = 'workflow-actions';
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.textContent = 'Default';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  const done = document.createElement('button');
  done.type = 'button';
  done.className = 'primary';
  done.textContent = 'Done';
  actions.append(reset, cancel, done);

  let finished = false;
  const close = (commit: boolean): void => {
    if (finished) return;
    finished = true;
    if (commit) saveEditorTheme(draft);
    else applyEditorTheme(original);
    overlay.remove();
    previousFocus?.focus();
  };
  reset.addEventListener('click', () => {
    draft = { ...DEFAULT_EDITOR_THEME };
    render();
  });
  cancel.addEventListener('click', () => close(false));
  done.addEventListener('click', () => close(true));
  overlay.addEventListener('pointerdown', (event) => {
    if (event.target === overlay) close(false);
  });
  overlay.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      close(false);
    }
  });

  dialog.append(title, hint, presets, row('Font', fontSelect), row('Accent', accentInput, accentReset), actions);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  render();
  done.focus();
}
