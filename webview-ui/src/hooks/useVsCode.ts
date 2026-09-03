import { useState, useEffect, useRef, useCallback } from 'react';
import type { ChatMessage, AuthResult } from '../types';

declare const acquireVsCodeApi: () => any;

export function useVsCode() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [authResult, setAuthResult] = useState<AuthResult | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
  const [uninstalled, setUninstalled] = useState(false);
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
      } else if (msg.type === 'feedbackError') {
        // ack 失败：提示用户并 3s 后自动清除
        setFeedbackError(msg.msgId);
        setTimeout(() => setFeedbackError(null), 3000);
      } else if (msg.type === 'uninstalled') {
        setUninstalled(true);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  const sendQuery = useCallback((query: string) => {
    if (!query.trim()) return;
    vscodeRef.current?.postMessage({ type: 'query', query });
  }, []);

  // 发送反馈：允许反复修改，每次都会触发后端上报一条新 feedback 事件
  // ack 回滚由 webviewProvider 处理：失败时回滚 UI 并发 feedbackError 消息
  const sendFeedback = useCallback(
    (msgId: string, feedback: 'like' | 'dislike', reason?: string) => {
      if (!msgId) return;
      vscodeRef.current?.postMessage({ type: 'feedback', msgId, feedback, reason });
    },
    []
  );

  const clearChat = useCallback(() => {
    vscodeRef.current?.postMessage({ type: 'clearChat' });
    setMessages([]);
  }, []);

  const login = useCallback(() => {
    vscodeRef.current?.postMessage({ type: 'login' });
  }, []);

  // 打开外部链接（自动清理URL末尾标点）
  const openLink = useCallback((url: string) => {
    vscodeRef.current?.postMessage({ type: 'openLink', url });
  }, []);

  return {
    messages,
    loading,
    sendQuery,
    sendFeedback,
    feedbackError,
    clearChat,
    login,
    openLink,
    authenticated,
    authResult,
    uninstalled,
  };
}
