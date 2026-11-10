import { describe, expect, it } from 'vitest';
import { remoteT3Link } from '../src/main/t3Launcher.js';

const workspace = { server: 'https://lab.ts.net:9450', deckId: 'Talk with spaces', environmentId: 'environment-1', threadId: 'thread-2' };
describe('T3 deck workspace links', () => {
  it('opens the configured remote thread for the exact server and deck', () => {
    expect(remoteT3Link([workspace], workspace.server, workspace.deckId)).toBe('t3code://threads/environment-1/thread-2');
  });
  it('never sends a different deck or server to the wrong agent', () => {
    expect(() => remoteT3Link([workspace], workspace.server, 'other')).toThrow('No remote T3 workspace');
    expect(() => remoteT3Link([workspace], 'https://other.ts.net', workspace.deckId)).toThrow('No remote T3 workspace');
  });
  it('rejects identifiers that can change the link target or inject a query', () => {
    for (const environmentId of ['../../new', 'one?prompt=edit', '']) {
      expect(() => remoteT3Link([{ ...workspace, environmentId }], workspace.server, workspace.deckId)).toThrow('invalid identifier');
    }
  });
});
