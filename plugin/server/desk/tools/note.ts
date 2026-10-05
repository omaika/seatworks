import { recordEvent } from "../store/event-log.ts";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { no, ok } from "../context.ts";
import { defineTool } from "../services.ts";

/** Where `name` goes under the project's state: a single page of the role's by name alone, else in a folder it names. */
function placed(writes: string[], kind: string, name: string): { at: string } | { refused: string } {
  const folders = writes.filter((entry) => entry.endsWith("/")).map((entry) => entry.slice(0, -1));
  const pages = writes.filter((entry) => !entry.endsWith("/"));
  if (!kind) {
    if (pages.includes(name)) return { at: name };
    const inFolder = folders.length > 0 ? `a page in a folder names the folder in kind: ${folders.join(", ")}.` : "";
    if (pages.length > 0) return { refused: `${name} is no page you keep: ${pages.join(", ")}; ${inFolder}`.trim() };
    return { refused: inFolder ? `${name} is no page you keep; ${inFolder}` : "Your role keeps no pages." };
  }
  if (!folders.includes(kind))
    return {
      refused:
        folders.length > 0
          ? `${kind} is no folder you keep pages in: ${folders.join(", ")}.`
          : "Your role keeps no pages.",
    };
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name))
    return { refused: `${name} is not one file name: no folders in it, like cart-plan.md.` };
  return { at: `${kind}/${name}` };
}

export const note = defineTool({
  name: "note",
  input: z.strictObject({ kind: z.string().optional(), name: z.string(), text: z.string() }),
  async handle(_desk, caller, args) {
    const where = placed(caller.role.writes ?? [], (args.kind ?? "").trim().replace(/\/$/, ""), args.name.trim());
    if ("refused" in where) return no(where.refused);
    const file = join(caller.project.state, where.at);
    const replaced = existsSync(file);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, args.text.endsWith("\n") ? args.text : `${args.text}\n`);
    recordEvent(caller.project, { kind: "note.written", file: where.at, by: caller.id, replaced });
    return ok(`${replaced ? "Replaced" : "Wrote"} ${file}. Name it by that path wherever you point to it.`);
  },
});
