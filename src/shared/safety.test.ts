import { describe, expect, it } from 'vitest';
import { assessRisk } from './safety.js';

describe('assessRisk', () => {
  it('flags risky control prompts', () => {
    const risk = assessRisk('请执行命令 npm install 并修改文件');
    expect(risk.risky).toBe(true);
    expect(risk.reasons).toContain('执行 shell 命令');
    expect(risk.reasons).toContain('写文件或修改代码');
  });

  it('allows read-only prompts', () => {
    expect(assessRisk('解释当前任务状态').risky).toBe(false);
  });
});
