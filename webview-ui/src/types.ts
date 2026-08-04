export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  source?: { doc_name: string; score: number };
  error?: boolean;
}
