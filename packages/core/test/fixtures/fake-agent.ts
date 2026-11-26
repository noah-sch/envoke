/**
 * Minimal ACP agent for tests, spoken over stdio like a real one.
 * Prompts: "tool" asks a permission, "env" echoes FAKE_KEY, "slow" waits for session/cancel.
 */
import { Readable, Writable } from "node:stream";
import { agent, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

let next = 0;
const known = new Set<string>();
const cancels = new Map<string, () => void>();

agent({ name: "fake-agent" })
  .onRequest("initialize", () => ({
    protocolVersion: PROTOCOL_VERSION,
    agentCapabilities: { loadSession: true },
    authMethods: [
      { id: "key", name: "API key" },
      { id: "login", name: "Log in", type: "terminal" as const, args: ["--login"] },
    ],
  }))
  .onRequest("authenticate", () => ({}))
  .onRequest("session/new", () => {
    const sessionId = `s-${process.pid}-${++next}`;
    known.add(sessionId);
    return { sessionId };
  })
  .onRequest("session/load", async ({ params, client }) => {
    // Replays the old conversation, as the protocol requires.
    await client.notify("session/update", {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "(replayed)" },
      },
    });
    known.add(params.sessionId);
    return {};
  })
  .onRequest("session/prompt", async ({ params, client }) => {
    const { sessionId } = params;
    const first = params.prompt[0];
    const text = first?.type === "text" ? first.text : "";
    const say = (t: string) =>
      client.notify("session/update", {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: t } },
      });

    if (text === "env") {
      await say(
        `key:${process.env.FAKE_KEY ?? "none"} home:${process.env.FAKE_HOME ? "set" : "unset"}`,
      );
      return { stopReason: "end_turn" as const };
    }
    if (text === "slow") {
      await say("working");
      await new Promise<void>((resolve) => cancels.set(sessionId, resolve));
      return { stopReason: "cancelled" as const };
    }
    await say(`echo:${text}`);
    if (text === "tool") {
      await client.notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "t1",
          title: "List files",
          kind: "execute",
          status: "pending",
          rawInput: { command: "ls" },
        },
      });
      const answer = await client.request("session/request_permission", {
        sessionId,
        toolCall: { toolCallId: "t1" },
        options: [
          { optionId: "yes", name: "Allow", kind: "allow_once" },
          { optionId: "always", name: "Always", kind: "allow_always" },
          { optionId: "no", name: "Reject", kind: "reject_once" },
        ],
      });
      const allowed = answer.outcome.outcome === "selected" && answer.outcome.optionId !== "no";
      await client.notify("session/update", {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "t1",
          status: allowed ? "completed" : "failed",
          content: [
            {
              type: "content",
              content: {
                type: "text",
                text: allowed
                  ? `ran:${answer.outcome.outcome === "selected" ? answer.outcome.optionId : ""}`
                  : "denied",
              },
            },
          ],
        },
      });
    }
    return { stopReason: "end_turn" as const };
  })
  .onNotification("session/cancel", ({ params }) => {
    cancels.get(params.sessionId)?.();
  })
  .connect(
    ndJsonStream(
      Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
      Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>,
    ),
  );
