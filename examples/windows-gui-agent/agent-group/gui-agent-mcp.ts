/**
 * Dependency-free stdio MCP bridge for the operator-managed Windows GUI agent.
 *
 * This file is copied into a GUI worker's read-only /workspace/agent mount.
 * Keeping the HTTP bridge in the example prevents Windows-specific desktop
 * control from becoming a platform-core capability.
 */
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

const DEFAULT_BASE_URL = 'http://192.168.66.31:8000';
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;
const MCP_PROTOCOL_VERSION = '2024-11-05';

type JsonObject = Record<string, unknown>;
type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
type ToolResult = { content: ToolContent[]; isError?: boolean };

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: JsonObject;
}

interface HttpResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<HttpResponse>;

function normalizeBaseUrl(raw: string): string {
  const parsed = new URL(raw);
  if (parsed.protocol !== 'http:') throw new Error('GUI_AGENT_BASE_URL must use http://');
  if (parsed.username || parsed.password) throw new Error('GUI_AGENT_BASE_URL must not contain credentials');
  if (parsed.search || parsed.hash) throw new Error('GUI_AGENT_BASE_URL must not contain a query or fragment');
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new Error('GUI_AGENT_BASE_URL must not contain a path');
  }
  parsed.pathname = '';
  return parsed.toString().replace(/\/+$/, '');
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function finiteCoordinate(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 100_000) {
    throw new Error(`${name} must be a finite coordinate`);
  }
  return value;
}

function boundedString(value: unknown, name: string, maxLength: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0) || value.length > maxLength) {
    throw new Error(`${name} must be a${allowEmpty ? '' : ' non-empty'} string up to ${maxLength} characters`);
  }
  return value;
}

