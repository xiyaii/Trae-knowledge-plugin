import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useState, useEffect, useRef } from 'react';
import SyntaxHighlighter from 'react-syntax-highlighter/dist/esm/prism-light';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup';
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx';
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx';
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css';
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml';
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql';
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown';
import ini from 'react-syntax-highlighter/dist/esm/languages/prism/ini';
import toml from 'react-syntax-highlighter/dist/esm/languages/prism/toml';
import docker from 'react-syntax-highlighter/dist/esm/languages/prism/docker';
import diff from 'react-syntax-highlighter/dist/esm/languages/prism/diff';
import type { ChatMessage } from '../types';

// 注册常用语言及别名（注意依赖顺序：markup/javascript 需先于 jsx，jsx/typescript 先于 tsx）
// 未注册的语言自动回退为纯文本展示
const LANGS: Record<string, unknown> = {
  markup, html: markup, xml: markup, svg: markup,
  javascript, js: javascript,
  typescript, ts: typescript,
  jsx,
  tsx,
  css,
  bash, sh: bash, shell: bash, zsh: bash,
  json,
  yaml, yml: yaml,
  go,
  python, py: python,
  sql,
  markdown, md: markdown,
  ini, properties: ini,
  toml,
  docker, dockerfile: docker,
  diff, patch: diff,
};
Object.entries(LANGS).forEach(([name, lang]) =>
  SyntaxHighlighter.registerLanguage(name, lang as any)
);

// RFC 3986 URL 合法字符白名单：
//   unreserved  = ALPHA / DIGIT / "-" / "." / "_" / "~"
//   gen-delims  = ":" / "/" / "?" / "#" / "[" / "]" / "@"
//   sub-delims  = "!" / "$" / "&" / "'" / "(" / ")" / "*" / "+" / "," / ";" / "="
//   pct-encoded = "%" HEXDIG HEXDIG
// 中文及全角标点（、。，！？等）一律视为 URL 终止符，避免被误吞入链接。
const URL_ALLOWED = "A-Za-z0-9\\-._~:/?#\\[\\]@!$&'()*+,;=%";
// 裸 URL 严格匹配：协议头 + 一个以上合法字符，贪婪吃掉连续的合法 URL 字符
const BARE_URL_RE = new RegExp(
  `https?://[${URL_ALLOWED}]+`,
  'gi'
);
// 末尾允许保留但应清理的结尾标点（LLM 常把标点紧贴 URL 末尾输出）
const TRAILING_PUNCT_RE = /[。，、；！？.,;!?）)】」』》:：\s]+$/;
// URL 结尾常见的"成对"标点（即使是合法 URL 字符也不应出现在末尾）
const TRAILING_PAIR_RE = /[),;:!?'">.]+$/;

/**
 * 裸 URL 预处理：
 * 0) 先占位保护：代码块(```...```)、行内代码(`...`)、已有的 Markdown 链接
 *    [text](url)、已有的 <url> 尖括号链接——这些内部的 URL 不再二次处理
 * 1) 对剩余裸 URL 用 GFM 尖括号语法 <URL> 包裹，让解析器严格按边界识别，
 *    防止中文/换行/多个 URL 被 GFM 自动链接粘成一个超长链接
 * 2) URL 末尾紧跟的悬挂标点（中文句号、顿号、右括号、逗号等）剥离后再包裹，
 *    例如 "https://x.com/a。"  →  "<https://x.com/a>。"
 */
