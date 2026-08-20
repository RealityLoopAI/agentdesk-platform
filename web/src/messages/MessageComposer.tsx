import { SendHorizontal } from 'lucide-react';
import { useRef, useState, type KeyboardEvent } from 'react';

import { Button } from '@/components/ui/Button';
import { ModelSelector } from '@/messages/ModelSelector';
import { DEFAULT_MODEL_OPTION_ID, type ModelOptionId } from '@/messages/modelOptions';

export function MessageComposer({ disabled, onSend }: { disabled?: boolean; onSend: (text: string) => void }) {
  const [text, setText] = useState('');
  const [selectedModelId, setSelectedModelId] = useState<ModelOptionId>(DEFAULT_MODEL_OPTION_ID);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const submit = () => {
    const normalized = text.trim();
    if (!normalized || disabled) return;
    onSend(normalized);
    setText('');
    requestAnimationFrame(() => textarea.current?.focus());
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="border-t border-line bg-surface p-3 sm:p-4">
      <div className="mx-auto max-w-4xl rounded-lg border border-line bg-surface p-2 shadow-sm focus-within:border-brand-border">
        <label htmlFor="message-composer" className="sr-only">
          输入消息
        </label>
        <textarea
          ref={textarea}
          id="message-composer"
          rows={2}
          maxLength={8_000}
          value={text}
          disabled={disabled}
          placeholder="给 Agent 发送消息…"
          className="max-h-40 min-h-14 w-full resize-none bg-transparent px-2 py-1 text-[15px] leading-6 text-ink outline-none placeholder:text-muted/75"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="flex items-center justify-between gap-2 px-1 pt-1">
          <div className="flex min-w-0 items-center gap-3">
            <ModelSelector disabled={disabled} selectedId={selectedModelId} onChange={setSelectedModelId} />
            <span className="hidden whitespace-nowrap text-xs text-muted md:inline">
              Enter 发送 · Shift + Enter 换行
            </span>
          </div>
          <Button
            size="icon"
            aria-label="发送消息"
            className="shrink-0"
            disabled={disabled || !text.trim()}
            onClick={submit}
          >
            <SendHorizontal aria-hidden="true" className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
