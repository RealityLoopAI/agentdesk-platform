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

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="compact" className="shrink-0">
          <Plus aria-hidden="true" className="size-4" />
          新会话
        </Button>
      </DialogTrigger>
      <DialogContent
        onCloseAutoFocus={(event) => {
          if (create.isPending) event.preventDefault();
        }}
      >
        <DialogTitle>选择 Agent</DialogTitle>
        <DialogDescription>新会话只会列出你目前有权限访问的 Agent。创建后会获得独立的用户会话 Lane。</DialogDescription>
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
              Agent
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
                {create.isPending ? '正在创建…' : '创建会话'}
              </Button>
            </div>
          </form>
        ) : (
          <div className="mt-6 rounded-md bg-brand-subtle p-4 text-sm leading-6 text-muted">
            当前没有可用 Agent。请联系管理员为你的账号分配 Agent Group 权限。
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
