/**
 * Provider-neutral workspace instruction loading.
 *
 * Claude Code loads CLAUDE.md / CLAUDE.local.md itself. Direct API providers
 * do not, so the runner expands the same composed entry point for them before
 * the first model call. Imports are deliberately limited to trusted workspace
 * and application instruction roots.
 */
import fs from 'fs';
import path from 'path';

const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_MAX_DEPTH = 16;
const IMPORT_LINE = /^\s*@(.+?)\s*$/;

export interface WorkspaceInstructionOptions {
  cwd: string;
  runtimeInstructions: string;
  loadsWorkspaceInstructionsNatively: boolean;
  allowedRoots?: string[];
  maxBytes?: number;
  maxDepth?: number;
}

export function buildEffectiveSystemInstructions(options: WorkspaceInstructionOptions): string {
  if (options.loadsWorkspaceInstructionsNatively) return options.runtimeInstructions;
  const workspace = loadWorkspaceInstructions(options);
  return [workspace, options.runtimeInstructions].filter((part) => part.trim()).join('\n\n');
}

export function loadWorkspaceInstructions(
  options: Omit<WorkspaceInstructionOptions, 'runtimeInstructions' | 'loadsWorkspaceInstructionsNatively'>,
): string {
  const cwd = realDirectory(options.cwd, 'workspace instruction directory');
  const configuredRoots = options.allowedRoots ?? [cwd, '/app'];
  const allowedRoots = configuredRoots.map((root) => realDirectory(root, 'workspace instruction root'));
  const maxBytes = boundedPositive(options.maxBytes, DEFAULT_MAX_BYTES, 'maxBytes');
  const maxDepth = boundedPositive(options.maxDepth, DEFAULT_MAX_DEPTH, 'maxDepth');
  const budget = { bytes: 0 };
  const entry = path.join(cwd, 'CLAUDE.md');
  const local = path.join(cwd, 'CLAUDE.local.md');

  const parts = [expandInstructionFile(entry, allowedRoots, budget, maxBytes, maxDepth, [])];
  if (fs.existsSync(local)) {
    parts.push(expandInstructionFile(local, allowedRoots, budget, maxBytes, maxDepth, []));
  }
  return parts.filter((part) => part.trim()).join('\n\n');
}

function expandInstructionFile(
  requestedPath: string,
  allowedRoots: string[],
  budget: { bytes: number },
  maxBytes: number,
  maxDepth: number,
  stack: string[],
): string {
  if (stack.length >= maxDepth) {
    throw new Error(`workspace instruction import depth exceeds ${maxDepth}`);
  }
  let canonical: string;
  try {
    canonical = fs.realpathSync(requestedPath);
  } catch {
    throw new Error(`workspace instruction file is unavailable: ${requestedPath}`);
  }
  if (!allowedRoots.some((root) => isWithin(root, canonical))) {
    throw new Error(`workspace instruction import is outside trusted roots: ${requestedPath}`);
  }
  if (stack.includes(canonical)) {
    throw new Error(`workspace instruction import cycle: ${[...stack, canonical].join(' -> ')}`);
  }
  const stat = fs.statSync(canonical);
  if (!stat.isFile()) throw new Error(`workspace instruction import is not a file: ${requestedPath}`);
  budget.bytes += stat.size;
  if (budget.bytes > maxBytes) {
    throw new Error(`workspace instructions exceed ${maxBytes} bytes`);
  }

  const content = fs.readFileSync(canonical, 'utf8');
  const nextStack = [...stack, canonical];
  return content
    .split(/\r?\n/)
    .map((line) => {
      const match = IMPORT_LINE.exec(line);
      if (!match) return line;
      const specifier = match[1].trim();
      if (!specifier || specifier.includes('\0')) {
        throw new Error(`invalid workspace instruction import in ${canonical}`);
      }
      const imported = path.isAbsolute(specifier)
        ? path.normalize(specifier)
        : path.resolve(path.dirname(canonical), specifier);
      return expandInstructionFile(imported, allowedRoots, budget, maxBytes, maxDepth, nextStack);
    })
    .join('\n');
}

function realDirectory(directory: string, label: string): string {
  let canonical: string;
  try {
    canonical = fs.realpathSync(directory);
  } catch {
    throw new Error(`${label} is unavailable: ${directory}`);
  }
  if (!fs.statSync(canonical).isDirectory()) throw new Error(`${label} is not a directory: ${directory}`);
  return canonical;
}

function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function boundedPositive(value: number | undefined, fallback: number, field: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) throw new Error(`${field} must be a positive integer`);
  return resolved;
}
