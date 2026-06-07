import { APP_ORDER, type AppId, type TimeScope, type TokenUsage } from './types.js';

export function aggregateTokenUsage(
  rows: Array<{ appId: AppId; inputTokens: number; outputTokens: number }>,
  scope: TimeScope
): TokenUsage[] {
  const empty = Object.fromEntries(
    APP_ORDER.map((appId) => [appId, { appId, scope, inputTokens: 0, outputTokens: 0, totalTokens: 0 }])
  ) as Record<AppId, TokenUsage>;

  for (const row of rows) {
    const target = empty[row.appId];
    target.inputTokens += safe(row.inputTokens);
    target.outputTokens += safe(row.outputTokens);
    target.totalTokens = target.inputTokens + target.outputTokens;
  }

  return Object.values(empty);
}

export function scopeStart(now: Date, scope: TimeScope): Date {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (scope === 'week') {
    const day = start.getDay() || 7;
    start.setDate(start.getDate() - day + 1);
  }
  if (scope === 'month') {
    start.setDate(1);
  }
  return start;
}

function safe(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}
