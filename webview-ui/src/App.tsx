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
    login,
    openLink,
    authenticated,
    authResult,
    uninstalled,
  } = useVsCode();

  // 插件已卸载：显示禁用界面
  if (uninstalled) {
    return (
      <div className="app">
        <div className="header">
          <span className="header-title">AskTrae</span>
        </div>
        <div className="login-screen">
          <div className="login-icon">⊘</div>
          <div className="login-title">插件已卸载</div>
          <div className="login-desc">
            插件已被卸载，请重新加载窗口以完成卸载
          </div>
        </div>
      </div>
    );
  }

  // 未鉴权：显示登录界面
  if (!authenticated) {
    return (
      <div className="app">
        <div className="header">
          <span className="header-title">AskTrae</span>
        </div>
        <div className="login-screen">
          <div className="login-icon">💬</div>
          <div className="login-title">需要登录验证</div>
          <div className="login-desc">
            请登录 Trae 企业版账号以使用 AskTrae
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
        <span className="header-title">AskTrae</span>
        <div className="header-actions">
          <button className="icon-btn" title="清空对话" onClick={clearChat}>
            🗑
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
          <ChatMessageView key={i} msg={msg} onFeedback={sendFeedback} onOpenLink={openLink} feedbackError={feedbackError} />
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

      <InputBox onSend={sendQuery} disabled={loading || uninstalled} />
    </div>
  );
}
