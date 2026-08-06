import { useState, useEffect, useCallback } from 'react';
import { api, OverviewResp, DailyItem, TopDocItem, LowScoreItem } from './api';

// 默认查询最近 7 天
function getDefaultRange(): { from: string; to: string } {
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  const from = new Date(now.getTime() - 7 * 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
  return { from, to };
}

// 分数着色
function scoreClass(score: number): string {
  if (score < 0.3) return 'score-low';
  if (score < 0.5) return 'score-mid';
  return 'score-high';
}

// 时间戳转可读时间
function formatTs(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function App() {
  const { from: defFrom, to: defTo } = getDefaultRange();
  const [from, setFrom] = useState(defFrom);
  const [to, setTo] = useState(defTo);

  const [overview, setOverview] = useState<OverviewResp | null>(null);
  const [daily, setDaily] = useState<DailyItem[]>([]);
  const [topDocs, setTopDocs] = useState<TopDocItem[]>([]);
  const [lowScore, setLowScore] = useState<LowScoreItem[]>([]);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ov, dy, td, ls] = await Promise.all([
        api.overview(from, to),
        api.daily(from, to),
        api.topDocs(from, to),
        api.lowScore(from, to),
      ]);
      setOverview(ov);
      setDaily(dy);
      setTopDocs(td);
      setLowScore(ls);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    load();
  }, [load]);

  // 日趋势最大值，用于柱状图归一化
  const maxDaily = Math.max(
    1,
    ...daily.map((d) => Math.max(d.install, d.login, d.query, d.dau))
  );

  return (
    <div className="app">
      <div className="header">
        <h1>Trae 知识库助手 · 运营看板</h1>
        <div className="date-range">
          {from} ~ {to}
        </div>
      </div>

      <div className="controls">
        <label>开始日期</label>
        <input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        />
        <label>结束日期</label>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        <button onClick={load} disabled={loading}>
          {loading ? '加载中...' : '查询'}
        </button>
      </div>

      {error && <div className="error">加载失败: {error}</div>}

      {loading && !overview && <div className="loading">加载中...</div>}

      {overview && (
        <>
          <div className="cards">
            <div className="card">
              <div className="label">累计激活设备数</div>
              <div className="value">{overview.install_count.toLocaleString()}</div>
              <div className="sub">首次启动并上报的设备</div>
            </div>
            <div className="card">
              <div className="label">累计登录用户数</div>
              <div className="value">{overview.login_count.toLocaleString()}</div>
              <div className="sub">通过企业版鉴权的用户</div>
            </div>
            <div className="card">
              <div className="label">区间问答次数</div>
              <div className="value">{overview.query_count.toLocaleString()}</div>
              <div className="sub">{from} ~ {to}</div>
            </div>
            <div className="card">
              <div className="label">今日活跃用户</div>
              <div className="value">{overview.dau.toLocaleString()}</div>
              <div className="sub">DAU</div>
            </div>
            <div className="card">
              <div className="label">平均检索得分</div>
              <div className="value">{overview.avg_score.toFixed(3)}</div>
              <div className="sub">区间 query 平均 score</div>
            </div>
            <div className="card">
              <div className="label">低分占比</div>
              <div className="value">{(overview.low_score_rate * 100).toFixed(1)}%</div>
              <div className="sub">score &lt; 0.3 的 query 占比</div>
            </div>
          </div>

          <div className="section">
            <h2>日趋势</h2>
            {daily.length === 0 ? (
              <div className="loading">暂无数据</div>
            ) : (
              <div className="bar-chart">
                {daily.map((d) => (
                  <div key={d.date} className="bar-row">
                    <span className="date">{d.date}</span>
                    <div className="bar-bg">
                      <div
                        className="bar-fill"
                        style={{ width: `${(d.query / maxDaily) * 100}%` }}
                        title={`问答: ${d.query} | 安装: ${d.install} | 登录: ${d.login} | DAU: ${d.dau}`}
                      />
                    </div>
                    <span className="count">{d.query}</span>
                  </div>
                ))}
              </div>
            )}
            <div style={{ marginTop: 12, fontSize: 12, color: '#86868b' }}>
              柱状图展示问答次数，hover 可看安装/登录/DAU 明细
            </div>
          </div>

          <div className="section">
            <h2>命中频次 Top 文档</h2>
            {topDocs.length === 0 ? (
              <div className="loading">暂无数据</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>文档名称</th>
                    <th>命中次数</th>
                    <th>平均得分</th>
                  </tr>
                </thead>
                <tbody>
                  {topDocs.map((d, i) => (
                    <tr key={i}>
                      <td>{d.doc_name}</td>
                      <td>{d.count}</td>
                      <td className={`score ${scoreClass(d.avg_score)}`}>
                        {d.avg_score.toFixed(3)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="section">
            <h2>低分问答列表（score &lt; 0.3）</h2>
            <div style={{ fontSize: 12, color: '#86868b', marginBottom: 12 }}>
              以下问答知识库命中较差，建议人工补充知识库内容
            </div>
            {lowScore.length === 0 ? (
              <div className="loading">暂无低分问答</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>用户</th>
                    <th>问题</th>
                    <th>得分</th>
                    <th>命中文档</th>
                  </tr>
                </thead>
                <tbody>
                  {lowScore.map((d, i) => (
                    <tr key={i}>
                      <td>{formatTs(d.ts)}</td>
                      <td style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {d.user_id || '-'}
                      </td>
                      <td style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {d.query}
                      </td>
                      <td className={`score ${scoreClass(d.score)}`}>
                        {d.score.toFixed(3)}
                      </td>
                      <td>{d.doc_name || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
