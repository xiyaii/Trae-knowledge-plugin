export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  source?: { doc_name: string; score: number };
  error?: boolean;
  msgId?: string;
  feedback?: 'like' | 'dislike';
  feedbackReason?: string;
}

export interface AuthResult {
  ok: boolean;
  reason?: string;
  identityStr?: string;
}