function wrapBareUrls(content: string): string {
  const placeholders: string[] = [];
  const PH = (s: string) => {
    const i = placeholders.length;
    placeholders.push(s);
    return `\u0000PH${i}\u0000`;
  };

  let s = content;

  // 1. 保护围栏代码块 ```lang ... ```
  s = s.replace(/```[\s\S]*?```/g, PH);
  // 2. 保护行内代码 `...`（排除空反引号和跨段）
  s = s.replace(/`[^`\n]+`/g, PH);
  // 3. 保护已有 Markdown 链接 [text](url) —— 先匹配，避免括号内 URL 被处理
  s = s.replace(/\[[^\]]*\]\(\s*<?[^)\s]+>?\s*\)/g, PH);
  // 4. 保护已有尖括号自动链接 <http(s)://...>
  s = s.replace(/<https?:\/\/[^>\s]+>/gi, PH);
  // 5. 保护 HTML 标签 <a>...</a>（防止误伤属性里的 URL）—— 目前 webview 一般不会有，但防御性处理
  s = s.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, PH);

  // 对剩余裸 URL 做尖括号包裹
  s = s.replace(BARE_URL_RE, (raw) => {
    let url = raw;
    for (let i = 0; i < 8; i++) {
      const before = url;
      url = url.replace(TRAILING_PUNCT_RE, '').replace(TRAILING_PAIR_RE, '');
      if (url === before) break;
    }
    if (!url || url.length < 'https://x.co'.length) return raw;
    return `<${url}>`;
  });

  // 还原占位
  s = s.replace(/\u0000PH(\d+)\u0000/g, (_, i) => placeholders[Number(i)]);
  return s;
}

// 清理 href 中可能残留的非法字符（兜底，主要针对 Markdown 手动链接场景）：
// 1) 去掉末尾中英文标点
// 2) 如果两个 URL 被粘成一个（第二个 http(s):// 开头），从第二个协议头开始截断
function cleanUrl(href: string): string {
  let s = href;
  // 截断被错误拼接的第二个 URL
  const secondProto = s.search(/(?<!^)https?:\/\//i);
  if (secondProto > 0) {
    s = s.slice(0, secondProto);
  }
  // 去掉末尾标点/空白
  for (let i = 0; i < 8; i++) {
    const before = s;
    s = s.replace(TRAILING_PUNCT_RE, '').replace(TRAILING_PAIR_RE, '');
    if (s === before) break;
  }
  return s;
}

// 点踩内置原因（3 项），支持用户自定义补充
const DISLIKE_REASONS = ['与问题无关', '结论不完整', '答案错误'];

// 检测当前是否为深色主题：优先读 webview body 的主题 class，兜底按编辑器背景亮度判断
function detectDarkTheme(): boolean {
  const cls = document.body.classList;
  if (cls.contains('vscode-light')) return false;
  if (cls.contains('vscode-dark') || cls.contains('vscode-high-contrast')) return true;
  const raw = getComputedStyle(document.body)
    .getPropertyValue('--vscode-editor-background')
    .trim()
    .replace('#', '');
  if (/^[0-9a-f]{6}$/i.test(raw)) {
    const r = parseInt(raw.slice(0, 2), 16);
    const g = parseInt(raw.slice(2, 4), 16);
    const b = parseInt(raw.slice(4, 6), 16);
    return (r * 299 + g * 587 + b * 114) / 1000 < 128;
  }
  return true;
}

// 跟随 VS Code 明暗主题切换的高亮配色
function useIsDarkTheme(): boolean {
  const [dark, setDark] = useState(true);
  useEffect(() => {
    const update = () => setDark(detectDarkTheme());
    update();
    // 主题切换时 VS Code 会更新 body 上的主题 class
    const obs = new MutationObserver(update);
    obs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  return dark;
}

// 递归提取 React 子节点的纯文本（code 组件的 children 可能是嵌套数组）
function nodeToText(node: unknown): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(nodeToText).join('');
  if (typeof node === 'object' && 'props' in (node as Record<string, unknown>)) {
    return nodeToText((node as { props?: { children?: unknown } }).props?.children);
  }
  return '';
}

// 块级代码：语言标签 + 复制按钮 + 语法高亮
function CodeBlock({ language, code }: { language: string; code: string }) {
  const isDark = useIsDarkTheme();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      // webview 剪贴板 API 不可用时回退到 execCommand
      const ta = document.createElement('textarea');
      ta.value = code;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="code-block">
      <div className="code-block-header">
        <span className="code-lang">{language || 'text'}</span>
        <button
          className={`code-copy-btn${copied ? ' copied' : ''}`}
          onClick={handleCopy}
          title="复制代码"
        >
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      {language in LANGS ? (
        <SyntaxHighlighter
          language={language}
          style={isDark ? oneDark : oneLight}
          customStyle={{
            margin: 0,
            padding: '10px 12px',
            background: 'transparent',
            border: 'none',
            borderRadius: 0,
            fontSize: '12px',
            whiteSpace: 'pre-wrap',
            wordWrap: 'break-word',
          }}
        >
          {code}
        </SyntaxHighlighter>
      ) : (
        <pre className="code-plain">{code}</pre>
      )}
    </div>
  );
}

export function ChatMessageView({
  msg,
  onFeedback,
  onOpenLink,
  feedbackError,
}: {
  msg: ChatMessage;
  onFeedback?: (msgId: string, feedback: 'like' | 'dislike', reason?: string) => void;
  onOpenLink?: (url: string, kind?: 'web' | 'doc') => void;
  feedbackError?: string | null;
}) {
  const [showReason, setShowReason] = useState(false);
  const [selectedReasons, setSelectedReasons] = useState<string[]>([]);
  const [customReason, setCustomReason] = useState('');
  // P1-4: 节流锁，500ms 内的重复点击被忽略，避免连点产生冗余事件
  const submittingRef = useRef(false);

  // 切换消息时重置内部状态
  useEffect(() => {
    setShowReason(false);
    setSelectedReasons([]);
    setCustomReason('');
  }, [msg.msgId]);

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

  const hasError = feedbackError === msg.msgId;

  return (
    <div className={`message ${msg.role}${msg.error ? ' error' : ''}`}>
      <div className="bubble">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{
            a: ({ node, href, children, ...props }) => {
              const cleanedHref = href ? cleanUrl(href) : href;
              if (!cleanedHref) {
                return <a {...props}>{children}</a>;
              }
              // http(s)/mailto 等网页链接走浏览器；file://、本地 .md 路径等文档链接走 IDE 内预览
              const isWeb = /^(https?|mailto|ftp):/i.test(cleanedHref);
              return (
                <a
                  href={cleanedHref}
                  className={isWeb ? 'ext-link' : 'doc-link'}
                  title={isWeb ? '在浏览器中打开' : '在 IDE 中预览文档'}
                  {...props}
                  onClick={(e) => {
                    e.preventDefault();
                    onOpenLink?.(cleanedHref, isWeb ? 'web' : 'doc');
                  }}
                >
                  {children}
                </a>
              );
            },
            // 块级代码由下方 code 组件接管渲染，pre 仅透传避免 pre 嵌套
            pre: ({ children }) => <>{children}</>,
            code: ({ node, className, children, ...props }) => {
              const text = nodeToText(children).replace(/\n$/, '');
              const match = /language-([\w-]+)/.exec(className || '');
              // 无语言标注但含换行同样视为块级代码
              if (!match && !text.includes('\n')) {
                return (
                  <code className={className} {...props}>
                    {children}
                  </code>
                );
              }
              return <CodeBlock language={match ? match[1].toLowerCase() : ''} code={text} />;
            },
          }}
        >
          {wrapBareUrls(msg.content)}
        </ReactMarkdown>
      </div>
      {msg.source && !msg.error && (
        <div className="source">
          来源: {msg.source.doc_name} · 得分 {msg.source.score.toFixed(4)}
        </div>
      )}
      {canFeedback && (
        <div className="feedback-bar">
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
        </div>
      )}
    </div>
  );
}
