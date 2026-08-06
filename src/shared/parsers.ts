import type { AppId, Session } from './types.js';

export interface UsageExtractionOptions {
  canonicalUsageTotals?: boolean;
}

export function parseJsonLine(line: string): unknown | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

export function extractUsage(value: unknown, options: UsageExtractionOptions = {}): { inputTokens: number; outputTokens: number } {
  const seen = new Set<unknown>();
  const result = { inputTokens: 0, outputTokens: 0 };

  function visit(node: unknown): void {
    if (!node || typeof node !== 'object' || seen.has(node)) return;
    seen.add(node);
    const record = node as Record<string, unknown>;
    if (options.canonicalUsageTotals) {
      const direct = directTokenUsage(record);
      if (direct) {
        result.inputTokens += direct.inputTokens;
        result.outputTokens += direct.outputTokens;
        return;
      }
    }
    for (const [key, raw] of Object.entries(record)) {
      if (typeof raw === 'number') {
        const normalized = key.toLowerCase();
        if (isTokenKey(normalized, 'input', options)) result.inputTokens += safeToken(raw);
        if (isTokenKey(normalized, 'output', options)) result.outputTokens += safeToken(raw);
      }
      if (raw && typeof raw === 'object') visit(raw);
    }
  }

  visit(value);
  return result;
}

export function extractUsageFromText(text: string, options: UsageExtractionOptions = {}): { inputTokens: number; outputTokens: number } {
  const result = { inputTokens: 0, outputTokens: 0 };
  const fallbackLines: string[] = [];
  for (const line of text.split('\n')) {
    const parsed = parseJsonLine(line);
    if (parsed) {
      const usage = extractUsage(parsed, options);
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

function directTokenUsage(record: Record<string, unknown>): { inputTokens: number; outputTokens: number } | undefined {
  const inputTokens = firstNumber(record, ['input_tokens', 'inputTokens', 'prompt_tokens', 'promptTokens']);
  const outputTokens = firstNumber(record, ['output_tokens', 'outputTokens', 'completion_tokens', 'completionTokens']);
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return {
    inputTokens: safeToken(inputTokens ?? 0),
    outputTokens: safeToken(outputTokens ?? 0)
  };
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number') return value;
  }
  return undefined;
}

function isTokenKey(normalizedKey: string, direction: 'input' | 'output', options: UsageExtractionOptions): boolean {
  if (!normalizedKey.includes(direction) || !normalizedKey.includes('token')) return false;
  return !options.canonicalUsageTotals || !/(?:cached?|cache|reasoning)/.test(normalizedKey);
}

function safeToken(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}
