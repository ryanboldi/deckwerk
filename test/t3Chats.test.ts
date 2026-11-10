import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { T3Chats } from '../src/server/t3Chats.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'deckwerk-chats-')); roots.push(dir);
  const existing: Record<string, string> = {};
  const rpc = vi.fn(async (method: string, payload: any): Promise<any> => {
    if (method === 'server.getConfig') return { environment: { environmentId: 'rybox' }, settings: { defaultModelSelection: { instanceId: 'model-provider', model: 'default-model' }, defaultRuntimeMode: 'approval-required' } };
    if (method === 'orchestration.getThreadTitles') return existing;
    if (method === 'projects.ensureScratch') return { projectId: 'scratch' };
    if (method === 'orchestration.launchThread') { existing[payload.threadId] = payload.title; return { threadId: payload.threadId }; }
    throw new Error(method);
  });
  const connect = async <T>(work: (rpc: any) => Promise<T>) => work(rpc);
  return { dir, rpc, connect, chats: new T3Chats(dir, connect) };
}
it('reuses a No project chat after repeated clicks and server restarts without running an agent', async () => {
  const { dir, rpc, connect, chats } = await fixture();
  const [a, b] = await Promise.all([chats.open('/presentations/Base'), chats.open('/presentations/Base')]);
  const c = await new T3Chats(dir, connect).open('/presentations/Base');
  expect(a).toEqual(b); expect(a).toEqual(c);
  const launches = rpc.mock.calls.filter(([method]) => method === 'orchestration.launchThread').map(([,payload]) => payload);
  expect(launches).toHaveLength(1);
  for (const launch of launches) {
    expect(launch.threadId).toBe(a.threadId);
    expect(launch.projectId).toBe('scratch');
    expect(launch).not.toHaveProperty('reuseExistingThread');
    expect(launch).not.toHaveProperty('initialMessage');
    expect(launch.workspaceStrategy).toEqual({ type: 'root' });
  }
  expect(a.context).toContain('/presentations/Base');
  expect(rpc.mock.calls.some(([method]) => method === 'projects.createNew')).toBe(false);
});
it('a seeded walk of base decks and forks keeps separate stable conversations', async () => {
  const { dir, connect } = await fixture();
  const seen = new Map<string, string>(); let seed = 0x41b32;
  for (let i = 0; i < 30; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const deck = `/presentations/${['VPO-Base','VPO-Jane Street','VPO-Base/fork', 'Talk & figures'][seed % 4]}`;
    const chat = await new T3Chats(dir, connect).open(deck);
    if (seen.has(deck)) expect(chat.threadId).toBe(seen.get(deck));
    else { expect([...seen.values()]).not.toContain(chat.threadId); seen.set(deck, chat.threadId); }
    expect(chat.context).toContain(JSON.stringify(deck));
  }
  expect(seen.size).toBe(4);
});
it('retries the same thread id after an uncertain launch failure', async () => {
  const { rpc, chats } = await fixture();
  const normal = rpc.getMockImplementation()!;
  rpc.mockImplementation(async (method, payload) => {
    if (method === 'orchestration.launchThread') throw new Error('disconnected');
    return normal(method, payload);
  });
  await expect(chats.open('/presentations/Base')).rejects.toThrow('disconnected');
  const failed = rpc.mock.calls.find(([method]) => method === 'orchestration.launchThread')![1];
  rpc.mockImplementation(normal);
  expect((await chats.open('/presentations/Base')).threadId).toBe(failed.threadId);
});
