import { useMemo, useState } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';
import { TopDocItem } from '../api';

interface TopDocsChartProps {
  data: TopDocItem[];
}

// 得分着色
function scoreColor(score: number): string {
  if (score < 0.3) return 'var(--danger)';
  if (score < 0.5) return 'var(--warning)';
  return 'var(--success)';
}

function CustomTooltip({ active, payload }: any) {
  if (!active || !payload || !payload.length) return null;
  const item = payload[0].payload as TopDocItem;
  return (
    <div className="chart-tooltip">
      <div className="tooltip-title" style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {item.doc_name}
      </div>
      <div className="tooltip-row">
        <span className="tooltip-name">命中次数</span>
        <span className="tooltip-val">{item.count.toLocaleString()}</span>
      </div>
      <div className="tooltip-row">
        <span className="tooltip-name">平均得分</span>
        <span className="tooltip-val">{item.avg_score.toFixed(3)}</span>
      </div>
    </div>
  );
}

// Top 文档横向条形图：条长 = 命中次数，颜色 = avg_score
export function TopDocsChart({ data }: TopDocsChartProps) {
  const [sortBy, setSortBy] = useState<'count' | 'score'>('count');

  const sorted = useMemo(() => {
    const arr = [...data];
    arr.sort((a, b) =>
      sortBy === 'count' ? b.count - a.count : a.avg_score - b.avg_score
    );
    return arr.slice(0, 10);
  }, [data, sortBy]);

  if (!data || data.length === 0) {
    return <div className="empty-state">暂无数据</div>;
  }

  return (
    <div className="chart-wrapper">
      <div className="chart-toolbar">
        <span className="toolbar-label">排序：</span>
        <button
          className={`sort-btn ${sortBy === 'count' ? 'active' : ''}`}
          onClick={() => setSortBy('count')}
        >
          按命中次数
        </button>
        <button
          className={`sort-btn ${sortBy === 'score' ? 'active' : ''}`}
          onClick={() => setSortBy('score')}
        >
          按平均得分（升序）
        </button>
      </div>
      <ResponsiveContainer width="100%" height={Math.max(240, sorted.length * 32)}>
        <BarChart
          data={sorted}
          layout="vertical"
          margin={{ top: 4, right: 16, left: 8, bottom: 4 }}
        >
          <XAxis type="number" stroke="var(--text-3)" fontSize={11} tickLine={false} axisLine={false} />
          <YAxis
            type="category"
            dataKey="doc_name"
            stroke="var(--text-2)"
            fontSize={11}
            tickLine={false}
            axisLine={false}
            width={180}
            tickFormatter={(v: string) => (v.length > 22 ? v.slice(0, 22) + '…' : v)}
          />
          <Tooltip content={<CustomTooltip />} cursor={{ fill: 'var(--surface-2)' }} />
          <Bar dataKey="count" name="命中次数" radius={[0, 4, 4, 0]} maxBarSize={20}>
            {sorted.map((d, i) => (
              <Cell key={i} fill={scoreColor(d.avg_score)} fillOpacity={0.85} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
