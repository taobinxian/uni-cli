import { describe, expect, it } from 'vitest';
import { extractUsage, extractUsageFromText, parseJsonLine } from './parsers.js';

describe('parsers', () => {
  it('parses jsonl safely', () => {
    expect(parseJsonLine('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonLine('{bad')).toBeUndefined();
  });

  it('extracts nested token usage', () => {
    expect(extractUsage({ usage: { input_tokens: 12, output_tokens: 8 } })).toEqual({ inputTokens: 12, outputTokens: 8 });
  });

  it('extracts token usage from terminal output', () => {
    expect(extractUsageFromText('{"usage":{"input_tokens":12,"output_tokens":8}}\ninput tokens: 5')).toEqual({
      inputTokens: 17,
      outputTokens: 8
    });
  });
});
