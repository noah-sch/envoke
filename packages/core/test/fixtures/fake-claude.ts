/**
 * Stands in for Claude Code in a terminal. Prints its arguments and which sensitive variables it
 * received, answers each line with "reçu: …", and exits on "exit". `--resume` only works once a
 * line was received in this folder (Claude Code saves a conversation at its first message).
 *
 * Given `--settings` with HTTP hooks (as envoke launches it), it also plays a turn through them:
 * the prompt, some text, a Bash call that asks for permission, its result, and a final answer.
 */
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const argv = process.argv.slice(2);
const settingsAt = argv.indexOf("--settings");
const settings =
  settingsAt === -1
    ? null
    : (JSON.parse(argv[settingsAt + 1]!) as {
        hooks: Record<string, { hooks: { url?: string; command?: string }[] }[]>;
      });
const args =
  settingsAt === -1 ? argv : argv.filter((_, i) => i !== settingsAt && i !== settingsAt + 1);
const saved = ".fake-claude-saved";

if (args[0] === "--resume" && !existsSync(saved)) {
  process.stdout.write(`No conversation found with session ID: ${args[1]}\r\n`);
  process.exit(1);
}

const leaked = [
  "ANTHROPIC_API_KEY",
  "ENVOKE_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
].filter((name) => process.env[name] !== undefined);
process.stdout.write(`args: ${JSON.stringify(args)}\r\n`);
process.stdout.write(
  `leaked: ${JSON.stringify(leaked)} term: ${process.env.TERM} kept: ${process.env.CLAUDE_CODE_USE_BEDROCK}\r\n`,
);

/**
 * Runs a hook like Claude Code: an HTTP hook posts the JSON with the token from the environment;
 * a command hook runs in a shell with the JSON on stdin.
 */
async function hook(event: string, body: Record<string, unknown>): Promise<unknown> {
  const handler = settings?.hooks[event]?.[0]?.hooks[0];
  if (handler?.command) {
    const child = spawn("sh", ["-c", handler.command], { stdio: ["pipe", "ignore", "ignore"] });
    child.stdin.end(JSON.stringify({ hook_event_name: event, session_id: "fake", ...body }));
    await new Promise((resolve) => child.on("close", resolve));
    return null;
  }
  const url = handler?.url;
  if (!url) return null;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${process.env.ENVOKE_HOOK_TOKEN ?? ""}`,
      },
      body: JSON.stringify({ hook_event_name: event, session_id: "fake", ...body }),
    });
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

async function turn(prompt: string) {
  await hook("UserPromptSubmit", { prompt });
  await hook("MessageDisplay", { message_id: "m1", index: 0, delta: "Je regarde.\n", final: true });
  const input = { command: "ls" };
  await hook("PreToolUse", { tool_name: "Bash", tool_input: input, tool_use_id: "toolu_1" });
  const answer = (await hook("PermissionRequest", {
    tool_name: "Bash",
    tool_input: input,
    permission_suggestions: [
      {
        type: "addRules",
        rules: [{ toolName: "Bash", ruleContent: "ls" }],
        behavior: "allow",
        destination: "localSettings",
      },
    ],
  })) as { hookSpecificOutput?: { decision?: Record<string, unknown> } } | null;
  const decision = answer?.hookSpecificOutput?.decision;
  process.stdout.write(`decision: ${JSON.stringify(decision ?? null)}\r\n`);
  if (decision?.behavior === "allow") {
    await hook("PostToolUse", {
      tool_name: "Bash",
      tool_input: input,
      tool_use_id: "toolu_1",
      tool_response: { stdout: "a.txt\nb.txt", stderr: "" },
    });
  } else {
    await hook("PostToolUseFailure", { tool_use_id: "toolu_1", error: "Refusé" });
  }
  await hook("MessageDisplay", {
    message_id: "m2",
    index: 0,
    delta: "Deux fichiers.",
    final: true,
  });
  await hook("Stop", { last_assistant_message: "Deux fichiers." });
}

void hook("SessionStart", { source: "startup" });

createInterface({ input: process.stdin }).on("line", (raw) => {
  // envoke submits messages as a bracketed paste.
  const line = raw.replaceAll("\x1b[200~", "").replaceAll("\x1b[201~", "");
  if (line === "exit") process.exit(0);
  writeFileSync(saved, "1");
  process.stdout.write(`reçu: ${line}\r\n`);
  if (settings) void turn(line);
});
