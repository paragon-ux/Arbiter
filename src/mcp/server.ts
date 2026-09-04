import readline from "node:readline";
import { McpToolHandler } from "./types.js";

export class ArbiterMcpServer {
  private readonly toolMap = new Map<string, McpToolHandler>();

  constructor(tools: McpToolHandler[]) {
    for (const tool of tools) {
      this.toolMap.set(tool.definition.name, tool);
    }
  }

  public async handleMessage(raw: string): Promise<string | null> {
    const trimmed = raw.trim();
    if (!trimmed) return null;

    let parsed: { jsonrpc?: string; id?: number | string; method?: string; params?: Record<string, unknown> };
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" },
      });
    }

    const { id, method, params } = parsed;

    if (method === "initialize") {
      return JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          serverInfo: {
            name: "arbiter-mcp",
            version: "0.1.0",
          },
          capabilities: {
            tools: {},
          },
        },
      });
    }

    if (method === "ping") {
      return JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: {},
      });
    }

    if (method === "tools/list") {
      return JSON.stringify({
        jsonrpc: "2.0",
        id,
        result: {
          tools: Array.from(this.toolMap.values()).map((t) => t.definition),
        },
      });
    }

    if (method === "tools/call") {
      const toolName = String(params?.name);
      const toolArgs = (params?.arguments as Record<string, unknown>) ?? {};
      const tool = this.toolMap.get(toolName);
      if (!tool) {
        return JSON.stringify({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `Tool not found: ${toolName}` },
        });
      }

      try {
        const result = await tool.handler(toolArgs);
        return JSON.stringify({
          jsonrpc: "2.0",
          id,
          result,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify({ ok: false, error: message }) }],
            isError: true,
          },
        });
      }
    }

    return JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }

  public listenStdio(): void {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    rl.on("line", async (line) => {
      const res = await this.handleMessage(line);
      if (res) {
        process.stdout.write(`${res}\n`);
      }
    });
  }
}
