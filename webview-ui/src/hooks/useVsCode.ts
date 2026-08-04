import { useState, useEffect, useRef, useCallback } from 'react';
import type { ChatMessage } from '../types';

declare const acquireVsCodeApi: () => any;

export function useVsCode() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const vscodeRef = useRef<any>(null);

  useEffect(() => {
    vscodeRef.current = acquireVsCodeApi();
    const handler = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.type === 'update') {
        setMessages(msg.messages || []);
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
    vscodeRef.current?.postMessage({ type: 'query', query });
  }, []);

  const clearChat = useCallback(() => {
    vscodeRef.current?.postMessage({ type: 'clearChat' });
    setMessages([]);
  }, []);

  const openSettings = useCallback(() => {
    vscodeRef.current?.postMessage({ type: 'openSettings' });
  }, []);

  return { messages, loading, sendQuery, clearChat, openSettings };
}
