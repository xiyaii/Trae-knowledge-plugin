import { motion } from 'framer-motion';
import { useCountUp, formatNumber } from '../hooks/useCountUp';

interface KpiCardProps {
  label: string;
  value: number;
  decimals?: number;
  suffix?: string;
  sub?: string;
  sparkData?: number[];
  delta?: { value: string; dir: 'up' | 'down' | 'flat' };
  // 反向指标：true 表示下降是好事（如低分占比）
  invertDelta?: boolean;
  sparkColor?: string;
  index?: number;
}

export function KpiCard({
  label,
  value,
  decimals = 0,
  suffix = '',
  sub,
  sparkData,
  delta,
  invertDelta = false,
  sparkColor,
  index = 0,
}: KpiCardProps) {
  const animated = useCountUp(value, 700);

  // 判断环比颜色
  let deltaClass = 'delta-flat';
  let deltaArrow = '';
  if (delta && delta.dir !== 'flat') {
    const isGood = invertDelta ? delta.dir === 'down' : delta.dir === 'up';
    deltaClass = isGood ? 'delta-up' : 'delta-down';
    deltaArrow = delta.dir === 'up' ? '↑' : '↓';
  }

  return (
    <motion.div
      className="kpi-card"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: index * 0.05, ease: [0.22, 0.61, 0.36, 1] }}
    >
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">
        {formatNumber(animated, decimals)}
        {suffix}
        {delta && delta.dir !== 'flat' && (
          <span className={`kpi-delta ${deltaClass}`}>
            <span className="delta-arrow">{deltaArrow}</span>
            {delta.value}
          </span>
        )}
      </div>
      <div className="kpi-footer">
        {sub && <span className="kpi-sub">{sub}</span>}
        {sparkData && sparkData.length >= 2 && (
          <SparklineInline data={sparkData} color={sparkColor} />
        )}
      </div>
    </motion.div>
  );
}

// 内联简化版 sparkline，避免循环依赖
function SparklineInline({ data, color }: { data: number[]; color?: string }) {
  const width = 80;
  const height = 24;
  if (!data || data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const step = (width - 4) / (data.length - 1);
  const points = data.map((v, i) => {
    const x = 2 + i * step;
    const y = height - 3 - ((v - min) / range) * (height - 6);
    return [x, y] as [number, number];
  });
  const path = points
    .map(([x, y], i) => (i === 0 ? `M ${x},${y}` : `L ${x},${y}`))
    .join(' ');
  const last = points[points.length - 1];
  const stroke = color || 'var(--accent)';
  return (
    <svg width={width} height={height} className="kpi-spark" aria-hidden>
      <path
        d={path}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={last[0]} cy={last[1]} r={2} fill={stroke} />
    </svg>
  );
}
