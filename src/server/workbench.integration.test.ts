import { access, chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildServer } from './index.js';
import type { AppId, AppInfo, DeleteSessionResult, EventRecord, Session, Task, TerminalFrame } from '../shared/types.js';

describe('workbench fake CLI integration', () => {
  let tempDir = '';
  let server: Awaited<ReturnType<typeof buildServer>> | undefined;
  let baseUrl = '';
  let codexHistoryId = '';
  let codexHistoryFile = '';

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'workbench-test-'));
    const home = join(tempDir, 'home');
    await mkdir(home, { recursive: true });
    const fakeCli = join(tempDir, 'fake-cli.js');
    await writeFile(
      fakeCli,
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ usage: { input_tokens: 2, output_tokens: 1 } }) + "\\n");
const args = process.argv.slice(2).join(" ");
if (args) process.stdout.write("fake-args:" + args + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  const text = chunk.trim();
  if (!text) return;
  process.stdout.write("fake-received:" + text + "\\n");
  process.stdout.write(JSON.stringify({ usage: { input_tokens: 7, output_tokens: 3 } }) + "\\n");
});
process.on("SIGTERM", () => {
  process.stdout.write("fake-stopped\\n");
  process.exit(0);
});
setInterval(() => {}, 500);
`
    );
    await chmod(fakeCli, 0o755);
    vi.stubEnv('HOME', home);
    vi.stubEnv('CODEX_CMD', fakeCli);
    vi.stubEnv('CLAUDE_CMD', fakeCli);
    vi.stubEnv('ANTIGRAVITY_CMD', fakeCli);
    vi.stubEnv('WORKBENCH_DB', join(tempDir, 'workbench.sqlite'));
    vi.stubEnv('WORKBENCH_DEMO_DATA', '0');

    codexHistoryId = '11111111-1111-4111-8111-111111111111';
    const codexHistoryDir = join(home, '.codex', 'sessions', '2026', '06', '06');
    codexHistoryFile = join(codexHistoryDir, `${codexHistoryId}.jsonl`);
    await mkdir(codexHistoryDir, { recursive: true });
    await writeFile(
      codexHistoryFile,
      [
        JSON.stringify({ timestamp: '2026-06-06T01:00:00.000Z', type: 'session_meta', payload: { id: codexHistoryId, cwd: '/tmp/history' } }),
        JSON.stringify({ timestamp: '2026-06-06T01:01:00.000Z', type: 'event', payload: { type: 'user_message', message: '历史用户问题' } }),
        JSON.stringify({
          timestamp: '2026-06-06T01:02:00.000Z',
          type: 'event',
          payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: '历史助手回答' }] }
        })
      ].join('\n')
    );

    server = await buildServer();
    await server.listen({ host: '127.0.0.1', port: 0 });
    const address = server.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await server?.close();
    vi.unstubAllEnvs();
  });

  it('starts a session, streams terminal output, tracks tokens, stops tasks, and gates risky prompts', async () => {
    const apps = await get<AppInfo[]>('/api/apps');
    expect(Object.fromEntries(apps.map((app) => [app.appId, app.status]))).toMatchObject({
      codex: 'connected',
      claude: 'connected',
      antigravity: 'connected'
    });

    const history = await get<{ sessionId: string; frames: TerminalFrame[]; hasMore: boolean; nextCursor?: number; totalFrames: number }>('/api/sessions/11111111-1111-4111-8111-111111111111/history');
    expect(history.frames.some((frame) => frame.text.includes('历史用户问题'))).toBe(true);
    expect(history.frames.some((frame) => frame.text.includes('历史助手回答'))).toBe(true);
    expect(history.totalFrames).toBeGreaterThanOrEqual(history.frames.length);

    const firstHistoryPage = await get<{ frames: TerminalFrame[]; hasMore: boolean; nextCursor?: number }>('/api/sessions/11111111-1111-4111-8111-111111111111/history?limit=1');
    expect(firstHistoryPage.frames).toHaveLength(1);
    expect(firstHistoryPage.hasMore).toBe(true);
    expect(firstHistoryPage.nextCursor).toBe(1);

    const session = await post<Session>('/api/sessions', { appId: 'codex', cwd: process.cwd(), prompt: 'initial fake prompt' }, 201);
    const terminalOutput = waitForSseMessage<TerminalFrame>(
      `${baseUrl}/sse/sessions/${session.id}`,
      (frame) => frame.sessionId === session.id && frame.text.includes('hello fake cli')
    );
    const terminalEvent = waitForSseMessage<EventRecord>(
      `${baseUrl}/sse/events`,
      (event) => event.type === 'terminal.output' && event.sessionId === session.id && event.message.includes('hello fake cli')
    );

    await Promise.all([terminalOutput.ready, terminalEvent.ready]);
    await post(`/api/sessions/${session.id}/prompt`, { prompt: 'hello fake cli' });
    await expect(terminalOutput.promise).resolves.toMatchObject({ appId: 'codex', stream: 'stdout' });
    await expect(terminalEvent.promise).resolves.toMatchObject({ type: 'terminal.output' });
    const replayedOutput = waitForSseMessage<TerminalFrame>(
      `${baseUrl}/sse/sessions/${session.id}`,
      (frame) => frame.sessionId === session.id && frame.text.includes('hello fake cli')
    );
    await expect(replayedOutput.promise).resolves.toMatchObject({ appId: 'codex', stream: 'stdout' });
    replayedOutput.close();

    const usage = await get<{ usage: Array<{ appId: string; totalTokens: number }> }>('/api/token-usage?scope=day');
    expect(usage.usage.find((row) => row.appId === 'codex')?.totalTokens).toBeGreaterThan(0);

    const riskyResponse = await fetch(`${baseUrl}/api/sessions/${session.id}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: '请执行命令 rm -rf tmp' })
    });
    expect(riskyResponse.status).toBe(202);
    const risky = (await riskyResponse.json()) as { confirmation: { id: string; status: string } };
    expect(risky.confirmation.status).toBe('pending');
    await post(`/api/confirmations/${risky.confirmation.id}/reject`);

    await post(`/api/sessions/${session.id}/stop`);
    const stopped = await get<Task[]>(`/api/tasks?appId=codex&status=stopped`);
    expect(stopped.some((task) => task.sessionId === session.id)).toBe(true);

    for (const appId of ['claude', 'antigravity'] as AppId[]) {
      const extraSession = await post<Session>('/api/sessions', { appId, cwd: process.cwd(), prompt: `start ${appId}` }, 201);
      expect(extraSession.appId).toBe(appId);
      await post(`/api/sessions/${extraSession.id}/stop`);
      const extraStopped = await get<Task[]>(`/api/tasks?appId=${appId}&status=stopped`);
      expect(extraStopped.some((task) => task.sessionId === extraSession.id)).toBe(true);
    }

    const deleted = await del<DeleteSessionResult>(`/api/sessions/${codexHistoryId}`);
    expect(deleted.session.id).toBe(codexHistoryId);
    expect(deleted.deletedFiles).toEqual([codexHistoryFile]);
    await expect(fileExists(codexHistoryFile)).resolves.toBe(false);
    const sessionsAfterDelete = await get<Session[]>('/api/sessions');
    expect(sessionsAfterDelete.some((item) => item.id === codexHistoryId)).toBe(false);
    const tasksAfterDelete = await get<Task[]>('/api/tasks?appId=codex');
    expect(tasksAfterDelete.some((task) => task.sessionId === codexHistoryId)).toBe(false);
    const secondDelete = await fetch(`${baseUrl}/api/sessions/${codexHistoryId}`, { method: 'DELETE' });
    expect(secondDelete.status).toBe(404);

    const deleteTarget = await post<Session>('/api/sessions', { appId: 'codex', cwd: process.cwd(), prompt: 'delete fake session' }, 201);
    await post(`/api/sessions/${deleteTarget.id}/stop`);
    const missingSourceDelete = await del<DeleteSessionResult>(`/api/sessions/${deleteTarget.id}`);
    expect(missingSourceDelete.session.id).toBe(deleteTarget.id);
    expect(missingSourceDelete.skippedFiles.some((item) => item.includes('no-source-log'))).toBe(true);

    terminalOutput.close();
    terminalEvent.close();
  });

  async function get<T>(path: string): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`);
    expect(response.ok).toBe(true);
    return response.json() as Promise<T>;
  }

  async function post<T = unknown>(path: string, body?: unknown, expectedStatus = 200): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    expect(response.status).toBe(expectedStatus);
    return response.json() as Promise<T>;
  }

  async function del<T = unknown>(path: string, expectedStatus = 200): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, { method: 'DELETE' });
    expect(response.status).toBe(expectedStatus);
    return response.json() as Promise<T>;
  }
});

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function waitForSseMessage<T>(
  url: string,
  predicate: (value: T) => boolean
): { ready: Promise<void>; promise: Promise<T>; close(): void } {
  const controller = new AbortController();
  let readyResolve!: () => void;
  let readyReject!: (error: unknown) => void;
  let settled = false;
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const promise = new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`Timed out waiting for SSE message: ${url}`);
      settled = true;
      controller.abort();
      readyReject(error);
      reject(error);
    }, 5000);

    void (async () => {
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok || !response.body) throw new Error(`SSE failed: ${url} ${response.status}`);
        readyResolve();
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!settled) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let delimiter = buffer.indexOf('\n\n');
          while (delimiter >= 0) {
            const rawEvent = buffer.slice(0, delimiter);
            buffer = buffer.slice(delimiter + 2);
            delimiter = buffer.indexOf('\n\n');
            const data = rawEvent
              .split('\n')
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trimStart())
              .join('\n');
            if (!data) continue;
            const parsed = JSON.parse(data) as T;
            if (!predicate(parsed)) continue;
            settled = true;
            clearTimeout(timer);
            controller.abort();
            resolve(parsed);
            return;
          }
        }
      } catch (error) {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          readyReject(error);
          reject(error);
        }
      }
    })();
  });
  return {
    ready,
    promise,
    close() {
      settled = true;
      controller.abort();
    }
  };
}
