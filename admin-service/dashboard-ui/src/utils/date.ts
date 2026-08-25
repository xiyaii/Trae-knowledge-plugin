// 日期范围工具

export interface RangePreset {
  key: string;
  label: string;
  days: number; // 0 表示今日
}

export const RANGE_PRESETS: RangePreset[] = [
  { key: 'today', label: '今日', days: 0 },
  { key: '7d', label: '近 7 天', days: 7 },
  { key: '30d', label: '近 30 天', days: 30 },
  { key: '90d', label: '近 90 天', days: 90 },
];

// 返回 YYYY-MM-DD
function fmt(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// 今日：from == to == 今天
export function getPresetRange(days: number): { from: string; to: string } {
  const now = new Date();
  if (days === 0) {
    const today = fmt(now);
    return { from: today, to: today };
  }
  const to = fmt(now);
  const from = fmt(new Date(now.getTime() - days * 24 * 3600 * 1000));
  return { from, to };
}

// 给定 from/to，计算上一周期（相同天数）
export function getPrevRange(from: string, to: string): { from: string; to: string } {
  // 按 YYYY-MM-DD 拆解后以本地时区构造，避免 new Date(str) 按 UTC 解析
  // 在负偏移时区被 fmt() 格式化为前一日，导致环比区间整体偏移
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const f = new Date(fy, fm - 1, fd);
  const t = new Date(ty, tm - 1, td);
  const spanMs = t.getTime() - f.getTime();
  const dayMs = 24 * 3600 * 1000;
  const spanDays = Math.max(1, Math.round(spanMs / dayMs));
  const prevTo = new Date(f.getTime() - dayMs);
  const prevFrom = new Date(prevTo.getTime() - spanDays * dayMs);
  return { from: fmt(prevFrom), to: fmt(prevTo) };
}

export function getDefaultRange(): { from: string; to: string } {
  return getPresetRange(7);
}

// 环比百分比：返回带符号的字符串 + 正负方向
export function calcDelta(curr: number, prev: number): { value: string; dir: 'up' | 'down' | 'flat' } {
  if (prev === 0) {
    return { value: curr > 0 ? '+∞' : '0%', dir: curr > 0 ? 'up' : 'flat' };
  }
  const pct = ((curr - prev) / prev) * 100;
  const sign = pct >= 0 ? '+' : '';
  if (Math.abs(pct) < 0.05) {
    return { value: '0%', dir: 'flat' };
  }
  return {
    value: `${sign}${pct.toFixed(1)}%`,
    dir: pct > 0 ? 'up' : 'down',
  };
}
