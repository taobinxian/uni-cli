import { describe, expect, it, vi } from 'vitest';
import type { Adapter } from '../adapters/base.js';
import { Store } from '../db.js';
import { EventBus } from '../event-bus.js';
import { SessionManager } from './session-manager.js';
import type { AdapterManager } from '../adapters/index.js';
import type { Session } from '../../shared/types.js';

describe('SessionManager', () => {
  it('blocks risky prompts and releases them after approval', async () => {
    const store = new Store(':memory:');
    const bus = new EventBus(store);
    const sent: string[] = [];
    const session: Session = {
      id: 'codex-test',
      appId: 'codex',
      title: 'test session',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      live: true
    };
    store.upsertSession(session);
    const adapter = {
      appId: 'codex',
      label: 'Codex',
      color: '#0d8a72',
      defaultModel: 'test',
      detect: vi.fn(),
      listSessions: vi.fn(),
      startSession: vi.fn(),
      resumeSession: vi.fn(),
      sendPrompt: vi.fn(async (_session: Session, prompt: string) => sent.push(prompt)),
      stopSession: vi.fn(),
      parseHistoricalLogs: vi.fn(),
      getTokenUsage: vi.fn()
    } as unknown as Adapter;
    const adapters = { get: () => adapter, all: () => [adapter] } as unknown as AdapterManager;
    const manager = new SessionManager(store, adapters, bus);

    const result = await manager.sendPrompt('codex-test', '请执行命令 rm -rf tmp');
    expect(result.confirmation?.status).toBe('pending');
    expect(sent).toEqual([]);
    await manager.resolveConfirmation(result.confirmation!.id, 'approved');
    expect(sent).toEqual(['请执行命令 rm -rf tmp']);
  });

  it('blocks risky prompts provided while creating a new session before launching the prompt', async () => {
    const store = new Store(':memory:');
    const bus = new EventBus(store);
    let launchedPrompt: string | undefined;
    const adapter = {
      appId: 'codex',
      label: 'Codex',
      color: '#0d8a72',
      defaultModel: 'test',
      detect: vi.fn(),
      listSessions: vi.fn(),
      startSession: vi.fn(async (input, sessionId: string) => {
        launchedPrompt = input.prompt;
        return {
          id: sessionId,
          appId: 'codex',
          title: 'started session',
          status: 'running',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          live: true
        } satisfies Session;
      }),
      resumeSession: vi.fn(),
      sendPrompt: vi.fn(),
      stopSession: vi.fn(),
      parseHistoricalLogs: vi.fn(),
      getTokenUsage: vi.fn()
    } as unknown as Adapter;
    const adapters = { get: () => adapter, all: () => [adapter] } as unknown as AdapterManager;
    const manager = new SessionManager(store, adapters, bus);

    const session = await manager.start({ appId: 'codex', prompt: '请执行命令 rm -rf tmp' });

    expect(session.appId).toBe('codex');
    expect(launchedPrompt).toBeUndefined();
    expect(store.listConfirmations()).toHaveLength(1);
    expect(store.listConfirmations()[0].status).toBe('pending');
  });
});
