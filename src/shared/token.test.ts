import { describe, expect, it } from 'vitest';
import { aggregateTokenUsage, scopeStart } from './token.js';

describe('token aggregation', () => {
  it('aggregates input and output tokens by app', () => {
    const rows = aggregateTokenUsage(
      [
        { appId: 'codex', inputTokens: 10, outputTokens: 3 },
        { appId: 'codex', inputTokens: 2, outputTokens: 1 },
        { appId: 'claude', inputTokens: 5, outputTokens: 5 }
      ],
      'day'
    );
    expect(rows.find((row) => row.appId === 'codex')?.totalTokens).toBe(16);
    expect(rows.find((row) => row.appId === 'claude')?.totalTokens).toBe(10);
    expect(rows.find((row) => row.appId === 'antigravity')?.totalTokens).toBe(0);
  });

  it('calculates week and month starts', () => {
    expect(scopeStart(new Date('2026-06-06T12:00:00Z'), 'week').getDay()).toBe(1);
    expect(scopeStart(new Date('2026-06-06T12:00:00Z'), 'month').getDate()).toBe(1);
  });
});
