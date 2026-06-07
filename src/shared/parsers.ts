import type { AppId, Session } from './types.js';

export function parseJsonLine(line: string): unknown | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

export function extractUsage(value: unknown): { inputTokens: number; outputTokens: number } {
  const seen = new Set<unknown>();
  const result = { inputTokens: 0, outputTokens: 0 };

  function visit(node: unknown): void {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    const record = node as Record<string, unknown>;
    for (const [key, raw] of Object.entries(record)) {
      if (typeof raw === 'number') {
        const normalized = key.toLowerCase();
        if (normalized.includes('input') && normalized.includes('token')) result.inputTokens += raw;
        if (normalized.includes('output') && normalized.includes('token')) result.outputTokens += raw;
      }
      if (raw && typeof raw === 'object') visit(raw);
    }
  }

  visit(value);
  return result;
}

export function extractUsageFromText(text: string): { inputTokens: number; outputTokens: number } {
  const result = { inputTokens: 0, outputTokens: 0 };
  const fallbackLines: string[] = [];
  for (const line of text.split('\n')) {
    const parsed = parseJsonLine(line);
    if (parsed) {
      const usage = extractUsage(parsed);
      result.inputTokens += usage.inputTokens;
      result.outputTokens += usage.outputTokens;
    } else {
      fallbackLines.push(line);
    }
  }

  const fallbackText = fallbackLines.join('\n');
  result.inputTokens += sumMatches(fallbackText, [
    /\binput[_\s-]*tokens?\b["'\s:=]+(\d+)/gi,
    /\bprompt[_\s-]*tokens?\b["'\s:=]+(\d+)/gi
  ]);
  result.outputTokens += sumMatches(fallbackText, [
    /\boutput[_\s-]*tokens?\b["'\s:=]+(\d+)/gi,
    /\bcompletion[_\s-]*tokens?\b["'\s:=]+(\d+)/gi
  ]);

  const totalOnly = sumMatches(fallbackText, [/\btotal[_\s-]*tokens?\b["'\s:=]+(\d+)/gi]);
  if (totalOnly > 0 && result.inputTokens + result.outputTokens === 0) {
    result.inputTokens = totalOnly;
  }

  return result;
}

export function sessionFromFile(appId: AppId, id: string, title: string, mtime: Date, usage = { inputTokens: 0, outputTokens: 0 }): Session {
  return {
    id,
    appId,
    nativeId: id,
    title,
    status: 'completed',
    createdAt: mtime.toISOString(),
    updatedAt: mtime.toISOString(),
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.inputTokens + usage.outputTokens,
    live: false
  };
}

function sumMatches(text: string, patterns: RegExp[]): number {
  let total = 0;
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      total += Number(match[1] ?? 0);
    }
  }
  return total;
}