function contentLength(headers: HttpResponse['headers']): number | undefined {
  const raw = headers.get('content-length');
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export class GuiAgentClient {
  readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  private async request(pathname: string, query: Record<string, string | number> = {}, maxBytes = MAX_JSON_BYTES) {
    const url = new URL(pathname, `${this.baseUrl}/`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));

    const response = await this.fetchImpl(url, {
      method: 'GET',
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { accept: 'application/json, image/png' },
    });
    const declaredLength = contentLength(response.headers);
    if (declaredLength !== undefined && declaredLength > maxBytes) {
      throw new Error(`GUI agent response exceeds ${maxBytes} bytes`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) throw new Error(`GUI agent response exceeds ${maxBytes} bytes`);
    if (!response.ok) {
      const detail = buffer.toString('utf8').slice(0, 500);
      throw new Error(`GUI agent HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    return { buffer, contentType: response.headers.get('content-type') || '' };
  }

  async json(pathname: string, query: Record<string, string | number> = {}): Promise<unknown> {
    const { buffer } = await this.request(pathname, query);
    try {
      return JSON.parse(buffer.toString('utf8'));
    } catch {
      throw new Error('GUI agent returned invalid JSON');
    }
  }

  async screenshot(): Promise<{ data: string; mimeType: string }> {
    const { buffer, contentType } = await this.request('/screenshot', {}, MAX_SCREENSHOT_BYTES);
    const mimeType = contentType.split(';', 1)[0]?.trim() || 'image/png';
    if (mimeType !== 'image/png') throw new Error(`GUI agent returned unsupported screenshot type: ${mimeType}`);
    return { data: buffer.toString('base64'), mimeType };
  }
}

const TOOL_DEFINITIONS = [
  {
    name: 'gui_health',
    description: 'Check whether the configured Windows GUI agent is reachable.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'gui_screen_size',
    description: 'Read the Windows desktop screen dimensions.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'gui_observe',
    description: 'Read the current Windows accessibility tree and optionally capture a screenshot.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        max_depth: { type: 'integer', minimum: 1, maximum: 10, default: 6 },
        max_children_per_node: { type: 'integer', minimum: 1, maximum: 500, default: 200 },
        scope: { type: 'string', enum: ['foreground', 'desktop'], default: 'foreground' },
        include_screenshot: { type: 'boolean', default: true },
      },
    },
  },
  {
    name: 'gui_find_element',
    description: 'Find a Windows accessibility element by partial name and/or UIAutomation control type.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', maxLength: 256 },
        control_type: { type: 'string', maxLength: 64 },
        depth: { type: 'integer', minimum: 1, maximum: 10, default: 5 },
      },
    },
  },
  {
    name: 'gui_click',
    description: 'Click a Windows desktop coordinate once.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['x', 'y'],
      properties: { x: { type: 'number' }, y: { type: 'number' } },
    },
  },
  {
    name: 'gui_double_click',
    description: 'Double-click a Windows desktop coordinate.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['x', 'y'],
      properties: { x: { type: 'number' }, y: { type: 'number' } },
    },
  },
  {
    name: 'gui_move_mouse',
    description: 'Move the Windows mouse pointer to a desktop coordinate.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['x', 'y'],
      properties: { x: { type: 'number' }, y: { type: 'number' } },
    },
  },
  {
    name: 'gui_type',
    description: 'Type text into the currently focused Windows control.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['text'],
      properties: { text: { type: 'string', minLength: 1, maxLength: 4000 } },
    },
  },
  {
    name: 'gui_run_exe',
    description: 'Launch an operator-approved executable path on Windows.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: { path: { type: 'string', minLength: 1, maxLength: 1024 } },
    },
  },
] as const;

function textResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

export async function callGuiTool(client: GuiAgentClient, name: string, args: JsonObject = {}): Promise<ToolResult> {
  try {
    switch (name) {
      case 'gui_health':
        return textResult(await client.json('/health'));
      case 'gui_screen_size':
        return textResult(await client.json('/screen_size'));
      case 'gui_observe': {
        const maxDepth = boundedInteger(args.max_depth, 6, 1, 10, 'max_depth');
        const maxChildren = boundedInteger(args.max_children_per_node, 200, 1, 500, 'max_children_per_node');
        const scope = args.scope === undefined ? 'foreground' : boundedString(args.scope, 'scope', 16);
        if (scope !== 'foreground' && scope !== 'desktop') {
          throw new Error('scope must be foreground or desktop');
        }
        if (args.include_screenshot !== undefined && typeof args.include_screenshot !== 'boolean') {
          throw new Error('include_screenshot must be a boolean');
        }
        const tree = await client.json('/a11y_tree', {
          max_depth: maxDepth,
          max_children_per_node: maxChildren,
          scope,
        });
        const content: ToolContent[] = [{ type: 'text', text: JSON.stringify(tree) }];
        if (args.include_screenshot !== false) {
          const screenshot = await client.screenshot();
          content.push({ type: 'image', ...screenshot });
        }
        return { content };
      }
      case 'gui_find_element': {
        const elementName = args.name === undefined ? '' : boundedString(args.name, 'name', 256, true);
        const controlType =
          args.control_type === undefined ? '' : boundedString(args.control_type, 'control_type', 64, true);
        if (!elementName && !controlType) throw new Error('name or control_type is required');
        return textResult(
          await client.json('/a11y_element', {
            name: elementName,
            control_type: controlType,
            depth: boundedInteger(args.depth, 5, 1, 10, 'depth'),
          }),
        );
      }
      case 'gui_click':
      case 'gui_double_click':
      case 'gui_move_mouse': {
        const endpoint = `/${name.slice(4)}`;
        return textResult(
          await client.json(endpoint, {
            x: finiteCoordinate(args.x, 'x'),
            y: finiteCoordinate(args.y, 'y'),
          }),
        );
      }
      case 'gui_type':
        return textResult(await client.json('/type', { text: boundedString(args.text, 'text', 4000) }));
      case 'gui_run_exe':
        return textResult(await client.json('/run_exe', { path: boundedString(args.path, 'path', 1024) }));
      default:
        return { content: [{ type: 'text', text: `Unknown GUI tool: ${name}` }], isError: true };
    }
  } catch (error) {
    return {
      content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      isError: true,
    };
  }
}

function rpcResult(id: JsonRpcRequest['id'], result: unknown): JsonObject {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: JsonRpcRequest['id'], code: number, message: string): JsonObject {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

export async function dispatchMcpRequest(
  client: GuiAgentClient,
  request: JsonRpcRequest,
): Promise<JsonObject | undefined> {
  if (request.id === undefined && request.method?.startsWith('notifications/')) return undefined;
  switch (request.method) {
    case 'initialize':
      return rpcResult(request.id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'agentdesk-windows-gui', version: '1.0.0' },
      });
    case 'ping':
      return rpcResult(request.id, {});
    case 'tools/list':
      return rpcResult(request.id, { tools: TOOL_DEFINITIONS });
    case 'tools/call': {
      const toolName = request.params?.name;
      const rawArgs = request.params?.arguments;
      if (typeof toolName !== 'string') return rpcError(request.id, -32602, 'Tool name is required');
      if (rawArgs !== undefined && (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs))) {
        return rpcError(request.id, -32602, 'Tool arguments must be an object');
      }
      return rpcResult(request.id, await callGuiTool(client, toolName, (rawArgs as JsonObject) || {}));
    }
    default:
      return rpcError(request.id, -32601, `Method not found: ${request.method || ''}`);
  }
}

export async function startServer(): Promise<void> {
  const baseUrl = process.env.GUI_AGENT_BASE_URL?.trim() || DEFAULT_BASE_URL;
  const timeoutRaw = Number(process.env.GUI_AGENT_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const timeoutMs =
    Number.isFinite(timeoutRaw) && timeoutRaw >= 1_000 && timeoutRaw <= 120_000
      ? Math.floor(timeoutRaw)
      : DEFAULT_TIMEOUT_MS;
  const client = new GuiAgentClient(baseUrl, fetch, timeoutMs);
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line) as JsonRpcRequest;
    } catch {
      process.stdout.write(`${JSON.stringify(rpcError(null, -32700, 'Parse error'))}\n`);
      continue;
    }
    const response = await dispatchMcpRequest(client, request);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().catch((error) => {
    console.error(`[windows-gui-mcp] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
