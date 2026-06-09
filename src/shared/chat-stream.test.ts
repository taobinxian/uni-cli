import { describe, expect, it } from 'vitest';
import {
  cleanInlineText,
  buildChatEnvelope,
  parseChatEnvelope,
  splitTextByGraphemes,
  isChatEnvelopeJson
} from './chat-stream.js';

describe('cleanInlineText', () => {
  it('strips ANSI CSI color sequences', () => {
    expect(cleanInlineText('[31mhello[0m')).toBe('hello');
  });

  it('strips OSC sequences terminated by BEL', () => {
    expect(cleanInlineText(']0;tab titlehello')).toBe('hello');
  });

  it('strips OSC sequences terminated by ST', () => {
    expect(cleanInlineText(']0;tab title\\hello')).toBe('hello');
  });

  it('strips two-char ESC charset designations', () => {
    expect(cleanInlineText('(Bhello')).toBe('hello');
  });

  it('drops Unicode replacement characters', () => {
    expect(cleanInlineText('hi �� world')).toBe('hi world');
  });

  it('drops control characters except newline/tab', () => {
    expect(cleanInlineText('abc')).toBe('a b c');
  });

  it('preserves CJK characters', () => {
    expect(cleanInlineText('你好 世界')).toBe('你好 世界');
  });

  it('preserves emoji ZWJ sequences', () => {
    expect(cleanInlineText('hi 👨‍👩‍👧 family')).toBe('hi 👨‍👩‍👧 family');
  });

  it('collapses whitespace within a line', () => {
    expect(cleanInlineText('a    b\tc')).toBe('a b c');
  });

  it('normalises CR to LF and drops empty trailing lines', () => {
    expect(cleanInlineText('a\r\nb\r\n\r\n')).toBe('a\nb');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(cleanInlineText('   \r\n   ')).toBe('');
  });
});

describe('buildChatEnvelope', () => {
  it('emits canonical history.message json', () => {
    const json = buildChatEnvelope({ role: 'assistant', text: 'hi', messageId: 'msg-1', live: true });
    expect(JSON.parse(json)).toEqual({
      type: 'history.message',
      role: 'assistant',
      text: 'hi',
      messageId: 'msg-1',
      live: true
    });
  });

  it('omits optional fields when absent', () => {
    const json = buildChatEnvelope({ role: 'user', text: 'q' });
    expect(JSON.parse(json)).toEqual({ type: 'history.message', role: 'user', text: 'q' });
  });

  it('includes chunk metadata when provided', () => {
    const json = buildChatEnvelope({
      role: 'assistant',
      text: 'world',
      messageId: 'm1',
      live: true,
      chunkIndex: 2,
      chunkCount: 3
    });
    expect(JSON.parse(json)).toMatchObject({ chunkIndex: 2, chunkCount: 3 });
  });
});

describe('parseChatEnvelope', () => {
  it('returns undefined for non-JSON text', () => {
    expect(parseChatEnvelope('hello world')).toBeUndefined();
  });

  it('returns undefined for unrelated JSON types', () => {
    expect(parseChatEnvelope(JSON.stringify({ type: 'token.updated', text: 'x' }))).toBeUndefined();
  });

  it('returns role/text/live for valid envelopes', () => {
    const json = JSON.stringify({ type: 'history.message', role: 'assistant', text: 'hi', live: true });
    expect(parseChatEnvelope(json)).toMatchObject({ role: 'assistant', text: 'hi', live: true });
  });

  it('tolerates surrounding whitespace and trailing newline', () => {
    const json = `  ${JSON.stringify({ type: 'history.message', role: 'user', text: 'q' })}  \n`;
    expect(parseChatEnvelope(json)).toMatchObject({ role: 'user', text: 'q' });
  });
});

describe('isChatEnvelopeJson', () => {
  it('returns true for envelope text', () => {
    expect(isChatEnvelopeJson(JSON.stringify({ type: 'history.message', role: 'user', text: 'hi' }))).toBe(true);
  });

  it('returns false for non-JSON strings', () => {
    expect(isChatEnvelopeJson('hi')).toBe(false);
  });

  it('returns false for non-history JSON', () => {
    expect(isChatEnvelopeJson(JSON.stringify({ type: 'other' }))).toBe(false);
  });
});

describe('splitTextByGraphemes', () => {
  it('splits ASCII into fixed-size chunks', () => {
    expect(splitTextByGraphemes('abcdef', 2)).toEqual(['ab', 'cd', 'ef']);
  });

  it('keeps CJK characters as single graphemes', () => {
    expect(splitTextByGraphemes('你好世界', 1)).toEqual(['你', '好', '世', '界']);
  });

  it('keeps ZWJ emoji as a single grapheme', () => {
    const [first, second] = splitTextByGraphemes('👨‍👩‍👧X', 1);
    expect(first).toBe('👨‍👩‍👧');
    expect(second).toBe('X');
  });

  it('keeps regional flag emoji as a single grapheme', () => {
    expect(splitTextByGraphemes('🇨🇳hi', 1)).toEqual(['🇨🇳', 'h', 'i']);
  });

  it('returns the original text as a single chunk when shorter than size', () => {
    expect(splitTextByGraphemes('hi', 10)).toEqual(['hi']);
  });

  it('throws on non-positive size', () => {
    expect(() => splitTextByGraphemes('a', 0)).toThrow(/size/);
    expect(() => splitTextByGraphemes('a', -1)).toThrow(/size/);
  });

  it('returns empty array for empty input', () => {
    expect(splitTextByGraphemes('', 5)).toEqual([]);
  });
});
