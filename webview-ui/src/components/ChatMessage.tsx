import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useState, useEffect, useRef } from 'react';
import type { ChatMessage } from '../types';

// 清理URL末尾的标点符号（中英文句号、逗号、分号、感叹号、问号等）
// LLM生成回答时可能把标点紧跟在URL后面，导致点击链接404
function cleanUrl(href: string): string {
  return href.replace(/[。，；！？.,;!?）)】」』》]+$/g, '');
}

// 点踩内置原因（3 项），支持用户自定义补充
const DISLIKE_REASONS = ['与问题无关', '结论不完整', '答案错误'];

export function ChatMessageView({
  msg,
  onFeedback,
  onOpenLink,
  feedbackError,
}: {
  msg: ChatMessage;
  onFeedback?: (msgId: string, feedback: 'like' | 'dislike', reason?: string) => void;
  onOpenLink?: (url: string) => void;
  feedbackError?: string | null;
}) {
  const [showReason, setShowReason] = useState(false);
  const [selectedReasons, setSelectedReasons] = useState<string[]>([]);
  const [customReason, setCustomReason] = useState('');
  const [copied, setCopied] = useState(false);
  // P1-4: 节流锁，500ms 内的重复点击被忽略，避免连点产生冗余事件
  const submittingRef = useRef(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 切换消息时重置内部状态
  useEffect(() => {
    setShowReason(false);
    setSelectedReasons([]);
    setCustomReason('');
    setCopied(false);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
  }, [msg.msgId]);

  // 卸载时清理复制提示定时器
  useEffect(() => () => {
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
  }, []);

  // 已是点踩时，展开原因面板回填已选原因
  useEffect(() => {
    if (msg.feedback === 'dislike' && msg.feedbackReason) {
      setSelectedReasons(msg.feedbackReason.split(';').filter(Boolean));
    }
  }, [msg.feedback, msg.feedbackReason]);

  const canFeedback = msg.role === 'assistant' && !msg.error && !!msg.msgId;
  // 已反馈后类型锁定：点赞不可修改，点踩仅支持变更原因
  const isLocked = !!msg.feedback;
  const isDislike = msg.feedback === 'dislike';

  const throttle = (fn: () => void) => {
    if (submittingRef.current) return;
    submittingRef.current = true;
    fn();
    setTimeout(() => { submittingRef.current = false; }, 500);
  };

  const handleLike = () => {
    if (!msg.msgId) return;
    // 已反馈后锁定，不允许切换类型
    if (isLocked) return;
    throttle(() => {
      onFeedback?.(msg.msgId!, 'like');
      setShowReason(false);
    });
  };

  const handleDislike = () => {
    if (!msg.msgId) return;
    // 已点赞后不允许切换为点踩
    if (isLocked && !isDislike) return;
    // 已是点踩：仅展开原因面板支持修改补充内容
    if (!isDislike) {
      throttle(() => {
        onFeedback?.(msg.msgId!, 'dislike');
      });
    }
    setShowReason(true);
  };

  const submitReason = () => {
    if (!msg.msgId) return;
    throttle(() => {
      const reasons = [...selectedReasons];
      if (customReason.trim()) reasons.push(customReason.trim());
      onFeedback?.(msg.msgId!, 'dislike', reasons.join(';'));
      setShowReason(false);
    });
  };

  const toggleReason = (r: string) => {
    setSelectedReasons((prev) =>
      prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r]
    );
  };

  // 复制答案：优先 Clipboard API，不可用时降级 execCommand
  const fallbackCopy = (text: string) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* 忽略 */ }
    document.body.removeChild(ta);
  };

  const handleCopy = () => {
    const text = msg.content || '';
    const markCopied = () => {
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).then(markCopied).catch(() => {
        fallbackCopy(text);
        markCopied();
      });
    } else {
      fallbackCopy(text);
      markCopied();
    }
  };

  const hasError = feedbackError === msg.msgId;

  return (
    <div className={`message ${msg.role}${msg.error ? ' error' : ''}`}>
      <div className="bubble">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ href, children, ...props }) => {
              const cleanedHref = href ? cleanUrl(href) : href;
              return (
                <a
                  href={cleanedHref}
                  {...props}
                  onClick={(e) => {
                    if (cleanedHref) {
                      e.preventDefault();
                      onOpenLink?.(cleanedHref);
                    }
                  }}
                >
                  {children}
                </a>
              );
            },
          }}
        >
          {msg.content}
        </ReactMarkdown>
      </div>
      {msg.source && !msg.error && (
        <div className="source">
          来源: {msg.source.doc_name} · 得分 {msg.source.score.toFixed(4)}
        </div>
      )}
      {msg.role === 'assistant' && (
        <div
          className={`feedback-bar${msg.feedback ? ' has-feedback' : ''}${showReason ? ' show-reason' : ''}`}
        >
          <button
            className={`fb-btn fb-copy${copied ? ' copied' : ''}`}
            onClick={handleCopy}
            title={copied ? '已复制' : '复制答案'}
          >
            {copied ? '✓ 已复制' : '复制'}
          </button>
          {canFeedback && (
            <>
              <button
                className={`fb-btn ${msg.feedback === 'like' ? 'active-like' : ''}`}
                onClick={handleLike}
                disabled={isLocked}
                title={isLocked ? '已反馈，不可修改' : '点赞'}
              >
                👍
              </button>
              <button
                className={`fb-btn ${msg.feedback === 'dislike' ? 'active-dislike' : ''}`}
                onClick={handleDislike}
                disabled={isLocked && !isDislike}
                title={isLocked && !isDislike ? '已点赞，不可切换为点踩' : isDislike ? '修改点踩原因' : '点踩'}
              >
                👎
              </button>
              {msg.feedback && !showReason && (
                <span className="fb-done">
                  {msg.feedback === 'like' ? '已点赞' : '已点踩'}
                  {isDislike && ' · 点击 👎 可修改原因'}
                </span>
              )}
              {hasError && (
                <span className="fb-error">反馈失败，请重试</span>
              )}
              {showReason && (
                <div className="reason-panel">
                  <div className="reason-options">
                    {DISLIKE_REASONS.map((r) => (
                      <label key={r} className="reason-chip">
                        <input
                          type="checkbox"
                          checked={selectedReasons.includes(r)}
                          onChange={() => toggleReason(r)}
                        />
                        {r}
                      </label>
                    ))}
                  </div>
                  <input
                    className="reason-input"
                    placeholder="补充说明（可选）"
                    value={customReason}
                    onChange={(e) => setCustomReason(e.target.value)}
                  />
                  <button className="reason-submit" onClick={submitReason}>
                    {isDislike ? '更新原因' : '提交原因'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
