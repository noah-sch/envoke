#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { bootRuntime } from "@envoke/core";
import { createApp } from "./app.ts";

const { runtime, close } = await bootRuntime();

const port = Number(process.env.ENVOKE_PORT ?? 4317);
const token = process.env.ENVOKE_TOKEN ?? randomBytes(32).toString("base64url");
const allowedOrigins = process.env.ENVOKE_ORIGINS?.split(",").map((o) => o.trim());
const webDir =
  process.env.ENVOKE_WEB_DIR ?? fileURLToPath(new URL("../../web/dist", import.meta.url));
const app = createApp({
  runtime,
  token,
  port,
  ...(allowedOrigins ? { allowedOrigins } : {}),
  ...(existsSync(webDir) ? { webDir } : {}),
});

const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, () => {
  // One JSON line for the desktop shell that starts this process.
  const url = `http://127.0.0.1:${port}`;
  // The token travels in the fragment: never sent to the server, never logged by it.
  console.log(JSON.stringify({ ready: true, url, token, open: `${url}/#token=${token}` }));
});

async function shutdown() {
  server.close();
  await close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
