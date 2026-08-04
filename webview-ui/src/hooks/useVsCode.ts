import { useState, useEffect, useRef, useCallback } from 'react';

declare const acquireVsCodeApi: () => any;

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  source?: { doc_name: string; score: number };
  error?: boolean;
}

export function useVsCode() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const vscodeRef = useRef(acquireVsCodeApi());
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === 'update') {
        setMessages(msg.messages);
        setLoading(false);
      } else if (msg.type === 'loading') {
        setLoading(true);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  const sendQuery = useCallback((query: string) => {
    if (!query.trim()) return;
    vscodeRef.current.postMessage({ type: 'query', query });
    if (inputRef.current) inputRef.current.value = '';
  }, []);

  const clearChat = useCallback(() => {
    vscodeRef.current.postMessage({ type: 'clearChat' });
    setMessages([]);
  }, []);

  const openSettings = useCallback(() => {
    vscodeRef.current.postMessage({ type: 'openSettings' });
  }, []);

  return { messages, loading, sendQuery, clearChat, openSettings, inputRef };
}
