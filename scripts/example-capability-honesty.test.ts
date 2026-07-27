import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const PROMPT_PATH = path.join(REPO_ROOT, 'examples', 'lab-frontdesk', 'CLAUDE.local.md');
const README_PATH = path.join(REPO_ROOT, 'examples', 'lab-frontdesk', 'README.md');

const FULL_BITABLE_CRUD_OPERATIONS = [
  'feishu.bitable.field.list',
  'feishu.bitable.record.list',
  'feishu.bitable.record.get',
  'feishu.bitable.record.create',
  'feishu.bitable.record.update',
  'feishu.bitable.record.delete',
] as const;

describe('lab-frontdesk capability honesty', () => {
  const prompt = fs.readFileSync(PROMPT_PATH, 'utf8');
  const readme = fs.readFileSync(README_PATH, 'utf8');

  it('does not claim that the Feishu chat channel directly handles Bitable operations', () => {
    expect(prompt).not.toContain('由飞书 channel 直接处理');
    expect(prompt).not.toContain('无需调网关 `/execute`');
    expect(prompt).toContain('飞书 Channel 只负责接收/发送聊天消息');
    expect(prompt).toContain('多维表格操作只能走 Backend Gateway');
  });

  it('requires live gateway discovery before claiming full Bitable CRUD', () => {
    const gateStart = prompt.indexOf('## 多维表格能力发现闸门');
    expect(gateStart).toBeGreaterThan(-1);
    const gate = prompt.slice(gateStart);

    expect(gate).toContain('gateway_describe');
    expect(gate).toContain('回答“你会不会维护多维表格”之前');
    expect(gate).toContain('不得把');
    expect(gate).toContain('未声明能力');
    for (const operation of FULL_BITABLE_CRUD_OPERATIONS) {
      expect(gate).toContain(operation);
    }
  });

  it('keeps writes behind authorization, idempotency, confirmation, and audit evidence', () => {
    expect(prompt).toContain('gateway_authorize');
    expect(prompt).toContain('gateway_execute');
    expect(prompt).toContain('idempotencyKey');
    expect(prompt).toContain('确认 Obligation');
    expect(prompt).toContain('auditId');
    expect(prompt).toContain('dryRun');
  });

  it('documents Bitable as an optional Gateway capability rather than a channel feature', () => {
    expect(readme).toContain('Bitable CRUD is optional');
    expect(readme).toContain('gateway_describe');
    expect(readme).toContain('the channel never owns Bitable');
  });
});
