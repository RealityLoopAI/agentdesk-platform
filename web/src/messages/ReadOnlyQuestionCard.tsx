import { CheckCircle2, CircleHelp } from 'lucide-react';

import type { HistoryMessage } from '@/api/types';

type ReadOnlyQuestionPresentation = NonNullable<HistoryMessage['presentation']>;

function statusText(presentation: ReadOnlyQuestionPresentation, sourceChannel: string | null): string {
  switch (presentation.state) {
    case 'answered':
      return presentation.selectedLabel ? `已选择：${presentation.selectedLabel}` : '已回答';
    case 'cancelled':
      return '已取消';
    case 'closed':
      return '已关闭';
    case 'awaiting-external-response':
      return sourceChannel === 'feishu' ? '请在飞书端完成选择' : 'Web 端仅供查看';
  }
}

export function ReadOnlyQuestionCard({
  presentation,
  sourceChannel,
}: {
  presentation: ReadOnlyQuestionPresentation;
  sourceChannel: string | null;
}) {
  const terminal = presentation.state !== 'awaiting-external-response';
  return (
    <section
      aria-label={`只读问题卡片：${presentation.title}`}
      className="overflow-hidden rounded-xl border border-brand-border bg-surface shadow-sm"
    >
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line bg-brand-subtle px-4 py-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-ink">
          <CircleHelp aria-hidden="true" className="size-4 text-brand" />
          {presentation.title}
        </h3>
        <span className="rounded-full bg-surface px-2.5 py-1 text-xs font-medium text-muted">只读</span>
      </header>
      <div className="space-y-4 px-4 py-4">
        <p className="text-sm leading-6 whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">
          {presentation.question}
        </p>
        <ul aria-label="问题选项" className="space-y-2">
          {presentation.options.map((option, index) => (
            <li
              key={`${index}:${option.label}`}
              className={
                option.selected
                  ? 'flex min-w-0 items-start gap-2 rounded-lg border border-brand-border bg-brand-subtle px-3 py-2.5 text-sm font-medium text-ink'
                  : 'min-w-0 rounded-lg border border-line bg-canvas px-3 py-2.5 text-sm text-muted'
              }
            >
              {option.selected ? (
                <CheckCircle2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-brand" />
              ) : null}
              <span className="[overflow-wrap:anywhere]">{option.label}</span>
            </li>
          ))}
        </ul>
        <p className={terminal ? 'text-xs font-medium text-ink' : 'text-xs font-medium text-brand'}>
          {statusText(presentation, sourceChannel)}
        </p>
      </div>
    </section>
  );
}
