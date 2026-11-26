import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { truncateMiddle } from "./output.ts";
import { resolveInside } from "./paths.ts";
import type { Tool } from "./tool.ts";

const sameTool = (rule: string, name: string) => rule === name;

const ReadInput = z.object({
  path: z.string().min(1).describe("Chemin relatif au dossier de travail"),
  offset: z.number().int().min(1).optional().describe("Première ligne à lire (1 = début)"),
  limit: z.number().int().min(1).optional().describe("Nombre de lignes à lire"),
});

export const readFileTool: Tool<z.infer<typeof ReadInput>> = {
  name: "read_file",
  description:
    "Read a text file inside the working directory. Use offset/limit for large files. " +
    "Paths outside the working directory are refused.",
  schema: ReadInput,
  permission: "auto",
  title: (input) => `Lire ${input.path}`,
  ruleFor: () => "read_file",
  matchesRule: (rule) => sameTool(rule, "read_file"),
  async execute(input, ctx) {
    const file = await resolveInside(ctx.cwd, input.path);
    const buffer = await readFile(file);
    if (buffer.includes(0)) return { output: "Fichier binaire : lecture refusée.", isError: true };
    let text = buffer.toString("utf8");
    if (input.offset !== undefined || input.limit !== undefined) {
      const lines = text.split("\n");
      const start = (input.offset ?? 1) - 1;
      text = lines
        .slice(start, input.limit === undefined ? undefined : start + input.limit)
        .join("\n");
    }
    return { output: truncateMiddle(text), isError: false };
  },
};

const WriteInput = z.object({
  path: z.string().min(1).describe("Chemin relatif au dossier de travail"),
  content: z.string().describe("Contenu complet du fichier"),
});

export const writeFileTool: Tool<z.infer<typeof WriteInput>> = {
  name: "write_file",
  description:
    "Create or overwrite a file inside the working directory with the full content given. " +
    "Parent folders are created. Prefer edit_file to change part of an existing file.",
  schema: WriteInput,
  permission: "ask",
  title: (input) => `Écrire ${input.path}`,
  ruleFor: () => "write_file",
  matchesRule: (rule) => sameTool(rule, "write_file"),
  async execute(input, ctx) {
    const file = await resolveInside(ctx.cwd, input.path);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, input.content, "utf8");
    return {
      output: `Fichier écrit : ${input.path} (${Buffer.byteLength(input.content)} octets)`,
      isError: false,
    };
  },
};

const EditInput = z.object({
  path: z.string().min(1).describe("Chemin relatif au dossier de travail"),
  old_string: z.string().min(1).describe("Texte exact à remplacer, unique dans le fichier"),
  new_string: z.string().describe("Texte de remplacement"),
});

export const editFileTool: Tool<z.infer<typeof EditInput>> = {
  name: "edit_file",
  description:
    "Replace one exact occurrence of old_string with new_string in a file inside the working " +
    "directory. Fails if old_string is absent or appears more than once: include enough context.",
  schema: EditInput,
  permission: "ask",
  title: (input) => `Modifier ${input.path}`,
  ruleFor: () => "edit_file",
  matchesRule: (rule) => sameTool(rule, "edit_file"),
  async execute(input, ctx) {
    const file = await resolveInside(ctx.cwd, input.path);
    const text = await readFile(file, "utf8");
    const first = text.indexOf(input.old_string);
    if (first === -1) return { output: "old_string introuvable dans le fichier.", isError: true };
    if (text.indexOf(input.old_string, first + 1) !== -1) {
      return {
        output: "old_string apparaît plusieurs fois : ajoute du contexte pour le rendre unique.",
        isError: true,
      };
    }
    const updated =
      text.slice(0, first) + input.new_string + text.slice(first + input.old_string.length);
    await writeFile(file, updated, "utf8");
    return { output: `Fichier modifié : ${input.path}`, isError: false };
  },
};
