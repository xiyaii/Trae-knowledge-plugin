import { useVsCode } from './hooks/useVsCode';
import { ChatMessageView } from './components/ChatMessage';
import { InputBox } from './components/InputBox';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  source?: { doc_name: string; score: number };
  error?: boolean;
}

export default function App() {
  const { messages, loading, sendQuery, clearChat, openSettings } = useVsCode();

  return (
    <div className="app">
      <div className="header">
        <span className="header-title">知识库助手</span>
        <div className="header-actions">
          <button className="icon-btn" title="清空对话" onClick={clearChat}>
            🗑
          </button>
          <button className="icon-btn" title="设置" onClick={openSettings}>
            ⚙
          </button>
        </div>
      </div>

      <div className="messages">
        {messages.length === 0 && !loading && (
          <div className="empty-state">
            <div className="icon">💡</div>
            <div>输入问题开始问答</div>
          </div>
        )}
        {messages.map((msg, i) => (
          <ChatMessageView key={i} msg={msg} />
        ))}
        {loading && (
          <div className="loading">
            <span className="dot" />
            <span className="dot" />
            <span className="dot" />
            <span>检索中...</span>
          </div>
        )}
      </div>

      <InputBox onSend={sendQuery} disabled={loading} />
    </div>
  );
}
