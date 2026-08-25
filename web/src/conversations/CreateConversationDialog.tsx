import { Plus } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { AgentGroupSummary } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '@/components/ui/Dialog';
import { useCreateConversation } from './useConversations';

export function CreateConversationDialog({ agentGroups }: { agentGroups: AgentGroupSummary[] }) {
  const [open, setOpen] = useState(false);
  const [agentGroupId, setAgentGroupId] = useState(agentGroups[0]?.id ?? '');
  const create = useCreateConversation();

  useEffect(() => {
    if (!agentGroups.some((group) => group.id === agentGroupId)) {
      setAgentGroupId(agentGroups[0]?.id ?? '');
    }
  }, [agentGroupId, agentGroups]);

  if (agentGroups.length === 1) {
    const onlyAssistant = agentGroups[0]!;
    return (
      <span className="flex flex-col items-end">
        <Button
          variant="secondary"
          size="compact"
          className="shrink-0"
          disabled={create.isPending}
          onClick={() => create.mutate(onlyAssistant.id)}
        >
          <Plus aria-hidden="true" className="size-4" />
          {create.isPending ? '正在新建…' : '新建 Web 对话'}
        </Button>
        {create.isError ? (
          <span role="alert" className="mt-1 max-w-48 text-right text-xs text-danger">
            无法新建，请刷新权限后重试。
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="secondary" size="compact" className="shrink-0">
          <Plus aria-hidden="true" className="size-4" />
          新建 Web 对话
        </Button>
      </DialogTrigger>
      <DialogContent
        onCloseAutoFocus={(event) => {
          if (create.isPending) event.preventDefault();
        }}
      >
        <DialogTitle>{agentGroups.length === 0 ? '暂时无法新建对话' : '选择助手'}</DialogTitle>
        <DialogDescription>
          {agentGroups.length === 0
            ? '当前没有可用助手，请联系管理员为你的账号分配权限。'
            : '这里仅列出你当前有权使用的助手，新对话会与飞书已有对话分开保存。'}
        </DialogDescription>
        {agentGroups.length > 0 ? (
          <form
            className="mt-6"
            onSubmit={(event) => {
              event.preventDefault();
              if (!agentGroupId) return;
              create.mutate(agentGroupId, { onSuccess: () => setOpen(false) });
            }}
          >
            <label htmlFor="agent-group" className="mb-2 block text-sm font-medium text-ink">
              助手
            </label>
            <select
              id="agent-group"
              value={agentGroupId}
              onChange={(event) => setAgentGroupId(event.target.value)}
              className="h-11 w-full rounded-md border border-line bg-surface px-3 text-sm text-ink"
            >
              {agentGroups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
            {create.isError ? (
              <p role="alert" className="mt-3 text-sm text-danger">
                无法创建会话。你的权限可能刚刚发生变化，请刷新后重试。
              </p>
            ) : null}
            <div className="mt-6 flex justify-end gap-3">
              <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={create.isPending}>
                取消
              </Button>
              <Button type="submit" disabled={!agentGroupId || create.isPending}>
                {create.isPending ? '正在新建…' : '新建对话'}
              </Button>
            </div>
          </form>
        ) : (
          <div className="mt-6 rounded-md bg-brand-subtle p-4 text-sm leading-6 text-muted">
            管理员完成权限分配后，刷新页面即可看到可用助手。
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
