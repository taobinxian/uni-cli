import { describe, expect, it } from 'vitest';
import { formatTokenCount } from './format.js';

describe('formatTokenCount', () => {
  it('formats token counts without percentages', () => {
    expect(formatTokenCount(1_310_000)).toBe('1.31M');
    expect(formatTokenCount(980_000)).toBe('980K');
    expect(formatTokenCount(550)).toBe('550');
  });
});
