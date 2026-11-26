/**
 * Development: the engine on 127.0.0.1:4317 and the Vite dev server on :5173, which proxies /api.
 * The engine accepts the dev server's origin; open the printed URL (it carries the token).
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const token = randomBytes(24).toString("base64url");
const env = {
  ...process.env,
  ENVOKE_TOKEN: token,
  ENVOKE_ORIGINS: "http://localhost:5173,http://127.0.0.1:5173",
};

const children = [
  spawn(process.execPath, ["packages/server/src/main.ts"], {
    env,
    stdio: ["ignore", "ignore", "inherit"],
  }),
  spawn("pnpm", ["--filter", "@envoke/web", "dev"], {
    env,
    stdio: ["ignore", "ignore", "inherit"],
  }),
];

console.log(`\n  envoke (dev) → http://localhost:5173/#token=${token}\n`);

const stop = () => {
  for (const child of children) child.kill("SIGTERM");
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
for (const child of children) child.on("exit", stop);
