import { useState, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, OverviewResp, DailyItem, TopDocItem, LowScoreItem, FeedbackItem, UserInfo } from './api';
import { KpiCard } from './components/KpiCard';
import { DailyChart } from './components/DailyChart';
import { TopDocsChart } from './components/TopDocsChart';
import { LowScoreTable } from './components/LowScoreTable';
import {
  KpiSkeleton,
  ChartSkeleton,
  TableSkeleton,
} from './components/Skeleton';
import {
  RANGE_PRESETS,
  getPresetRange,
  getPrevRange,
  getDefaultRange,
  calcDelta,
} from './utils/date';
import { useTheme } from './hooks/useTheme';

export default function App() {
  const { from: defFrom, to: defTo } = getDefaultRange();
  const [from, setFrom] = useState(defFrom);
  const [to, setTo] = useState(defTo);
  const [activePreset, setActivePreset] = useState<string>('7d');
  const [customMode, setCustomMode] = useState(false);

  const [overview, setOverview] = useState<OverviewResp | null>(null);
  const [prevOverview, setPrevOverview] = useState<OverviewResp | null>(null);
  const [daily, setDaily] = useState<DailyItem[]>([]);
  const [topDocs, setTopDocs] = useState<TopDocItem[]>([]);
  const [lowScore, setLowScore] = useState<LowScoreItem[]>([]);
  const [feedback, setFeedback] = useState<FeedbackItem[]>([]);
  const [selectedFeedback, setSelectedFeedback] = useState<FeedbackItem | null>(null);

  const [loading, setLoading] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [userInfo, setUserInfo] = useState<UserInfo | null>(null);
  const { theme, toggle: toggleTheme } = useTheme();

  useEffect(() => {
    api.me().then(setUserInfo).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const prevRange = getPrevRange(from, to);
      const [ov, dy, td, ls, fb, prevOv] = await Promise.all([
        api.overview(from, to),
        api.daily(from, to),
        api.topDocs(from, to, 15),
        api.lowScoreMore(from, to, 100),
        api.feedback(from, to, 100),
        api.overview(prevRange.from, prevRange.to).catch(() => null),
      ]);
      setOverview(ov);
      setPrevOverview(prevOv);
      setDaily(dy);
      setTopDocs(td);
      setLowScore(ls);
      setFeedback(fb);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
      setInitialLoading(false);
    }
  }, [from, to]);

  useEffect(() => {
    load();
  }, [load]);

  // 从 daily 数组派生 sparkline 数据
  const sparklines = useMemo(() => {
    const pick = (key: keyof DailyItem) => daily.map((d) => Number(d[key]));
    return {
      install: pick('install'),
      login: pick('login'),
      query: pick('query'),
      dau: pick('dau'),
    };
  }, [daily]);

  // 应用预设
  const applyPreset = (preset: typeof RANGE_PRESETS[number]) => {
    const range = getPresetRange(preset.days);
    setFrom(range.from);
    setTo(range.to);
    setActivePreset(preset.key);
    setCustomMode(false);
  };

  // 自定义日期变化
  const onCustomDateChange = (newFrom: string, newTo: string) => {
    setFrom(newFrom);
    setTo(newTo);
    setCustomMode(true);
    setActivePreset('');
  };

  // 计算环比
  const deltas = useMemo(() => {
    if (!overview || !prevOverview) return null;
    return {
      install: calcDelta(overview.install_count, prevOverview.install_count),
      login: calcDelta(overview.login_count, prevOverview.login_count),
      query: calcDelta(overview.query_count, prevOverview.query_count),
      dau: calcDelta(overview.dau, prevOverview.dau),
      avgScore: calcDelta(overview.avg_score, prevOverview.avg_score),
      lowScoreRate: calcDelta(overview.low_score_rate, prevOverview.low_score_rate),
    };
  }, [overview, prevOverview]);

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <h1>Trae 知识库助手 · 运营看板</h1>
          <div className="header-sub">{from} ~ {to}</div>
        </div>
        <div className="header-right">
          <button
            className="theme-toggle"
            onClick={toggleTheme}
            aria-label={theme === 'dark' ? '切换到亮色' : '切换到暗色'}
            title={theme === 'dark' ? '切换到亮色' : '切换到暗色'}
          >
            {theme === 'dark' ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="2" />
                <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            )}
          </button>
          {userInfo && (
            <div className="user-info">
              <div className="user-avatar">{userInfo.name?.charAt(0) || '?'}</div>
              <span className="user-name">{userInfo.name}</span>
              <button className="logout-btn" onClick={() => api.logout()}>
                退出登录
              </button>
            </div>
          )}
        </div>
      </header>

      {/* 日期范围控制 */}
      <div className="controls">
        <div className="preset-group">
          {RANGE_PRESETS.map((p) => (
            <button
              key={p.key}
              className={`preset-btn ${activePreset === p.key && !customMode ? 'active' : ''}`}
              onClick={() => applyPreset(p)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="custom-range">
          <input
            type="date"
            value={from}
            onChange={(e) => onCustomDateChange(e.target.value, to)}
            className="date-input"
          />
          <span className="range-sep">→</span>
          <input
            type="date"
            value={to}
            onChange={(e) => onCustomDateChange(from, e.target.value)}
            className="date-input"
          />
        </div>
        <button className="refresh-btn" onClick={load} disabled={loading}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className={loading ? 'spinning' : ''}>
            <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          刷新
        </button>
      </div>

      {error && (
        <motion.div
          className="error-banner"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <span>加载失败：{error}</span>
          <button onClick={load}>重试</button>
        </motion.div>
      )}

      {/* KPI 卡片区 */}
      {initialLoading ? (
        <div className="kpi-row">
          {Array.from({ length: 6 }).map((_, i) => <KpiSkeleton key={i} />)}
        </div>
      ) : overview ? (
        <div className="kpi-row">
          <KpiCard
            index={0}
            label="累计激活设备数"
            value={overview.install_count}
            sub="首次启动并上报的设备"
            sparkData={sparklines.install}
            sparkColor="var(--purple)"
            delta={deltas?.install}
          />
          <KpiCard
            index={1}
            label="累计登录用户数"
            value={overview.login_count}
            sub="通过企业版鉴权的用户"
            sparkData={sparklines.login}
            sparkColor="var(--success)"
            delta={deltas?.login}
          />
          <KpiCard
            index={2}
            label="区间问答次数"
            value={overview.query_count}
            sub={`${from} ~ ${to}`}
            sparkData={sparklines.query}
            sparkColor="var(--accent)"
            delta={deltas?.query}
          />
          <KpiCard
            index={3}
            label="今日活跃用户"
            value={overview.dau}
            sub="DAU"
            sparkData={sparklines.dau}
            sparkColor="var(--warning)"
            delta={deltas?.dau}
          />
          <KpiCard
            index={4}
            label="平均检索得分"
            value={overview.avg_score}
            decimals={3}
            sub="区间 query 平均 score"
            sparkData={daily.map((d) => d.query)}
            sparkColor="var(--accent)"
            delta={deltas?.avgScore}
          />
          <KpiCard
            index={5}
            label="低分占比"
            value={overview.low_score_rate * 100}
            decimals={1}
            suffix="%"
            sub="score < 0.3 的 query 占比"
            sparkColor="var(--danger)"
            delta={deltas?.lowScoreRate}
            invertDelta
          />
        </div>
      ) : null}

      {/* 日趋势 */}
      <section className="section">
        <div className="section-header">
          <h2>日趋势</h2>
          <span className="section-hint">分组柱状图 + DAU 折线叠加，点击图例切换显示</span>
        </div>
        {initialLoading ? <ChartSkeleton /> : <DailyChart data={daily} />}
      </section>

      <div className="grid-2col">
        {/* Top 文档 */}
        <section className="section">
          <div className="section-header">
            <h2>命中频次 Top 文档</h2>
            <span className="section-hint">颜色按平均得分</span>
          </div>
          {initialLoading ? <ChartSkeleton /> : <TopDocsChart data={topDocs} />}
        </section>

        {/* 低分问答 */}
        <section className="section">
          <div className="section-header">
            <h2>低分问答（score &lt; 0.3）</h2>
            <span className="section-hint">点击行展开详情，支持搜索/排序/导出</span>
          </div>
          {initialLoading ? (
            <TableSkeleton rows={6} />
          ) : (
            <LowScoreTable data={lowScore} />
          )}
        </section>
      </div>

      {/* 反馈分析 */}
      <section className="section">
        <div className="section-header">
          <h2>反馈分析</h2>
          <span className="section-hint">
            点赞/点踩统计与点踩明细，辅助知识库内容优化（同消息反复修改取最新）
          </span>
        </div>
        {initialLoading ? (
          <TableSkeleton rows={6} />
        ) : overview ? (
          <>
            <div className="kpi-row" style={{ marginBottom: 16 }}>
              <KpiCard
                index={0}
                label="点赞数"
                value={overview.like_count}
                sub={`${from} ~ ${to}`}
                sparkColor="var(--success)"
              />
              <KpiCard
                index={1}
                label="点踩数"
                value={overview.dislike_count}
                sub={`${from} ~ ${to}`}
                sparkColor="var(--danger)"
              />
              <KpiCard
                index={2}
                label="点踩率"
                value={overview.feedback_rate * 100}
                decimals={1}
                suffix="%"
                sub="dislike / (like + dislike)"
                sparkColor="var(--warning)"
                invertDelta
              />
            </div>
            <table className="feedback-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>问题</th>
                  <th>命中文档</th>
                  <th>答案</th>
                  <th>点踩原因</th>
                </tr>
              </thead>
              <tbody>
                {feedback.length === 0 ? (
                  <tr>
                    <td colSpan={5} style={{ textAlign: 'center', padding: 24 }}>
                      暂无点踩数据
                    </td>
                  </tr>
                ) : (
                  feedback.map((it, i) => (
                    <tr key={i}>
                      <td>{new Date(it.ts).toLocaleString('zh-CN')}</td>
                      <td>{it.query}</td>
                      <td>{it.doc_name || '-'}</td>
                      <td className="td-answer">
                        {it.answer ? (
                          <>
                            <span className="answer-preview">
                              {it.answer.slice(0, 80)}
                              {it.answer.length > 80 ? '…' : ''}
                            </span>
                            {it.answer.length > 80 && (
                              <button
                                className="answer-more-btn"
                                onClick={() => setSelectedFeedback(it)}
                              >
                                查看完整
                              </button>
                            )}
                          </>
                        ) : (
                          <span className="text-muted">-</span>
                        )}
                      </td>
                      <td>{it.reason || '-'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </>
        ) : null}
      </section>

      {/* 答案详情抽屉：右侧滑出，markdown 渲染完整答案 */}
      <AnimatePresence>
        {selectedFeedback && (
          <motion.div
            className="drawer-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => setSelectedFeedback(null)}
          >
            <motion.aside
              className="feedback-drawer"
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ duration: 0.3, ease: [0.22, 0.61, 0.36, 1] }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="drawer-header">
                <h3>答案详情</h3>
                <button
                  className="drawer-close"
                  onClick={() => setSelectedFeedback(null)}
                  aria-label="关闭"
                >
                  ✕
                </button>
              </div>
              <div className="drawer-body">
                <div className="drawer-meta">
                  <div className="meta-row">
                    <span className="meta-label">时间</span>
                    <span className="meta-value">
                      {new Date(selectedFeedback.ts).toLocaleString('zh-CN')}
                    </span>
                  </div>
                  <div className="meta-row">
                    <span className="meta-label">问题</span>
                    <span className="meta-value">{selectedFeedback.query}</span>
                  </div>
                  <div className="meta-row">
                    <span className="meta-label">命中文档</span>
                    <span className="meta-value">
                      {selectedFeedback.doc_name || '未命中'}
                    </span>
                  </div>
                  <div className="meta-row">
                    <span className="meta-label">点踩原因</span>
                    <span className="meta-value">
                      {selectedFeedback.reason || '未填写'}
                    </span>
                  </div>
                </div>
                <div className="drawer-divider" />
                <div className="drawer-section">
                  <div className="drawer-section-title">AI 回答</div>
                  <div className="drawer-answer">
                    {selectedFeedback.answer ? (
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {selectedFeedback.answer}
                      </ReactMarkdown>
                    ) : (
                      <span className="text-muted">无答案内容</span>
                    )}
                  </div>
                </div>
              </div>
            </motion.aside>
          </motion.div>
        )}
      </AnimatePresence>

      <footer className="footer">
        <span>Trae 知识库助手运营看板 · 数据更新于 {new Date().toLocaleString('zh-CN')}</span>
      </footer>
    </div>
  );
}
