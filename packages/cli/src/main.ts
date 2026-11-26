#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface, type Interface } from "node:readline/promises";
import { parseArgs, styleText } from "node:util";
import {
  bootRuntime,
  EnvokeError,
  type AgentEvent,
  type Decision,
  type Runtime,
} from "@envoke/core";

const USAGE = `envoke — moteurs de chat multi-comptes

  envoke chat [--profile <id>] [--cwd <dossier>] [--session <id>]
  envoke connections            état des connexions
  envoke profiles               profils disponibles
  envoke link <connexion>       lier une clé API, un compte ChatGPT ou un agent
  envoke unlink <connexion>     délier

Dans le chat : /exit pour quitter, /profile <id> pour changer de profil,
Ctrl+C pour interrompre une réponse.`;

const dim = (s: string) => styleText("dim", s);
const red = (s: string) => styleText("red", s);
const green = (s: string) => styleText("green", s);
const bold = (s: string) => styleText("bold", s);

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    profile: { type: "string" },
    cwd: { type: "string" },
    session: { type: "string" },
    help: { type: "boolean", short: "h" },
  },
});

const [command = "chat", target] = positionals;
if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

const { runtime, close } = await bootRuntime();
try {
  switch (command) {
    case "chat":
      await chat(runtime);
      break;
    case "connections":
      await connections(runtime);
      break;
    case "profiles":
      for (const p of await runtime.listProfiles()) {
        const mark = p.available ? green("●") : dim("○");
        console.log(
          `${mark} ${bold(p.id)}  ${p.label}  ${dim(`${p.connection}${p.model ? ` · ${p.model}` : ""}`)}`,
        );
      }
      break;
    case "link":
      await link(runtime, required(target));
      break;
    case "unlink": {
      const { revoked } = await runtime.unlink(required(target));
      console.log(revoked ? "Délié." : "Délié localement ; révocation distante non confirmée.");
      break;
    }
    default:
      console.log(USAGE);
      process.exitCode = 1;
  }
} catch (error) {
  console.error(red(error instanceof EnvokeError ? error.message : String(error)));
  process.exitCode = 1;
} finally {
  await close();
}

function required(value: string | undefined): string {
  if (!value)
    throw new EnvokeError(
      "bad_request",
      "Précise la connexion, par exemple : envoke link anthropic",
    );
  return value;
}

async function connections(rt: Runtime): Promise<void> {
  for (const c of await rt.listConnections()) {
    const state = !c.allowed
      ? red("bloquée par la politique")
      : c.linked
        ? green("liée")
        : dim("non liée");
    const extra = c.account
      ? ` (${c.account})`
      : c.requires.length
        ? dim(` utilise : ${c.requires.join(", ")}`)
        : "";
    console.log(`${bold(c.id.padEnd(14))} ${c.label.padEnd(26)} ${state}${extra}`);
  }
}

async function link(rt: Runtime, connectionId: string): Promise<void> {
  const status = await rt.connectionStatus(connectionId);
  if (status.type === "chatgpt") {
    const { authorizeUrl, completion } = await rt.beginChatGPTLogin(connectionId);
    console.log(`Ouvre cette page pour connecter ton compte :\n${authorizeUrl}`);
    openBrowser(authorizeUrl);
    const { email } = await completion;
    console.log(green(`Compte ChatGPT connecté${email ? ` : ${email}` : ""}.`));
    return;
  }
  if (status.type === "acp") {
    if (status.requires.length > 0) {
      console.log(
        `${status.label} utilise la clé de : ${status.requires.join(", ")}. Lie-la avec envoke link ${status.requires[0]}.`,
      );
      return;
    }
    const methods = await rt.agentAuthMethods(connectionId);
    methods.forEach((m, i) =>
      console.log(`${i + 1}. ${m.name}${m.description ? dim(` — ${m.description}`) : ""}`),
    );
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const choice = Number(await rl.question("Méthode : ")) - 1;
    rl.close();
    const method = methods[choice];
    if (!method) throw new EnvokeError("bad_request", "Choix invalide.");
    const { terminal } = await rt.agentAuthenticate(connectionId, method.id);
    if (terminal) {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(terminal.command, terminal.args, {
          stdio: "inherit",
          env: { ...process.env, ...terminal.env },
        });
        child.on("error", reject);
        child.on("exit", (code) =>
          code === 0
            ? resolve()
            : reject(new EnvokeError("auth", `Connexion échouée (code ${code}).`)),
        );
      });
    }
    console.log(green("Agent connecté."));
    return;
  }
  if (status.access === "none") {
    console.log("Cette connexion n'a pas besoin de clé.");
    return;
  }
  const key = await hiddenInput(`Clé API pour ${status.label} : `);
  await rt.linkApiKey(connectionId, key);
  console.log(green("Clé enregistrée dans le trousseau du système."));
}

