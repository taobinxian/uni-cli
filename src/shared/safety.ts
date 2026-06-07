import type { RiskAssessment } from './types.js';

const RULES: Array<{ reason: string; pattern: RegExp }> = [
  { reason: '写文件或修改代码', pattern: /(写入|修改|编辑|patch|apply|write file|edit file|save file)/i },
  { reason: '执行 shell 命令', pattern: /(执行命令|运行命令|shell|bash|zsh|rm\s+-|sudo|chmod|curl|wget|npm\s+install)/i },
  { reason: '访问网络', pattern: /(访问网络|请求接口|联网|download|upload|fetch|http:\/\/|https:\/\/)/i },
  { reason: '发送外部消息', pattern: /(发送消息|发邮件|发到|send email|post message|slack|lark|飞书)/i },
  { reason: '删除文件', pattern: /(删除|移除|delete|remove|rm\s+)/i }
];

export function assessRisk(text: string): RiskAssessment {
  const reasons = RULES.filter((rule) => rule.pattern.test(text)).map((rule) => rule.reason);
  return { risky: reasons.length > 0, reasons };
}
