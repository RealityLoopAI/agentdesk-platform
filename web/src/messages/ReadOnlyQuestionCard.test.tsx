import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ReadOnlyQuestionCard } from './ReadOnlyQuestionCard';

describe('ReadOnlyQuestionCard', () => {
  it('renders an accessible Feishu-only card without answer controls or raw JSON', () => {
    const { container } = render(
      <ReadOnlyQuestionCard
        sourceChannel="feishu"
        presentation={{
          type: 'ask-question',
          mode: 'read-only',
          title: '设备仪器字段需要确认',
          question: '请选择设备仪器。',
          options: [
            { label: '力辰科技', selected: false },
            { label: '链路测试', selected: false },
          ],
          state: 'awaiting-external-response',
          selectedLabel: null,
          responseChannel: null,
        }}
      />,
    );

    expect(screen.getByRole('heading', { name: '设备仪器字段需要确认' })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: '问题选项' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('请在飞书端完成选择')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(container).not.toHaveTextContent('"type":"ask_question"');
  });

  it('highlights only the externally selected option and reports the terminal state', () => {
    render(
      <ReadOnlyQuestionCard
        sourceChannel="feishu"
        presentation={{
          type: 'ask-question',
          mode: 'read-only',
          title: '设备仪器字段需要确认',
          question: '请选择设备仪器。',
          options: [
            { label: '力辰科技', selected: false },
            { label: '链路测试', selected: true },
          ],
          state: 'answered',
          selectedLabel: '链路测试',
          responseChannel: 'feishu',
        }}
      />,
    );

    expect(screen.getByText('已选择：链路测试')).toBeInTheDocument();
    expect(screen.getByText('链路测试').closest('li')).toHaveClass('bg-brand-subtle');
    expect(screen.getByText('力辰科技').closest('li')).not.toHaveClass('bg-brand-subtle');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
