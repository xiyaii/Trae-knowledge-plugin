import { useState, useRef, useEffect } from 'react';

interface Props {
  onSend: (query: string) => void;
  disabled: boolean;
}

export function InputBox({ onSend, disabled }: Props) {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  // IME 合成状态：中文输入法选词期间为 true，避免 Enter 误发送
  const composingRef = useRef(false);

  useEffect(() => {
    if (ref.current) {
      ref.current.style.height = 'auto';
      ref.current.style.height = Math.min(ref.current.scrollHeight, 120) + 'px';
    }
  }, [value]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // 合成期间（中文输入法选词）不处理 Enter
    if (composingRef.current) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (value.trim() && !disabled) {
        onSend(value);
        setValue('');
      }
    }
  };

  return (
    <div className="input-area">
      <textarea
        ref={ref}
        className="input-box"
        placeholder="输入问题，Enter 发送，Shift+Enter 换行"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => { composingRef.current = false; }}
        rows={1}
      />
      <button
        className="send-btn"
        onClick={() => {
          if (value.trim() && !disabled) {
            onSend(value);
            setValue('');
          }
        }}
        disabled={disabled || !value.trim()}
      >
        发送
      </button>
    </div>
  );
}
