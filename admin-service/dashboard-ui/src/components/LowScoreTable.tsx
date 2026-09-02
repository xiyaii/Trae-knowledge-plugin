import { Fragment, useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { LowScoreItem } from '../api';
import { Pagination } from './Pagination';

interface LowScoreTableProps {
  data: LowScoreItem[];
}

type SortKey = 'ts' | 'score' | 'query' | 'doc_name';
type SortDir = 'asc' | 'desc';

function formatTs(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function scoreClass(score: number): string {
  if (score < 0.2) return 'score-low';
  if (score < 0.3) return 'score-mid';
  return 'score-high';
}

// 低分问答表：搜索 + 排序 + 行展开 + CSV 导出
export function LowScoreTable({ data }: LowScoreTableProps) {
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('ts');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [expandedRow, setExpandedRow] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);

  const filtered = useMemo(() => {
    let arr = data;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      arr = arr.filter(
        (d) =>
          d.query.toLowerCase().includes(q) ||
          (d.doc_name || '').toLowerCase().includes(q)
      );
    }
    const sorted = [...arr].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'ts':
          cmp = a.ts - b.ts;
          break;
        case 'score':
          cmp = a.score - b.score;
          break;
        case 'query':
          cmp = a.query.localeCompare(b.query);
          break;
        case 'doc_name':
          cmp = (a.doc_name || '').localeCompare(b.doc_name || '');
          break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return sorted;
  }, [data, search, sortKey, sortDir]);

  // 搜索词或数据重载时回到第一页
  useEffect(() => {
    setPage(1);
  }, [search, data]);

  // 前端分页：搜索/排序/导出仍作用于全量数据，仅展示层切片
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const paged = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir(key === 'ts' || key === 'score' ? 'asc' : 'asc');
    }
  };

  const sortIcon = (key: SortKey) => {
    if (sortKey !== key) return '↕';
    return sortDir === 'asc' ? '↑' : '↓';
  };

  const exportCSV = () => {
    const header = '时间,问题,得分,命中文档\n';
    const rows = filtered
      .map((d) => {
        const q = `"${d.query.replace(/"/g, '""')}"`;
        const doc = `"${(d.doc_name || '').replace(/"/g, '""')}"`;
        return `${formatTs(d.ts)},${q},${d.score.toFixed(3)},${doc}`;
      })
      .join('\n');
    const csv = '\ufeff' + header + rows; // BOM for Excel
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `low_score_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!data || data.length === 0) {
    return <div className="empty-state">暂无低分问答</div>;
  }

  return (
    <div className="table-wrapper">
      <div className="table-toolbar">
        <div className="search-box">
          <svg className="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none">
            <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
            <path d="m21 21-4.3-4.3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          <input
            type="text"
            placeholder="搜索问题或命中文档..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button className="search-clear" onClick={() => setSearch('')}>
              ✕
            </button>
          )}
        </div>
        <div className="table-meta">
          <span className="result-count">{filtered.length} 条</span>
          <button className="export-btn" onClick={exportCSV}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            导出 CSV
          </button>
        </div>
      </div>

      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th className="th-sortable" onClick={() => toggleSort('ts')}>
                时间 <span className="sort-icon">{sortIcon('ts')}</span>
              </th>
              <th className="th-sortable" onClick={() => toggleSort('query')}>
                问题 <span className="sort-icon">{sortIcon('query')}</span>
              </th>
              <th className="th-sortable th-score" onClick={() => toggleSort('score')}>
                得分 <span className="sort-icon">{sortIcon('score')}</span>
              </th>
              <th className="th-sortable" onClick={() => toggleSort('doc_name')}>
                命中文档 <span className="sort-icon">{sortIcon('doc_name')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={4} className="no-result">无匹配结果</td>
              </tr>
            ) : (
              paged.map((d, i) => (
                <Fragment key={`${currentPage}-${i}`}>
                  <tr
                    className={`data-row ${expandedRow === i ? 'expanded' : ''}`}
                    onClick={() => setExpandedRow(expandedRow === i ? null : i)}
                  >
                    <td className="td-ts">{formatTs(d.ts)}</td>
                    <td className="td-query">
                      {d.query.length > 60 ? d.query.slice(0, 60) + '…' : d.query}
                    </td>
                    <td className={`td-score ${scoreClass(d.score)}`}>
                      {d.score.toFixed(3)}
                    </td>
                    <td className="td-doc">{d.doc_name || '-'}</td>
                  </tr>
                  <AnimatePresence initial={false}>
                    {expandedRow === i && (
                      <motion.tr
                        key={`expand-${i}`}
                        className="expand-row"
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.25, ease: [0.22, 0.61, 0.36, 1] }}
                      >
                        <td colSpan={4}>
                          <div className="expand-content">
                            <div className="expand-block">
                              <div className="expand-label">完整问题</div>
                              <div className="expand-value">{d.query}</div>
                            </div>
                            <div className="expand-block">
                              <div className="expand-label">命中文档</div>
                              <div className="expand-value">{d.doc_name || '未命中（无文档）'}</div>
                            </div>
                            <div className="expand-block">
                              <div className="expand-label">得分详情</div>
                              <div className={`expand-value ${scoreClass(d.score)}`}>
                                {d.score.toFixed(4)} · 阈值 0.3
                              </div>
                            </div>
                            <div className="expand-block">
                              <div className="expand-label">时间戳</div>
                              <div className="expand-value ts-mono">{new Date(d.ts).toISOString()}</div>
                            </div>
                          </div>
                        </td>
                      </motion.tr>
                    )}
                  </AnimatePresence>
                </Fragment>
              ))
            )}
          </tbody>
        </table>
      </div>
      {filtered.length > 0 && (
        <Pagination
          page={currentPage}
          pageSize={pageSize}
          total={filtered.length}
          onChange={(p) => {
            setPage(p);
            setExpandedRow(null); // 翻页后行展开状态失效，避免误展开
          }}
          onPageSizeChange={(s) => {
            setPageSize(s);
            setPage(1);
          }}
        />
      )}
    </div>
  );
}
