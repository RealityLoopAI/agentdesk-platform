import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  callGuiTool,
  dispatchMcpRequest,
  GuiAgentClient,
  type FetchLike,
} from '../examples/windows-gui-agent/agent-group/gui-agent-mcp.js';

function response(
  body: string | Uint8Array,
  options: { ok?: boolean; status?: number; contentType?: string; contentLength?: number } = {},
) {
  const bytes = typeof body === 'string' ? Buffer.from(body) : Buffer.from(body);
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    headers: {
      get(name: string) {
        if (name.toLowerCase() === 'content-type') return options.contentType || 'application/json';
        if (name.toLowerCase() === 'content-length') {
          return String(options.contentLength ?? bytes.byteLength);
        }
        return null;
      },
    },
    async arrayBuffer() {
      return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    },
  };
}

describe('Windows GUI Agent MCP bridge', () => {
  it('pins the operator endpoint to the active WLAN address', () => {
    const configPath = path.resolve('examples/windows-gui-agent/agent-group/container.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      mcpServers: {
        windows_gui: { env: { GUI_AGENT_BASE_URL: string; NO_PROXY: string; no_proxy: string } };
      };
    };
    expect(config.mcpServers.windows_gui.env.GUI_AGENT_BASE_URL).toBe('http://192.168.66.98:8000');
    expect(config.mcpServers.windows_gui.env.NO_PROXY).toBe('192.168.66.98');
    expect(config.mcpServers.windows_gui.env.no_proxy).toBe('192.168.66.98');
  });

  it('enables a complete worker-private GUI operation skill', () => {
    const config = JSON.parse(
      fs.readFileSync(path.resolve('examples/windows-gui-agent/agent-group/container.json'), 'utf8'),
    ) as { skills: string[] };
    const skillRoot = path.resolve('examples/windows-gui-agent/agent-group/skills/operate-windows-gui');
    const skill = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8');
    const instructions = fs.readFileSync(path.join(skillRoot, 'instructions.md'), 'utf8');
    const openai = fs.readFileSync(path.join(skillRoot, 'agents/openai.yaml'), 'utf8');

    expect(config.skills).toEqual(['operate-windows-gui']);
    expect(skill).toContain('name: operate-windows-gui');
    expect(skill).not.toContain('TODO');
    expect(instructions).toContain('gui_observe');
    expect(instructions).toContain('Confirmation boundary');
    expect(instructions).toContain('Claim success only after a fresh observation');
    expect(openai).toContain('$operate-windows-gui');
  });

  it('encodes GUI inputs as query parameters without allowing model-controlled paths', async () => {
    const fetchImpl = vi.fn(async () => response('{"success":true}')) as unknown as FetchLike;
    const client = new GuiAgentClient('http://192.168.66.98:8000', fetchImpl);

    const result = await callGuiTool(client, 'gui_type', { text: '样品 A&B' });

    expect(result.isError).toBeUndefined();
    const requested = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(requested.origin).toBe('http://192.168.66.98:8000');
    expect(requested.pathname).toBe('/type');
    expect(requested.searchParams.get('text')).toBe('样品 A&B');
  });

  it('returns an accessibility tree and PNG screenshot from one observation', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const fetchImpl = vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      if (url.pathname === '/screenshot') {
        return response(png, { contentType: 'image/png' });
      }
      return response('{"success":true,"root":{"name":"Console"}}');
    }) as unknown as FetchLike;
    const client = new GuiAgentClient('http://192.168.66.98:8000', fetchImpl);

    const result = await callGuiTool(client, 'gui_observe', {
      max_depth: 3,
      scope: 'foreground',
      include_screenshot: true,
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toMatchObject({ type: 'text' });
    expect(result.content[1]).toEqual({
      type: 'image',
      data: png.toString('base64'),
      mimeType: 'image/png',
    });
    const treeUrl = new URL(String(fetchImpl.mock.calls[0]?.[0]));
    expect(treeUrl.searchParams.get('max_depth')).toBe('3');
    expect(treeUrl.searchParams.get('scope')).toBe('foreground');
  });

  it('fails closed on invalid coordinates and oversized declared responses', async () => {
    const fetchImpl = vi.fn(async () => response('{}', { contentLength: 3 * 1024 * 1024 })) as unknown as FetchLike;
    const client = new GuiAgentClient('http://192.168.66.98:8000', fetchImpl);

    const invalidCoordinate = await callGuiTool(client, 'gui_click', { x: Number.NaN, y: 10 });
    expect(invalidCoordinate.isError).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();

    const oversized = await callGuiTool(client, 'gui_health');
    expect(oversized.isError).toBe(true);
    expect(oversized.content[0]).toMatchObject({ type: 'text' });
    expect((oversized.content[0] as { text: string }).text).toContain('exceeds');
  });

  it('implements MCP initialize, tool listing, and tool calls', async () => {
    const fetchImpl = vi.fn(async () => response('{"status":"ok"}')) as unknown as FetchLike;
    const client = new GuiAgentClient('http://192.168.66.98:8000', fetchImpl);

    const initialized = await dispatchMcpRequest(client, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
    });
    expect(initialized).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { serverInfo: { name: 'agentdesk-windows-gui' } },
    });

    const listed = await dispatchMcpRequest(client, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = ((listed?.result as { tools: Array<{ name: string }> }).tools || []).map((tool) => tool.name);
    expect(tools).toContain('gui_observe');
    expect(tools).toContain('gui_click');

    const called = await dispatchMcpRequest(client, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'gui_health', arguments: {} },
    });
    expect(called).toMatchObject({
      jsonrpc: '2.0',
      id: 3,
      result: { content: [{ type: 'text', text: '{"status":"ok"}' }] },
    });
  });
});
