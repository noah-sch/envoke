import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { z } from "zod";
import { BoundedOutput } from "./output.ts";
import type { Tool, ToolResult } from "./tool.ts";

const DEFAULT_TIMEOUT_S = 120;
const SHELL = existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh";

/** Variables never passed to commands the agent runs. */
const SECRET_ENV =
  /(_API_KEY|_TOKEN|_SECRET|SECRET_|PASSWORD|_PASS$|^ANTHROPIC_|^OPENAI_|^ENVOKE_)/i;

export function safeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !SECRET_ENV.test(key)));
}

/** Shell syntax that chains or redirects: such a command is never covered by an "always" rule. */
const COMPOUND = /[;&|`$<>(){}\n\\]/;

/** "git status --short" -> "git status"; "ls -la" -> "ls". Null for compound commands. */
export function commandPrefix(command: string): string | null {
  const trimmed = command.trim();
  if (trimmed === "" || COMPOUND.test(trimmed)) return null;
  const [first, second] = trimmed.split(/\s+/);
  if (!first) return null;
  return second && !second.startsWith("-") ? `${first} ${second}` : first;
}

const Input = z.object({
  command: z.string().min(1).describe("Commande shell à exécuter"),
  timeoutSeconds: z
    .number()
    .int()
    .min(1)
    .max(600)
    .optional()
    .describe("Délai maximal, 120 s par défaut"),
});
type Input = z.infer<typeof Input>;

export const bashTool: Tool<Input> = {
  name: "bash",
  description:
    "Run a shell command in the working directory. No interactive terminal: stdin is closed. " +
    "Stdout and stderr are merged; long output is truncated. Returns the exit code. " +
    "Use it for builds, tests, git and listing files; prefer read_file/edit_file to read or change files.",
  schema: Input,
  permission: "ask",
  title: (input) => input.command,
  ruleFor: (input) => commandPrefix(input.command),
  matchesRule(rule, input) {
    const command = input.command.trim();
    if (COMPOUND.test(command)) return false;
    return command === rule || command.startsWith(`${rule} `);
  },
  execute(input, ctx) {
    const timeoutMs = (input.timeoutSeconds ?? DEFAULT_TIMEOUT_S) * 1000;
    return new Promise<ToolResult>((resolve) => {
      const child = spawn(SHELL, ["-c", input.command], {
        cwd: ctx.cwd,
        env: safeEnv(),
        detached: true, // own process group: we kill the whole tree
        stdio: ["ignore", "pipe", "pipe"],
      });
      const output = new BoundedOutput();
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => output.push(chunk));
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => output.push(chunk));

      let reason: "timeout" | "aborted" | null = null;
      const killGroup = () => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // group already gone
        }
      };
      const stop = (why: "timeout" | "aborted") => {
        reason ??= why;
        killGroup();
      };
      const timer = setTimeout(() => stop("timeout"), timeoutMs);
      const onAbort = () => stop("aborted");
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      if (ctx.signal.aborted) onAbort();

      let exitCode: number | null = null;
      // Background children of the command would keep the pipes open: kill the group on exit.
      child.on("exit", (code) => {
        exitCode = code;
        killGroup();
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        resolve({ output: `Impossible de lancer la commande : ${error.message}`, isError: true });
      });
      child.on("close", () => {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        const text = output.toString();
        if (reason === "timeout") {
          resolve({
            output: `${text}\n[délai de ${timeoutMs / 1000} s dépassé : commande tuée]`,
            isError: true,
          });
        } else if (reason === "aborted") {
          resolve({ output: `${text}\n[interrompu par l'utilisateur]`, isError: true });
        } else {
          const code = exitCode ?? -1;
          resolve({
            output: `${text}\n[code de sortie : ${code}]`,
            isError: code !== 0,
            exitCode: code,
          });
        }
      });
    });
  },
};
