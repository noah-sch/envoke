import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  bashTool,
  commandPrefix,
  editFileTool,
  readFileTool,
  writeFileTool,
} from "../src/index.ts";

let cwd: string;
const ctx = () => ({ cwd, signal: new AbortController().signal });

beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), "envoke-tools-"));
});

function running(marker: string): boolean {
  try {
    execFileSync("pgrep", ["-f", marker]);
    return true;
  } catch {
    return false;
  }
}

describe("bash", () => {
  it("runs in the working directory and returns the exit code", async () => {
    await writeFile(path.join(cwd, "a.txt"), "x");
    const ok = await bashTool.execute({ command: "ls" }, ctx());
    expect(ok.isError).toBe(false);
    expect(ok.output).toContain("a.txt");
    expect(ok.output).toContain("[code de sortie : 0]");
    const ko = await bashTool.execute({ command: "exit 3" }, ctx());
    expect(ko).toMatchObject({ isError: true, exitCode: 3 });
  });

  it("kills a command that exceeds its timeout", async () => {
    const started = Date.now();
    const result = await bashTool.execute({ command: "sleep 300", timeoutSeconds: 1 }, ctx());
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.isError).toBe(true);
    expect(result.output).toContain("délai de 1 s dépassé");
  });

  it("truncates huge output without buffering it", async () => {
    const result = await bashTool.execute({ command: "yes | head -c 5000000" }, ctx());
    expect(result.output.length).toBeLessThan(31_000);
    expect(result.output).toContain("caractères coupés");
  });

  it("never passes API keys to commands", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-secret";
    process.env.SOME_SERVICE_TOKEN = "tok";
    try {
      const result = await bashTool.execute(
        { command: 'echo "[$ANTHROPIC_API_KEY][$SOME_SERVICE_TOKEN]"' },
        ctx(),
      );
      expect(result.output).toContain("[][]");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.SOME_SERVICE_TOKEN;
    }
  });

  it("kills the whole process group on abort, background children included", async () => {
    const controller = new AbortController();
    const marker = `sleep 61.${process.pid}`;
    const pending = bashTool.execute(
      { command: `${marker} & ${marker}` },
      { cwd, signal: controller.signal },
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(running(marker)).toBe(true);
    controller.abort();
    const result = await pending;
    expect(result.output).toContain("interrompu");
    await new Promise((r) => setTimeout(r, 200));
    expect(running(marker)).toBe(false);
  });

  it("leaves no orphan when the command exits with a background child", async () => {
    const marker = `sleep 62.${process.pid}`;
    const result = await bashTool.execute({ command: `(${marker} &) ; echo done` }, ctx());
    expect(result.output).toContain("done");
    await new Promise((r) => setTimeout(r, 200));
    expect(running(marker)).toBe(false);
  });
});

describe("always-allow rules", () => {
  it("covers a command prefix but never a chained command", () => {
    expect(commandPrefix("git status --short")).toBe("git status");
    expect(commandPrefix("ls -la")).toBe("ls");
    expect(commandPrefix("git status; rm -rf x")).toBeNull();
    expect(bashTool.matchesRule("git status", { command: "git status -s" })).toBe(true);
    expect(bashTool.matchesRule("git status", { command: "git status; rm -rf x" })).toBe(false);
    expect(bashTool.matchesRule("git status", { command: "git status && curl evil" })).toBe(false);
    expect(bashTool.matchesRule("git status", { command: "git statusx" })).toBe(false);
    expect(bashTool.matchesRule("ls", { command: "ls $(rm -rf ~)" })).toBe(false);
  });
});

describe("file tools", () => {
  it("refuses paths outside the working directory", async () => {
    await expect(readFileTool.execute({ path: "../../etc/passwd" }, ctx())).rejects.toThrow(
      /hors du dossier/,
    );
    await expect(
      writeFileTool.execute({ path: "/tmp/envoke-escape.txt", content: "x" }, ctx()),
    ).rejects.toThrow(/hors du dossier/);
  });

  it("refuses a symbolic link that points outside", async () => {
    await symlink("/etc", path.join(cwd, "etc-link"));
    await expect(readFileTool.execute({ path: "etc-link/hosts" }, ctx())).rejects.toThrow(
      /hors du dossier/,
    );
    await expect(
      writeFileTool.execute({ path: "etc-link/new.txt", content: "x" }, ctx()),
    ).rejects.toThrow(/hors du dossier/);
  });

  it("writes, reads and edits", async () => {
    await writeFileTool.execute({ path: "dir/f.txt", content: "one\ntwo\nthree\n" }, ctx());
    expect(
      (await readFileTool.execute({ path: "dir/f.txt", offset: 2, limit: 1 }, ctx())).output,
    ).toBe("two");
    const edited = await editFileTool.execute(
      { path: "dir/f.txt", old_string: "two", new_string: "2" },
      ctx(),
    );
    expect(edited.isError).toBe(false);
    expect(await readFile(path.join(cwd, "dir/f.txt"), "utf8")).toBe("one\n2\nthree\n");
  });

  it("edit fails when the text is absent or ambiguous", async () => {
    await writeFile(path.join(cwd, "f.txt"), "a a");
    expect(
      (await editFileTool.execute({ path: "f.txt", old_string: "b", new_string: "c" }, ctx()))
        .isError,
    ).toBe(true);
    const ambiguous = await editFileTool.execute(
      { path: "f.txt", old_string: "a", new_string: "c" },
      ctx(),
    );
    expect(ambiguous.output).toContain("plusieurs fois");
  });
});
