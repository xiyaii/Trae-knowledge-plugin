// 骨架屏组件：shimmer 动画
import { motion } from 'framer-motion';

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`skeleton ${className}`} />;
}

export function KpiSkeleton() {
  return (
    <div className="kpi-card skeleton-card">
      <Skeleton className="skeleton-label" />
      <Skeleton className="skeleton-value" />
      <Skeleton className="skeleton-sub" />
    </div>
  );
}

export function ChartSkeleton() {
  return (
    <div className="skeleton-chart">
      <Skeleton className="skeleton-title" />
      <div className="skeleton-bars">
        {Array.from({ length: 7 }).map((_, i) => (
          <Skeleton key={i} className="skeleton-bar" />
        ))}
      </div>
    </div>
  );
}

export function TableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="skeleton-table">
      <Skeleton className="skeleton-row skeleton-row-head" />
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="skeleton-row" />
      ))}
    </div>
  );
}

// 全屏加载状态
export function FullPageSkeleton() {
  return (
    <motion.div
      className="skeleton-page"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2 }}
    >
      <div className="kpi-row">
        {Array.from({ length: 6 }).map((_, i) => (
          <KpiSkeleton key={i} />
        ))}
      </div>
      <ChartSkeleton />
      <TableSkeleton />
    </motion.div>
  );
}
