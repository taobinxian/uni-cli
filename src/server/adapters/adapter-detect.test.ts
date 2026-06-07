import { describe, expect, it, vi } from 'vitest';
import { AntigravityAdapter } from './antigravity.js';
import type { LauncherService } from '../launcher-service.js';

const launcher = {
  has: () => false,
  launch: vi.fn(),
  write: vi.fn(),
  stop: vi.fn()
} as unknown as LauncherService;

describe('AntigravityAdapter', () => {
  it('reports missing when the configured command does not exist', async () => {
    vi.stubEnv('ANTIGRAVITY_CMD', '/definitely/missing/agy');
    const adapter = new AntigravityAdapter({ launcher });
    await expect(adapter.detect()).resolves.toMatchObject({ appId: 'antigravity', status: 'missing' });
    vi.unstubAllEnvs();
  });
});
