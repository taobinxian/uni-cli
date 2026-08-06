import { describe, expect, it } from 'vitest';
import type { Session } from '../../shared/types.js';
import { Store } from '../db.js';
import { TokenAggregator } from './token-aggregator.js';

describe('TokenAggregator', () => {
  it('aggregates session tokens by day, week, and month', () => {
    const store = new Store(':memory:');
    const aggregator = new TokenAggregator(store);
    const now = new Date('2026-06-06T12:00:00Z');
    store.upsertSession(session('codex-today', 'codex', '2026-06-06T10:00:00Z', 10, 5));
    store.upsertSession(session('claude-week', 'claude', '2026-06-03T10:00:00Z', 20, 6));
    store.upsertSession(session('ag-month', 'antigravity', '2026-06-01T10:00:00Z', 30, 7));
    store.upsertSession(session('codex-old', 'codex', '2026-05-30T10:00:00Z', 100, 100));

    aggregator.refresh(now);

    expect(store.listTokenUsage('day').find((row) => row.appId === 'codex')?.totalTokens).toBe(15);
    expect(store.listTokenUsage('week').find((row) => row.appId === 'claude')?.totalTokens).toBe(26);
    expect(store.listTokenUsage('month').find((row) => row.appId === 'antigravity')?.totalTokens).toBe(37);
    expect(store.listTokenUsage('month').find((row) => row.appId === 'codex')?.totalTokens).toBe(15);
  });

  it('aggregates all scope across every stored session instead of reusing the largest visible time window', () => {
    const store = new Store(':memory:');
    const aggregator = new TokenAggregator(store);
    const now = new Date('2026-06-06T12:00:00Z');
    store.upsertSession(session('codex-today', 'codex', '2026-06-06T10:00:00Z', 10, 5));
    store.upsertSession(session('codex-old', 'codex', '2026-05-30T10:00:00Z', 100, 100));

    aggregator.refresh(now);

    expect(store.listTokenUsage('all' as never).find((row) => row.appId === 'codex')?.totalTokens).toBe(215);
  });

  it('serves all scope without building a time-bucket series', () => {
    const store = new Store(':memory:');
    const aggregator = new TokenAggregator(store);
    store.upsertSession(session('codex-a', 'codex', '2026-01-01T10:00:00Z', 20, 5));
    store.upsertSession(session('codex-b', 'codex', '2026-06-06T10:00:00Z', 30, 7));

    const result = aggregator.get('all' as never);

    expect(result.usage.find((row) => row.appId === 'codex')?.totalTokens).toBe(62);
    expect(result.series).toEqual([]);
  });
});

function session(id: string, appId: Session['appId'], updatedAt: string, inputTokens: number, outputTokens: number): Session {
  return {
    id,
    appId,
    title: id,
    status: 'completed',
    createdAt: updatedAt,
    updatedAt,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    live: false
  };
}
