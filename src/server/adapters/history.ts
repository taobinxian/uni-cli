import type { Session, TerminalFrame } from '../../shared/types.js';

export type HistoryRole = 'user' | 'assistant' | 'tool' | 'system' | 'error';

export function historyFrame(session: Session, role: HistoryRole, text: string, createdAt?: string): TerminalFrame | undefined {
  const cleaned = cleanHistoryText(text);
  if (!cleaned) return undefined;
  return {
    sessionId: session.id,
    appId: session.appId,
    stream: 'system',
    text: JSON.stringify({ type: 'history.message', role, text: cleaned }),
    createdAt: validHistoryIso(createdAt) ?? session.updatedAt
  };
}

export function compactHistoryFrames(frames: Array<TerminalFrame | undefined>, limit = 160): TerminalFrame[] {
  const result: TerminalFrame[] = [];
  for (const frame of frames) {
    if (!frame) continue;
    const previous = result[result.length - 1];
    if (previous?.text === frame.text) continue;
    result.push(frame);
  }
  return result.slice(-limit);
}

export function textFromContent(value: unknown): string {
  return textFromContentInner(value, 0);
}

export function cleanHistoryText(text: string): string {
  return text
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, ' ')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, ' ')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 6000);
}

function textFromContentInner(value: unknown, depth: number): string {
  if (depth > 4 || value == null) return '';
  if (typeof value === 'string') return cleanHistoryText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return '';
  if (Array.isArray(value)) {
    return value
      .map((item) => textFromContentInner(item, depth + 1))
      .filter(Boolean)
      .join('\n');
  }
  if (typeof value !== 'object') return '';

  const record = value as Record<string, unknown>;
  const image = imageMarkdownFromRecord(record);
  if (image) return image;
  for (const key of ['text', 'content', 'message', 'input', 'output', 'result', 'summary']) {
    const text = textFromContentInner(record[key], depth + 1);
    if (text) return text;
  }
  return '';
}

function imageMarkdownFromRecord(record: Record<string, unknown>): string {
  const imageValue =
    firstString(record.image, record.image_url, record.imageUrl, record.image_path, record.imagePath, record.file_path, record.filePath, record.path, record.url) ||
    imageFromSource(record.source);
  if (!imageValue || !looksLikeImageReference(imageValue)) return '';
  const label = firstString(record.name, record.filename, record.file_name, record.title) || 'image';
  return `![${escapeMarkdownAlt(label)}](${imageValue})`;
}

function imageFromSource(source: unknown): string {
  if (!source || typeof source !== 'object') return '';
  const record = source as Record<string, unknown>;
  const direct = firstString(record.url, record.uri, record.path, record.file_path, record.filePath);
  if (direct) return direct;

  const mediaType = firstString(record.media_type, record.mediaType, record.mime_type, record.mimeType);
  const data = firstString(record.data);
  if (mediaType?.startsWith('image/') && data && data.length < 4_500) return `data:${mediaType};base64,${data}`;
  return '';
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function looksLikeImageReference(value: string): boolean {
  return /^data:image\//i.test(value) || /^https?:\/\/.+\.(?:png|jpe?g|gif|webp|bmp|svg)(?:[?#].*)?$/i.test(value) || /\.(?:png|jpe?g|gif|webp|bmp|svg)(?:[?#].*)?$/i.test(value);
}

function escapeMarkdownAlt(value: string): string {
  return value.replace(/[\[\]\n\r]/g, ' ').trim() || 'image';
}

function validHistoryIso(value?: string): string | undefined {
  if (!value || Number.isNaN(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}
