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

  it('keeps generic cache input tokens for non-Codex usage records', () => {
    expect(
      extractUsage({
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 4,
          cache_read_input_tokens: 3,
          output_tokens: 2
        }
      })
    ).toEqual({ inputTokens: 17, outputTokens: 2 });
  });

  it('extracts token usage from terminal output', () => {
    expect(extractUsageFromText('{"usage":{"input_tokens":12,"output_tokens":8}}\ninput tokens: 5')).toEqual({
      inputTokens: 17,
      outputTokens: 8
    });
  });

  it('extracts Codex turn totals without double-counting cached or reasoning subtotals', () => {
    expect(
      extractUsageFromText(
        JSON.stringify({
          type: 'turn.completed',
          usage: {
            input_tokens: 100,
            cached_input_tokens: 80,
            output_tokens: 20,
            reasoning_output_tokens: 5,
            total_tokens: 120
          }
        }),
        { canonicalUsageTotals: true }
      )
    ).toEqual({ inputTokens: 100, outputTokens: 20 });
  });
});
