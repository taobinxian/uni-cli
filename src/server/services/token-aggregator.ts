import { APP_ORDER, type AppId, type Session, type TimeScope, type TokenUsage, type UsagePoint } from '../../shared/types.js';
import { aggregateTokenUsage, scopeStart, type WindowTimeScope } from '../../shared/token.js';
import { Store } from '../db.js';

const WINDOW_SCOPES: WindowTimeScope[] = ['day', 'week', 'month'];
const TOKEN_SCOPES: TimeScope[] = [...WINDOW_SCOPES, 'all'];

export class TokenAggregator {
  private store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  refresh(reference = new Date()): void {
    const rows = TOKEN_SCOPES.flatMap((scope) => {
      const sessions = this.sessionsInScope(scope, reference);
      return aggregateTokenUsage(
        sessions.map((session) => ({
          appId: session.appId,
          inputTokens: session.inputTokens,
          outputTokens: session.outputTokens
        })),
        scope
      );
    });
    this.store.replaceTokenUsage(rows);
  }

  get(scope: TimeScope): { usage: TokenUsage[]; series: UsagePoint[] } {
    const reference = new Date();
    this.refresh(reference);
    return { usage: this.store.listTokenUsage(scope), series: scope === 'all' ? [] : this.makeSeries(scope, reference) };
  }

  private sessionsInScope(scope: TimeScope, reference: Date): Session[] {
    if (scope === 'all') return this.store.listSessionsForTokenUsage();
    return this.store.listSessionsForTokenUsage(scopeStart(reference, scope).toISOString());
  }

  private makeSeries(scope: WindowTimeScope, reference: Date): UsagePoint[] {
    const start = scopeStart(reference, scope);
    const sessions = this.sessionsInScope(scope, reference);
    return bucketsFor(scope, start, reference).map((bucket) => pointFor(bucket.label, sessions, bucket.end));
  }
}

function bucketsFor(scope: WindowTimeScope, start: Date, reference: Date): Array<{ label: string; end: Date }> {
  if (scope === 'day') {
    return [0, 6, 12, 18]
      .map((hour) => {
        const end = new Date(start);
        end.setHours(hour, 0, 0, 0);
        return { label: `${String(hour).padStart(2, '0')}:00`, end: clamp(end, reference) };
      })
      .concat([{ label: '现在', end: reference }]);
  }

  if (scope === 'week') {
    const labels = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
    const dayCount = Math.max(1, Math.min(7, (reference.getDay() || 7)));
    return labels.slice(0, dayCount).map((label, index) => {
      const end = new Date(start);
      end.setDate(start.getDate() + index);
      end.setHours(23, 59, 59, 999);
      return { label: index === dayCount - 1 ? '今天' : label, end: clamp(end, reference) };
    });
  }

  const buckets: Array<{ label: string; end: Date }> = [];
  const cursor = new Date(start);
  let index = 1;
  while (cursor <= reference) {
    const end = new Date(cursor);
    end.setDate(cursor.getDate() + 6);
    end.setHours(23, 59, 59, 999);
    buckets.push({ label: end >= reference ? '本周' : `第 ${index} 周`, end: clamp(end, reference) });
    cursor.setDate(cursor.getDate() + 7);
    index += 1;
  }
  return buckets.length ? buckets : [{ label: '本周', end: reference }];
}

function pointFor(label: string, sessions: Session[], end: Date): UsagePoint {
  const totals = Object.fromEntries(APP_ORDER.map((appId) => [appId, 0])) as Record<AppId, number>;
  for (const session of sessions) {
    if (Date.parse(session.updatedAt) <= end.getTime()) totals[session.appId] += session.totalTokens;
  }
  return { label, ...totals };
}

function clamp(date: Date, max: Date): Date {
  return date.getTime() > max.getTime() ? max : date;
}

export function appOrder(): AppId[] {
  return [...APP_ORDER];
}
