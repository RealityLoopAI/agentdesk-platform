import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { buildEffectiveSystemInstructions, loadWorkspaceInstructions } from './workspace-instructions.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; workspace: string; app: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdesk-workspace-instructions-'));
  roots.push(root);
  const workspace = path.join(root, 'workspace');
  const app = path.join(root, 'app');
  fs.mkdirSync(path.join(workspace, '.claude-fragments'), { recursive: true });
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, 'base.md'), '# Shared base\n');
  fs.writeFileSync(path.join(workspace, '.claude-fragments', 'module.md'), 'Use classify_intent before routing.\n');
  fs.writeFileSync(path.join(workspace, '.claude-fragments', 'skill.md'), 'Use vision-archive-query.\n');
  fs.writeFileSync(
    path.join(workspace, 'CLAUDE.md'),
    ['@../app/base.md', '@./.claude-fragments/module.md', '@./.claude-fragments/skill.md', ''].join('\n'),
  );
  fs.writeFileSync(path.join(workspace, 'CLAUDE.local.md'), 'Route experiment reports to archive.\n');
  return { root, workspace, app };
}

describe('provider-neutral workspace instructions', () => {
  it('expands composed imports and group-local instructions for non-native providers', () => {
    const { workspace, app } = fixture();
    const prompt = buildEffectiveSystemInstructions({
      cwd: workspace,
      runtimeInstructions: 'Runtime destinations: archive.',
      loadsWorkspaceInstructionsNatively: false,
      allowedRoots: [workspace, app],
    });
    expect(prompt).toContain('Shared base');
    expect(prompt).toContain('classify_intent');
    expect(prompt).toContain('vision-archive-query');
    expect(prompt).toContain('Route experiment reports to archive');
    expect(prompt).toContain('Runtime destinations: archive');
  });

  it('keeps native-loading providers on the runtime addendum without duplication', () => {
    const prompt = buildEffectiveSystemInstructions({
      cwd: '/does/not/need/to/exist',
      runtimeInstructions: 'Runtime only.',
      loadsWorkspaceInstructionsNatively: true,
    });
    expect(prompt).toBe('Runtime only.');
  });

  it('rejects cycles, imports outside trusted roots, and oversized prompts', () => {
    const { root, workspace, app } = fixture();
    fs.writeFileSync(path.join(workspace, 'cycle-a.md'), '@./cycle-b.md\n');
    fs.writeFileSync(path.join(workspace, 'cycle-b.md'), '@./cycle-a.md\n');
    fs.writeFileSync(path.join(workspace, 'CLAUDE.md'), '@./cycle-a.md\n');
    expect(() => loadWorkspaceInstructions({ cwd: workspace, allowedRoots: [workspace, app] })).toThrow(/import cycle/);

    const outside = path.join(root, 'outside.md');
    fs.writeFileSync(outside, 'outside');
    fs.writeFileSync(path.join(workspace, 'CLAUDE.md'), '@../outside.md\n');
    expect(() => loadWorkspaceInstructions({ cwd: workspace, allowedRoots: [workspace, app] })).toThrow(
      /outside trusted roots/,
    );

    fs.writeFileSync(path.join(workspace, 'CLAUDE.md'), '0123456789');
    expect(() => loadWorkspaceInstructions({ cwd: workspace, allowedRoots: [workspace, app], maxBytes: 5 })).toThrow(
      /exceed/,
    );
  });
});
