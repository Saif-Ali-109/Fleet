import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ToolImpl, ToolSchema, WtCtx, ToolResult } from "./common.ts";

export interface McpConnection {
  client: Client;
  transport: StdioClientTransport;
  tools: Map<string, ToolImpl>;
}

export async function connectToMcpServer(role: string): Promise<McpConnection> {
  const transport = new StdioClientTransport({
    command: "tsx",
    args: ["src/mcp/fleetServer.ts", role],
  });
  const client = new Client({ name: "fleet-worker", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  const toolsResult = await client.listTools();
  const tools = new Map<string, ToolImpl>();

  for (const tool of toolsResult.tools) {
    const schema = tool.inputSchema as unknown as ToolSchema;
    tools.set(tool.name, {
      schema,
      async exec(input: unknown, _ctx: WtCtx): Promise<ToolResult> {
        try {
          const result = await client.callTool({ name: tool.name, arguments: input as Record<string, unknown> });
          return { ok: true, content: JSON.stringify(result, null, 2) };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      },
    });
  }

  return { client, transport, tools };
}

export async function closeMcpConnection(conn: McpConnection): Promise<void> {
  await conn.client.close().catch(() => {});
  await conn.transport.close().catch(() => {});
}