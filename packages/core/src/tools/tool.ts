import { z } from "zod";
import type { ToolSpec } from "../types.ts";

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
}

export interface ToolResult {
  output: string;
  isError: boolean;
  exitCode?: number;
}

export interface Tool<I = unknown> {
  name: string;
  description: string;
  schema: z.ZodType<I>;
  /** "auto" runs without asking; "ask" goes through the permission gate. */
  permission: "auto" | "ask";
  /** Short text for the permission card (the command, the file). */
  title(input: I): string;
  /** Rule remembered by "always allow", or null when the input cannot be allowed for good. */
  ruleFor(input: I): string | null;
  /** Whether a remembered rule covers this input. */
  matchesRule(rule: string, input: I): boolean;
  execute(input: I, ctx: ToolContext): Promise<ToolResult>;
}

export function toolSpec(tool: Tool): ToolSpec {
  const { $schema: _ignored, ...inputSchema } = z.toJSONSchema(tool.schema) as Record<
    string,
    unknown
  >;
  return { name: tool.name, description: tool.description, inputSchema };
}
