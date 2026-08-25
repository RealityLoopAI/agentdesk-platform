import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveSkillSource } from './claude-md-compose.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): { groupDir: string; sharedDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdesk-skill-source-'));
  roots.push(root);
  const groupDir = path.join(root, 'group');
  const sharedDir = path.join(root, 'shared');
  fs.mkdirSync(groupDir, { recursive: true });
  fs.mkdirSync(sharedDir, { recursive: true });
  return { groupDir, sharedDir };
}

function addSkill(directory: string, name: string, content: string): void {
  const skillDir = path.join(directory, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'instructions.md'), content);
}

describe('group-private Skill resolution', () => {
  it('prefers a group-private Skill over a shared Skill with the same name', () => {
    const { groupDir, sharedDir } = fixture();
    addSkill(sharedDir, 'lookup', 'shared');
    addSkill(path.join(groupDir, 'skills'), 'lookup', 'private');

    expect(resolveSkillSource(groupDir, sharedDir, 'lookup')).toEqual({
      hostDir: path.join(groupDir, 'skills', 'lookup'),
      containerDir: '/workspace/agent/skills/lookup',
    });
  });

  it('falls back to a shared Skill and rejects invalid or missing names', () => {
    const { groupDir, sharedDir } = fixture();
    addSkill(sharedDir, 'lookup', 'shared');

    expect(resolveSkillSource(groupDir, sharedDir, 'lookup')).toEqual({
      hostDir: path.join(sharedDir, 'lookup'),
      containerDir: '/app/skills/lookup',
    });
    expect(resolveSkillSource(groupDir, sharedDir, '../escape')).toBeNull();
    expect(resolveSkillSource(groupDir, sharedDir, 'missing')).toBeNull();
  });
});
