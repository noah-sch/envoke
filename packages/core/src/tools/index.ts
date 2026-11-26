import { bashTool } from "./bash.ts";
import { editFileTool, readFileTool, writeFileTool } from "./files.ts";
import type { Tool } from "./tool.ts";

export { bashTool, commandPrefix, safeEnv } from "./bash.ts";
export { editFileTool, readFileTool, writeFileTool } from "./files.ts";
export { resolveInside } from "./paths.ts";
export { BoundedOutput, truncateMiddle, MAX_OUTPUT_CHARS } from "./output.ts";
export { toolSpec, type Tool, type ToolContext, type ToolResult } from "./tool.ts";

export const defaultTools: Tool[] = [bashTool, readFileTool, writeFileTool, editFileTool] as Tool[];
