interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  onChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}

const PAGE_SIZES = [10, 20, 50];

// 构建页码序列：首尾页 + 当前页前后各 1 页，超出部分以省略号占位
function buildPages(page: number, maxPage: number): (number | '...')[] {
  if (maxPage <= 7) {
    return Array.from({ length: maxPage }, (_, i) => i + 1);
  }
  const pages: (number | '...')[] = [1];
  const start = Math.max(2, page - 1);
  const end = Math.min(maxPage - 1, page + 1);
  if (start > 2) pages.push('...');
  for (let i = start; i <= end; i++) pages.push(i);
  if (end < maxPage - 1) pages.push('...');
  pages.push(maxPage);
  return pages;
}

// 分页控件：页码导航 + 每页条数选择（10/20/50）
export function Pagination({ page, pageSize, total, onChange, onPageSizeChange }: PaginationProps) {
  if (total === 0) return null;
  const maxPage = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="pagination">
      <span className="pagination-total">共 {total} 条</span>
      <button
        className="page-btn"
        disabled={page <= 1}
        onClick={() => onChange(page - 1)}
        title="上一页"
      >
        ‹
      </button>
      {buildPages(page, maxPage).map((p, i) =>
        p === '...' ? (
          <span key={`e${i}`} className="page-ellipsis">…</span>
        ) : (
          <button
            key={p}
            className={`page-btn${p === page ? ' active' : ''}`}
            onClick={() => onChange(p)}
          >
            {p}
          </button>
        )
      )}
      <button
        className="page-btn"
        disabled={page >= maxPage}
        onClick={() => onChange(page + 1)}
        title="下一页"
      >
        ›
      </button>
      <select
        className="page-size-select"
        value={pageSize}
        onChange={(e) => onPageSizeChange(Number(e.target.value))}
      >
        {PAGE_SIZES.map((s) => (
          <option key={s} value={s}>
            {s} 条/页
          </option>
        ))}
      </select>
    </div>
  );
}
