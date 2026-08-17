import { useVsCode } from './hooks/useVsCode';
import { ChatMessageView } from './components/ChatMessage';
import { InputBox } from './components/InputBox';

export default function App() {
  const {
    messages,
    loading,
    sendQuery,
    sendFeedback,
    feedbackError,
    clearChat,
    openSettings,
    login,
    authenticated,
    authResult,
  } = useVsCode();

  // 未鉴权：显示登录界面
  if (!authenticated) {
    return (
      <div className="app">
        <div className="header">
          <span className="header-title">Trae Ask</span>
        </div>
        <div className="login-screen">
          <div className="login-icon">💬</div>
          <div className="login-title">需要登录验证</div>
          <div className="login-desc">
            请登录 Trae 企业版账号以使用 Trae Ask
          </div>
          {authResult && !authResult.ok && authResult.reason && (
            <div className="login-error">{authResult.reason}</div>
          )}
          <button className="login-btn" onClick={login}>
            验证企业版订阅
          </button>
        </div>
      </div>
    );
  }

  // 已鉴权：显示问答界面
  return (
    <div className="app">
      <div className="header">
        <span className="header-title">Trae Ask</span>
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
          <ChatMessageView key={i} msg={msg} onFeedback={sendFeedback} feedbackError={feedbackError} />
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
