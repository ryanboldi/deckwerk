// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { showNewPresentationDialog } from '../src/renderer/editor/newPresentationDialog.js';

const servers = [
  { id: 'rybox', name: 'RyBox', url: 'https://rybox.test:9450' },
  { id: 'lab', name: 'Lab', url: 'https://lab.test:9450' },
];
const form = () => document.querySelector<HTMLFormElement>('.new-presentation-dialog')!;
const location = () => form().querySelector<HTMLSelectElement>('select')!;
const name = () => form().querySelector<HTMLInputElement>('input')!;
const submit = () => form().querySelector<HTMLButtonElement>('[type=submit]')!;
const select = (id: string) => {
  location().value = id;
  location().dispatchEvent(new Event('change'));
};
const type = (value: string) => {
  name().value = value;
  name().dispatchEvent(new Event('input'));
};
afterEach(() => document.body.replaceChildren());

describe('new presentation location', () => {
  it('defaults to the open server, requires a name, and submits the selected server', async () => {
    const choice = showNewPresentationDialog(servers, 'rybox');
    expect(location().value).toBe('rybox');
    expect(document.activeElement).toBe(name());
    expect(submit().disabled).toBe(true);
    type('   ');
    expect(submit().disabled).toBe(true);
    type('  Research talk  ');
    submit().click();
    expect(await choice).toEqual({ kind: 'remote', server: servers[0], name: 'Research talk' });
    expect(document.querySelector('.workflow-overlay')).toBeNull();
  });

  it('hands a local choice to the native folder picker without requiring a name', async () => {
    const choice = showNewPresentationDialog(servers, 'forgotten-server');
    expect(location().value).toBe('');
    expect(name().disabled).toBe(true);
    expect(name().parentElement!.hidden).toBe(true);
    expect(submit().disabled).toBe(false);
    submit().click();
    expect(await choice).toEqual({ kind: 'local' });
  });

  it('cancels with Escape, restores focus, and keeps keys out of the slide editor', async () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const choice = showNewPresentationDialog(servers, 'rybox');
    let leaked = false;
    const listener = () => { leaked = true; };
    document.addEventListener('keydown', listener);
    name().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    document.removeEventListener('keydown', listener);
    expect(await choice).toBeNull();
    expect(leaked).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  // Seeded source/name switching guards against a stale destination after a
  // person changes their mind several times before creating the deck.
  it.each([1, 7, 42])('keeps the destination and draft name consistent through seed %s', async (seed) => {
    const choice = showNewPresentationDialog(servers);
    let value = '';
    let destination = '';
    let state = seed;
    for (let step = 0; step < 24; step++) {
      state = (state * 16807) % 2147483647;
      if (state % 2 === 0) {
        destination = ['', 'rybox', 'lab'][state % 3];
        select(destination);
      } else {
        value = state % 3 === 0 ? ' ' : `Talk ${step}`;
        type(value);
      }
      expect(name().value).toBe(value);
      expect(name().disabled).toBe(!destination);
      expect(submit().disabled).toBe(Boolean(destination) && !value.trim());
    }
    type('Final talk');
    submit().click();
    expect(await choice).toEqual(destination
      ? { kind: 'remote', server: servers.find((server) => server.id === destination), name: 'Final talk' }
      : { kind: 'local' });
  });
});
