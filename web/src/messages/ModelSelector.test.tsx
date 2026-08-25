import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { ModelSelector } from '@/messages/ModelSelector';
import { DEFAULT_MODEL_OPTION_ID, type ModelOptionId } from '@/messages/modelOptions';

function StatefulSelector({ disabled = false }: { disabled?: boolean }) {
  const [selectedId, setSelectedId] = useState<ModelOptionId>(DEFAULT_MODEL_OPTION_ID);
  return (
    <div>
      <ModelSelector disabled={disabled} selectedId={selectedId} onChange={setSelectedId} />
      <button type="button">列表外按钮</button>
    </div>
  );
}

describe('ModelSelector', () => {
  it('shows every model, updates the trigger, and preserves the selected option while mounted', async () => {
    const user = userEvent.setup();
    render(<StatefulSelector />);

    const trigger = screen.getByRole('button', { name: '选择模型，当前：自动选择' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await user.click(trigger);
    const listbox = screen.getByRole('listbox', { name: '模型列表' });
    expect(within(listbox).getAllByRole('option')).toHaveLength(6);
    expect(within(listbox).getByRole('option', { name: /自动选择/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByText(/界面预览|暂不影响实际模型/)).not.toBeInTheDocument();

    await user.click(within(listbox).getByRole('option', { name: /Claude Opus 5/ }));
    expect(screen.queryByRole('listbox', { name: '模型列表' })).not.toBeInTheDocument();

    const updatedTrigger = screen.getByRole('button', { name: '选择模型，当前：Claude Opus 5' });
    await user.click(updatedTrigger);
    expect(screen.getByRole('option', { name: /Claude Opus 5/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('supports keyboard selection and restores focus after Escape', async () => {
    const user = userEvent.setup();
    render(<StatefulSelector />);

    const trigger = screen.getByRole('button', { name: '选择模型，当前：自动选择' });
    trigger.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(screen.getByRole('option', { name: /自动选择/ })).toHaveFocus());

    await user.keyboard('{ArrowDown}');
    await waitFor(() => expect(screen.getByRole('option', { name: /GPT-5.6 Sol/ })).toHaveFocus());
    await user.keyboard('{Enter}');

    const updatedTrigger = screen.getByRole('button', { name: '选择模型，当前：GPT-5.6 Sol' });
    await waitFor(() => expect(updatedTrigger).toHaveFocus());
    await user.keyboard(' ');
    await waitFor(() => expect(screen.getByRole('option', { name: /GPT-5.6 Sol/ })).toHaveFocus());
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('listbox', { name: '模型列表' })).not.toBeInTheDocument();
    await waitFor(() => expect(updatedTrigger).toHaveFocus());
  });

  it('closes on an outside pointer and closes when disabled', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<StatefulSelector />);

    const trigger = screen.getByRole('button', { name: '选择模型，当前：自动选择' });
    await user.click(trigger);
    await user.click(screen.getByRole('button', { name: '列表外按钮' }));
    expect(screen.queryByRole('listbox', { name: '模型列表' })).not.toBeInTheDocument();

    await user.click(trigger);
    expect(screen.getByRole('listbox', { name: '模型列表' })).toBeInTheDocument();
    rerender(<StatefulSelector disabled />);

    await waitFor(() => expect(screen.queryByRole('listbox', { name: '模型列表' })).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: '选择模型，当前：自动选择' })).toBeDisabled();
  });
});
