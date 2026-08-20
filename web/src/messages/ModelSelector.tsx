import { Check, ChevronDown, Zap } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

import { cn } from '@/lib/cn';
import { MODEL_OPTIONS, type ModelOptionId } from '@/messages/modelOptions';

interface ModelSelectorProps {
  disabled?: boolean;
  selectedId: ModelOptionId;
  onChange: (modelId: ModelOptionId) => void;
}

export function ModelSelector({ disabled = false, selectedId, onChange }: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const selectedIndex = Math.max(
    0,
    MODEL_OPTIONS.findIndex((model) => model.id === selectedId),
  );
  const [activeIndex, setActiveIndex] = useState(selectedIndex);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const options = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = `model-listbox-${useId()}`;
  const selectedModel = MODEL_OPTIONS[selectedIndex];

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => options.current[activeIndex]?.focus());
    return () => cancelAnimationFrame(frame);
  }, [activeIndex, open]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer);
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const openList = () => {
    if (disabled) return;
    setActiveIndex(selectedIndex);
    setOpen(true);
  };

  const closeAndRestoreFocus = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  const select = (modelId: ModelOptionId) => {
    onChange(modelId);
    closeAndRestoreFocus();
  };

  const onTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      openList();
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      closeAndRestoreFocus();
    }
  };

  const onOptionKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index + 1) % MODEL_OPTIONS.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index - 1 + MODEL_OPTIONS.length) % MODEL_OPTIONS.length);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActiveIndex(MODEL_OPTIONS.length - 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeAndRestoreFocus();
    } else if (event.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div ref={root} className="relative min-w-0">
      {open ? (
        <div
          id={listboxId}
          role="listbox"
          aria-label="模型列表"
          aria-activedescendant={`${listboxId}-option-${activeIndex}`}
          className="absolute bottom-[calc(100%+0.5rem)] left-0 z-30 w-[min(20rem,calc(100vw-3rem))] rounded-xl border border-line bg-surface p-1.5 shadow-[var(--shadow-panel)]"
        >
          {MODEL_OPTIONS.map((model, index) => {
            const selected = model.id === selectedId;
            return (
              <button
                key={model.id}
                ref={(element) => {
                  options.current[index] = element;
                }}
                id={`${listboxId}-option-${index}`}
                type="button"
                role="option"
                aria-selected={selected}
                tabIndex={activeIndex === index ? 0 : -1}
                className={cn(
                  'flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors',
                  selected ? 'bg-brand-subtle text-ink' : 'text-ink hover:bg-brand-subtle/65',
                )}
                onFocus={() => setActiveIndex(index)}
                onKeyDown={(event) => onOptionKeyDown(event, index)}
                onClick={() => select(model.id)}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{model.label}</span>
                  <span className="block truncate text-xs text-muted">{model.description}</span>
                </span>
                <Check
                  aria-hidden="true"
                  className={cn('size-4 shrink-0 text-brand', selected ? 'opacity-100' : 'opacity-0')}
                />
              </button>
            );
          })}
        </div>
      ) : null}

      <button
        ref={trigger}
        type="button"
        aria-label={`选择模型，当前：${selectedModel.label}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        disabled={disabled}
        className="inline-flex h-9 max-w-[min(13rem,calc(100vw-6rem))] min-w-0 items-center gap-2 rounded-full border border-line bg-surface px-3 text-sm font-semibold text-ink transition-colors hover:border-brand-border hover:bg-brand-subtle disabled:cursor-not-allowed disabled:opacity-50 sm:max-w-60"
        onKeyDown={onTriggerKeyDown}
        onClick={() => (open ? setOpen(false) : openList())}
      >
        <Zap aria-hidden="true" className="size-4 shrink-0 fill-current text-brand" />
        <span className="truncate">{selectedModel.label}</span>
        <ChevronDown
          aria-hidden="true"
          className={cn('size-4 shrink-0 text-muted transition-transform', open && 'rotate-180')}
        />
      </button>
    </div>
  );
}
