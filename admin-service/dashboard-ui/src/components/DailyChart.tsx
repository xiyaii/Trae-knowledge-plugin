import { useMemo, useState } from 'react';
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { DailyItem } from '../api';

interface DailyChartProps {
  data: DailyItem[];
}

// 自定义 tooltip
interface TooltipPayloadItem {
  dataKey: string;
  value: number;
  color: string;
  name: string;
}

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div className="chart-tooltip">
      <div className="tooltip-title">{label}</div>
      {payload.map((p: TooltipPayloadItem) => (
        <div className="tooltip-row" key={p.dataKey}>
          <span className="tooltip-dot" style={{ background: p.color }} />
          <span className="tooltip-name">{p.name}</span>
          <span className="tooltip-val">{p.value.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

// 日趋势图：分组柱（安装/登录/问答）+ 折线叠加（DAU）
export function DailyChart({ data }: DailyChartProps) {
  // 显示控制
  const [showInstall, setShowInstall] = useState(true);
  const [showLogin, setShowLogin] = useState(true);
  const [showQuery, setShowQuery] = useState(true);
  const [showDau, setShowDau] = useState(true);

  const chartData = useMemo(
    () =>
      data.map((d) => ({
        date: d.date.slice(5), // MM-DD
        install: d.install,
        login: d.login,
        query: d.query,
        dau: d.dau,
      })),
    [data]
  );

  if (!data || data.length === 0) {
    return <div className="empty-state">暂无数据</div>;
  }

  return (
    <div className="chart-wrapper">
      <div className="chart-legend">
        <button
          className={`legend-btn ${showInstall ? 'active' : ''}`}
          onClick={() => setShowInstall(!showInstall)}
        >
          <span className="legend-dot" style={{ background: 'var(--purple)' }} />
          安装
        </button>
        <button
          className={`legend-btn ${showLogin ? 'active' : ''}`}
          onClick={() => setShowLogin(!showLogin)}
        >
          <span className="legend-dot" style={{ background: 'var(--success)' }} />
          登录
        </button>
        <button
          className={`legend-btn ${showQuery ? 'active' : ''}`}
          onClick={() => setShowQuery(!showQuery)}
        >
          <span className="legend-dot" style={{ background: 'var(--accent)' }} />
          问答
        </button>
        <button
          className={`legend-btn ${showDau ? 'active' : ''}`}
          onClick={() => setShowDau(!showDau)}
        >
          <span className="legend-dot" style={{ background: 'var(--warning)' }} />
          DAU
        </button>
      </div>
      <ResponsiveContainer width="100%" height={300}>
        <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
          <XAxis
            dataKey="date"
            stroke="var(--text-3)"
            fontSize={11}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            stroke="var(--text-3)"
            fontSize={11}
            tickLine={false}
            axisLine={false}
            width={48}
          />
          <Tooltip content={<CustomTooltip />} cursor={{ fill: 'var(--surface-2)' }} />
          {showInstall && (
            <Bar dataKey="install" name="安装" fill="var(--purple)" radius={[3, 3, 0, 0]} maxBarSize={20} />
          )}
          {showLogin && (
            <Bar dataKey="login" name="登录" fill="var(--success)" radius={[3, 3, 0, 0]} maxBarSize={20} />
          )}
          {showQuery && (
            <Bar dataKey="query" name="问答" fill="var(--accent)" radius={[3, 3, 0, 0]} maxBarSize={20} />
          )}
          {showDau && (
            <Line
              type="monotone"
              dataKey="dau"
              name="DAU"
              stroke="var(--warning)"
              strokeWidth={2}
              dot={{ r: 2, fill: 'var(--warning)' }}
              activeDot={{ r: 4 }}
            />
          )}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
