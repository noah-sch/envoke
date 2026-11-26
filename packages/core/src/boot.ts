import { mkdir } from "node:fs/promises";
import path from "node:path";
import { defaultDataDir, loadConfig } from "./config.ts";
import { KeychainStore } from "./credentials.ts";
import { Runtime } from "./runtime.ts";
import { SqliteSessionStore } from "./sqlite-store.ts";

/** Production wiring shared by the server and the CLI: data dir, config, SQLite, OS keychain. */
export async function bootRuntime(): Promise<{ runtime: Runtime; close: () => Promise<void> }> {
  const dataDir = defaultDataDir();
  await mkdir(dataDir, { recursive: true });
  const config = await loadConfig(dataDir);
  const store = SqliteSessionStore.open(path.join(dataDir, "envoke.sqlite"));
  const runtime = new Runtime({ config, dataDir, credentials: new KeychainStore(), store });
  return {
    runtime,
    close: async () => {
      await runtime.dispose();
      store.close();
    },
  };
}