async function chat(rt: Runtime): Promise<void> {
  const sessionId =
    values.session ??
    (
      await rt.createSession({
        cwd: values.cwd ?? process.cwd(),
        ...(values.profile ? { profileId: values.profile } : {}),
      })
    ).id;
  const session = rt.store.getSession(sessionId);
  if (!session) throw new EnvokeError("not_found", `Session inconnue : ${sessionId}`);
  console.log(dim(`Session ${sessionId} · profil ${session.profileId} · ${session.cwd}`));
  console.log(
    dim("/exit pour quitter · /profile <id> pour changer · Ctrl+C interrompt la réponse"),
  );

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let turn: AbortController | null = null;
  rl.on("SIGINT", () => {
    if (turn) turn.abort();
    else rl.close();
  });
  const closed = new Promise<null>((resolve) => rl.once("close", () => resolve(null)));

  for (;;) {
    const line = await Promise.race([rl.question(bold("› ")), closed]);
    if (line === null) break;
    const text = line.trim();
    if (!text) continue;
    if (text === "/exit") break;
    if (text.startsWith("/profile")) {
      const id = text.split(/\s+/)[1];
      if (id) {
        rt.setSessionProfile(sessionId, id);
        console.log(dim(`Profil : ${id}`));
      } else {
        for (const p of await rt.listProfiles())
          console.log(`${p.available ? green("●") : dim("○")} ${p.id}`);
      }
      continue;
    }
    turn = new AbortController();
    try {
      await render(rt, rt.send(sessionId, text, turn.signal), rl);
    } finally {
      turn = null;
    }
  }
  rl.close();
}

async function render(
  rt: Runtime,
  events: AsyncIterable<AgentEvent>,
  rl: Interface,
): Promise<void> {
  let thinking = false;
  for await (const e of events) {
    if (thinking && e.type !== "thinking_delta") {
      process.stdout.write("\n");
      thinking = false;
    }
    switch (e.type) {
      case "text_delta":
        process.stdout.write(e.text);
        break;
      case "thinking_delta":
        thinking = true;
        process.stdout.write(dim(e.text));
        break;
      case "tool_start":
        process.stdout.write(`\n${styleText("cyan", "⏺")} ${e.title}\n`);
        break;
      case "tool_end": {
        const lines = e.output.trim().split("\n");
        const shown =
          lines.slice(0, 8).join("\n") +
          (lines.length > 8 ? `\n… ${lines.length - 8} lignes de plus` : "");
        console.log((e.isError ? red : dim)(shown.replace(/^/gm, "  ")));
        break;
      }
      case "permission_request": {
        const answer = (
          await rl.question(
            `${styleText("yellow", "?")} Autoriser ${bold(e.title)} ? [o]ui / [t]oujours / [n]on : `,
          )
        )
          .trim()
          .toLowerCase();
        const decision: Decision =
          answer === "o" || answer === "oui"
            ? "allow_once"
            : answer === "t"
              ? "allow_always"
              : "deny";
        rt.resolvePermission(e.requestId, decision);
        break;
      }
      case "error":
        console.log(red(`\n${e.message}`));
        break;
      case "turn_done":
        process.stdout.write("\n");
        if (e.stopReason === "aborted") console.log(dim("(interrompu)"));
        if (e.stopReason === "max_tokens")
          console.log(dim("(réponse coupée : limite de longueur)"));
        if (e.stopReason === "refusal") console.log(dim("(le modèle a refusé)"));
        if (e.stopReason === "max_iterations") console.log(dim("(limite de 50 étapes atteinte)"));
        break;
      case "usage":
        break;
    }
  }
}

function openBrowser(url: string): void {
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  spawn(opener, [url], { stdio: "ignore", detached: true })
    .on("error", () => {})
    .unref();
}

/** Reads a secret without echoing it. */
function hiddenInput(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      let data = "";
      stdin
        .setEncoding("utf8")
        .on("data", (c: string) => (data += c))
        .on("end", () => resolve(data.trim()));
      return;
    }
    process.stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          done();
          resolve(value);
          return;
        }
        if (ch === "\u0003") {
          done();
          reject(new EnvokeError("aborted", "Annulé."));
          return;
        }
        if (ch === "\u007f") value = value.slice(0, -1);
        else value += ch;
      }
    };
    const done = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
    };
    stdin.on("data", onData);
  });
}
