import { realpath } from "node:fs/promises";
import path from "node:path";
import { EnvokeError } from "../errors.ts";

/**
 * Resolves `p` against the working directory and refuses anything outside it, symbolic links
 * included. The target may not exist yet (write_file): its deepest existing ancestor is resolved.
 */
export async function resolveInside(cwd: string, p: string): Promise<string> {
  const root = await realpath(cwd);
  const target = path.resolve(root, p);
  const missing: string[] = [];
  let existing = target;
  let real: string;
  for (;;) {
    try {
      real = await realpath(existing);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
  const resolved = path.join(real, ...missing);
  const relative = path.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new EnvokeError("policy", `Chemin hors du dossier de travail refusé : ${p}`);
  }
  return resolved;
}
