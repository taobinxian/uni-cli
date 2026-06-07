import { describe, expect, it } from 'vitest';
import { estimateAntigravityTranscriptUsage, estimateTextTokens, parseTranscriptHistoryFrames } from './antigravity.js';
import type { Session } from '../../shared/types.js';

describe('Antigravity transcript token estimation', () => {
  it('estimates mixed English and CJK text tokens', () => {
    expect(estimateTextTokens('hello world')).toBeGreaterThan(0);
    expect(estimateTextTokens('你好，Antigravity')).toBeGreaterThan(estimateTextTokens('Antigravity'));
  });

  it('classifies explicit user input as input tokens', () => {
    const usage = estimateAntigravityTranscriptUsage({
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      content: '请帮我检查这个任务'
    });
    expect(usage.inputTokens).toBeGreaterThan(0);
    expect(usage.outputTokens).toBe(0);
  });

  it('classifies planner responses as output tokens', () => {
    const usage = estimateAntigravityTranscriptUsage({
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      content: 'I will inspect the files and report back.',
      thinking: 'Need to understand the current state first.'
    });
    expect(usage.inputTokens).toBe(0);
    expect(usage.outputTokens).toBeGreaterThan(0);
  });

  it('classifies tool results as input context and tool calls as output', () => {
    const usage = estimateAntigravityTranscriptUsage({
      source: 'MODEL',
      type: 'RUN_COMMAND',
      content: 'stdout line from a command',
      tool_calls: [{ name: 'run_command', args: { command: 'ls' } }]
    });
    expect(usage.inputTokens).toBeGreaterThan(0);
    expect(usage.outputTokens).toBeGreaterThan(0);
  });

  it('loads user and agent turns from transcript history without ephemeral system noise', () => {
    const session: Session = {
      id: 'antigravity-test',
      appId: 'antigravity',
      nativeId: 'antigravity-test',
      title: 'Antigravity test',
      status: 'completed',
      createdAt: '2026-06-06T12:58:41.000Z',
      updatedAt: '2026-06-06T12:58:41.000Z',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      live: false
    };
    const frames = parseTranscriptHistoryFrames(
      session,
      [
        JSON.stringify({
          source: 'USER_EXPLICIT',
          type: 'USER_INPUT',
          created_at: '2026-06-06T12:58:41Z',
          content: '<USER_REQUEST>\n你为什么系统提示词里面的人设是web相关的\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nnoise\n</ADDITIONAL_METADATA>'
        }),
        JSON.stringify({
          source: 'SYSTEM',
          type: 'EPHEMERAL_MESSAGE',
          created_at: '2026-06-06T12:58:41Z',
          content: 'internal reminder'
        }),
        JSON.stringify({
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          created_at: '2026-06-06T12:58:41Z',
          content: '你观察得非常敏锐！这是因为 Web 开发规范会影响界面输出。'
        })
      ].join('\n')
    );
    const messages = frames.map((frame) => JSON.parse(frame.text));

    expect(messages).toEqual([
      { type: 'history.message', role: 'user', text: '你为什么系统提示词里面的人设是web相关的' },
      { type: 'history.message', role: 'assistant', text: '你观察得非常敏锐！这是因为 Web 开发规范会影响界面输出。' }
    ]);
  });
});
