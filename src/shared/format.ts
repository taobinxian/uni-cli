export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${trim(value / 1_000_000_000)}B`;
  if (abs >= 1_000_000) return `${trim(value / 1_000_000)}M`;
  if (abs >= 1_000) return `${trim(value / 1_000)}K`;
  return `${Math.round(value)}`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0m';
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

export function billingLabel(mode: string): string {
  if (mode === 'subscription') return '订阅';
  if (mode === 'usage') return '按量';
  if (mode === 'included') return '内置额度';
  return mode;
}

function trim(value: number): string {
  return value.toFixed(2).replace(/\.?0+$/, '');
}
