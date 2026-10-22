import { describe, expect, it } from 'vitest';

import { type McpClientLike, type McpToolInfo, wrapMcpTool } from '../src/extensions/mcp/client.js';
import { type McpServerConfig, loadMcpConfig } from '../src/extensions/mcp/config.js';
import { createTestContext, writeTestFile } from './helpers/index.js';

function fakeClient(text = 'pong'): McpClientLike {
  return {
    listTools: async () => ({ tools: [] }),
    callTool: async (params) => ({
      content: [{ type: 'text', text: `${text}:${String(params.arguments.text)}` }],
      isError: false,
    }),
    close: async () => undefined,
  };
}

const TOOL_INFO: McpToolInfo = {
  name: 'echo',
  description: 'Echo text',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  annotations: { readOnlyHint: true },
};

const CONFIG: McpServerConfig = {
  name: 'echo-test',
  command: 'node',
  args: [],
  timeoutMs: 1_000,
};

describe('MCP tool wrapper', () => {
  it('生成带命名空间的工具名并调用客户端', async () => {
    const ctx = createTestContext();
    const tool = wrapMcpTool(CONFIG, fakeClient(), TOOL_INFO, new Set());

    expect(tool.name).toBe('mcp__echo_test__echo');
    expect(tool.isReadOnly({})).toBe(true);
    expect(tool.jsonSchema).toEqual(TOOL_INFO.inputSchema);

    const result = await tool.call({ text: 'hi' }, ctx);
    expect(result.isError).toBe(false);
    expect(result.output).toBe('pong:hi');
  });

  it('把 MCP 错误标记为错误结果', async () => {
    const ctx = createTestContext();
    const client: McpClientLike = {
      ...fakeClient(),
      callTool: async () => ({
        content: [{ type: 'text', text: 'failed' }],
        isError: true,
      }),
    };
    const tool = wrapMcpTool(CONFIG, client, TOOL_INFO, new Set());

    const result = await tool.call({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.output).toContain('failed');
  });
});

describe('MCP config', () => {
  it('合并全局与项目配置，项目覆盖同名 Server', () => {
    const ctx = createTestContext();
    writeTestFile(
      ctx.agentRoot,
      'config/mcp.json',
      JSON.stringify({
        mcpServers: {
          local: { command: 'node', args: ['global.js'], timeoutMs: 1000 },
        },
      }),
    );
    writeTestFile(
      ctx.cwd,
      '.agent/mcp.json',
      JSON.stringify({
        mcpServers: {
          local: { command: 'node', args: ['project.js'], timeoutMs: 1000 },
          remote: { url: 'https://example.com/mcp', timeoutMs: 1000 },
        },
      }),
    );

    const servers = loadMcpConfig(ctx.agentRoot, ctx.cwd);

    expect(servers).toHaveLength(2);
    const local = servers.find((server) => server.name === 'local');
    expect(local).toMatchObject({ command: 'node', args: ['project.js'] });
    expect(servers.find((server) => server.name === 'remote')).toMatchObject({
      url: 'https://example.com/mcp',
    });
  });
});
