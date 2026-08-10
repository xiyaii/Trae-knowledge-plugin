// API 类型定义

export interface OverviewResp {
  install_count: number;
  login_count: number;
  query_count: number;
  dau: number;
  avg_score: number;
  low_score_rate: number;
}

export interface DailyItem {
  date: string;
  install: number;
  login: number;
  query: number;
  dau: number;
}

export interface TopDocItem {
  doc_name: string;
  count: number;
  avg_score: number;
}

export interface LowScoreItem {
  query: string;
  score: number;
  doc_name: string;
  ts: number;
}

// 请求封装：使用浏览器原生 BasicAuth 弹窗
async function fetchJSON<T>(url: string): Promise<T> {
  const resp = await fetch(url, { credentials: 'include' });
  if (resp.status === 401) {
    throw new Error('Unauthorized');
  }
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  }
  return resp.json();
}

export const api = {
  overview: (from: string, to: string) =>
    fetchJSON<OverviewResp>(`/dashboard/overview?from=${from}&to=${to}`),
  daily: (from: string, to: string) =>
    fetchJSON<DailyItem[]>(`/dashboard/daily?from=${from}&to=${to}`),
  topDocs: (from: string, to: string, limit = 10) =>
    fetchJSON<TopDocItem[]>(`/dashboard/top-docs?from=${from}&to=${to}&limit=${limit}`),
  lowScore: (from: string, to: string, limit = 20) =>
    fetchJSON<LowScoreItem[]>(`/dashboard/low-score?from=${from}&to=${to}&limit=${limit}`),
};
