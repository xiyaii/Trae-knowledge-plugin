import { useState, useEffect, useRef, useCallback } from 'react';
import type { ChatMessage, AuthResult } from '../types';

declare const acquireVsCodeApi: () => any;

export function useVsCode() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [authResult, setAuthResult] = useState<AuthResult | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
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
      } else if (msg.type === 'authState') {
        setAuthenticated(msg.authenticated);
        setAuthResult(msg.result);
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

  const login = useCallback(() => {
    vscodeRef.current?.postMessage({ type: 'login' });
  }, []);

  return {
    messages,
    loading,
    sendQuery,
    clearChat,
    openSettings,
    login,
    authenticated,
    authResult,
  };
}
