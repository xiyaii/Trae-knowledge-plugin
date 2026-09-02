// API 类型定义

export interface OverviewResp {
  install_count: number;
  login_count: number;
  query_count: number;
  dau: number;
  avg_score: number;
  low_score_rate: number;
  like_count: number;
  dislike_count: number;
  feedback_rate: number;
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

export interface FeedbackItem {
  msg_id: string;
  query: string;
  answer: string;
  doc_name: string;
  chunk_id: number;
  reason: string;
  ts: number;
}

export interface UserInfo {
  user_id: string;
  name: string;
}

// 请求封装：使用飞书 SSO 登录后的 Cookie 鉴权
// session 失效时跳转登录页
async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, { credentials: 'include', ...init });
  if (resp.status === 401) {
    // session 失效，跳转飞书 SSO 登录
    window.location.href = '/auth/login';
    throw new Error('Session expired, redirecting to login');
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
  // 拉取更多低分问答（用于增强搜索样本）
  lowScoreMore: (from: string, to: string, limit = 100) =>
    fetchJSON<LowScoreItem[]>(`/dashboard/low-score?from=${from}&to=${to}&limit=${limit}`),
  feedback: (from: string, to: string, limit = 50) =>
    fetchJSON<FeedbackItem[]>(`/dashboard/feedback?from=${from}&to=${to}&limit=${limit}`),
  // 标记点踩反馈为已审核（审核后不再看板展示，数据保留在数据库）
  reviewFeedback: (msgId: string) =>
    fetchJSON<{ ok: boolean }>(`/dashboard/feedback/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg_id: msgId }),
    }),
  me: () => fetchJSON<UserInfo>(`/auth/me`),
  logout: () => { window.location.href = '/auth/logout'; },
};
