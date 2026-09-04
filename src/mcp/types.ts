export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface McpToolCallResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface McpToolHandler {
  definition: McpToolDefinition;
  handler: (args: Record<string, unknown>) => Promise<McpToolCallResult> | McpToolCallResult;
}

export function jsonResult(payload: Record<string, unknown>, isError = false): McpToolCallResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    isError,
  };
}

export function errorResult(error: unknown): McpToolCallResult {
  const message = error instanceof Error ? error.message : String(error);
  return jsonResult({ ok: false, error: message }, true);
}
