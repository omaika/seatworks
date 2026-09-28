import { join, relative, sep } from "node:path";
import { DESK_OWNED, RECORDS, stateRoot } from "../../core/paths.ts";
import { readConfigStrict } from "../../core/config-file.ts";
import { type Json, getPath, isRecord, layered, setPath } from "../../core/json.ts";
import type { HarnessSpec, Kit, RoleSpec } from "../kit/kit.ts";

const MACHINE_OWNED = [
  "settings.json",
  "outbox.json",
  "intents.json",
  "keys.json",
  "kit.json",
  "models.json",
  "bin",
  "content",
  "guides",
];
const REPLACING = [
  "roles.json",
  "ecosystem.json",
  "refused.json",
  "attention.json",
  "patterns.json",
  "checks.json",
  "paseo.json",
  "sensor",
  "own",
];
const KEYED = ["settings.json", "keys.json"];
const AGENTS_WHY = "the desk alone starts agents";

type Command = { words: string[]; why: string };

/** Every way a seat's shell could start what the desk refuses it: the kit's agents, which Paseo alone starts, and refused.json's commands, bare and through each launcher. */
function refusedCommands(kit: Kit): Command[] {
  const agents = Object.values(kit.harnesses).flatMap((harness) => harness.provider.env?.SEATWORKS_AGENT_BIN ?? []);
  const named = [
    ...[...new Set(agents)].map((name) => ({ name, why: AGENTS_WHY })),
    ...Object.entries(kit.refused).map(([name, why]) => ({ name, why })),
  ];
  return named.flatMap(({ name, why }) => [
    { words: [name], why },
    ...kit.ecosystem.launchers.map((launcher) => ({ words: [launcher, name], why })),
  ]);
}

/** A role's page ending in / is a folder, and so is a name of the desk's with no extension: all that is in it goes with it. */
const within = (dir: string, name: string): string =>
  name.endsWith("/") || !name.includes(".") ? join(dir, name.replace(/\/$/, ""), "**") : join(dir, name);

/**
 * The paths under the state root a seat's file tools may not change: the desk's record, what `loadKit` reads there in place
 * of the kit's files, and other roles' pages; and those holding keys, which it may not read either. The copies are theirs.
 */
function keptPaths(kit: Kit, role: RoleSpec, homeDir: string): { edits: string[]; reads: string[] } {
  const root = stateRoot(homeDir);
  const project = join(root, "projects", "*");
  const own = new Set(role.writes ?? []);
  const pages = [...new Set(kit.roles.flatMap((each) => each.writes ?? []))].filter((page) => !own.has(page));
  return {
    edits: [
      ...[...MACHINE_OWNED, ...REPLACING].map((name) => within(root, name)),
      ...[...DESK_OWNED, ...pages].map((name) => within(project, name)),
      ...RECORDS.map((name) => join(project, `${name}.*.log*`)),
    ],
    reads: keyedPaths(homeDir),
  };
}

/** The desk's files that hold keys: the whole name too, which every sandbox keeps, beside the glob that takes in staged copies and backups. */
function keyedPaths(homeDir: string): string[] {
  const root = stateRoot(homeDir);
  return [...KEYED.map((name) => join(root, name)), join(root, "projects", "*", "settings.json")].flatMap((path) => [
    path,
    `${path}*`,
  ]);
}

/** The paths a harness's shipped settings refuse its file tools to read, read back through its own form for a refused read. */
function refusedIn(kit: Kit, harness: HarnessSpec, refusal: { at: string; as: unknown }): string[] {
  const forms = (Array.isArray(refusal.as) ? refusal.as : [])
    .filter((form): form is string => typeof form === "string" && form.includes("{path}"))
    .map((form) => new RegExp(`^${form.split("{path}").map(escaped).join("(.+)")}$`));
  const settings = readConfigStrict<Json>(join(kit.dir, "harness", harness.id, harness.settings.source));
  const listed = getPath(settings, refusal.at.split("."));
  return (Array.isArray(listed) ? listed : []).flatMap((entry) => {
    const path = forms.map((form) => form.exec(String(entry))?.[1]).find(Boolean);
    return path ? [path] : [];
  });
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every path a seat's file tools may not read, whatever its role and agent, as `~/` paths: the desk's keyed files, and each harness's own. */
export function unreadablePaths(kit: Kit, homeDir: string): string[] {
  const own = Object.values(kit.harnesses).flatMap((harness) =>
    harness.refuses?.reads ? refusedIn(kit, harness, harness.refuses.reads) : [],
  );
  return [...new Set([...keyedPaths(homeDir).map((path) => fromHome(path, homeDir)), ...own])];
}

/** A path under the home folder as agents' rules write one, which holds on every platform. */
const fromHome = (path: string, homeDir: string): string => `~/${relative(homeDir, path).split(sep).join("/")}`;

/** `template` with each `{name}` in its keys and strings replaced. */
function filled(template: unknown, values: Record<string, string>): unknown {
  const fill = (text: string) => text.replace(/\{(\w+)\}/g, (whole, key: string) => values[key] ?? whole);
  if (typeof template === "string") return fill(template);
  if (Array.isArray(template)) return template.map((item) => filled(item, values));
  if (isRecord(template))
    return Object.fromEntries(Object.entries(template).map(([key, value]) => [fill(key), filled(value, values)]));
  return template;
}

/** Each of `items` in the harness's own form, joined as one list or one record, set at `at`. */
function laid(refusal: { at: string; as: unknown }, items: Record<string, string>[]): Json {
  const setting: Json = {};
  setPath(
    setting,
    refusal.at.split("."),
    items.reduce<unknown>((all, values) => layered(all, filled(refusal.as, values)), undefined),
  );
  return setting;
}

/** What the desk refuses a seat, in its agent's settings: the commands its shell may not start and the paths it may not touch. */
export function refusalSettings(kit: Kit, harness: HarnessSpec, role: RoleSpec, homeDir: string): Json {
  const refuses = harness.refuses;
  if (!refuses) return {};
  const { edits, reads } = keptPaths(kit, role, homeDir);
  const paths = (list: string[]) => list.map((path) => ({ path: fromHome(path, homeDir) }));
  const commands = refuses.commands && "at" in refuses.commands ? refuses.commands : undefined;
  return [
    commands
      ? laid(
          commands,
          refusedCommands(kit).map(({ words }) => ({ command: words.join(" ") })),
        )
      : {},
    refuses.edits ? laid(refuses.edits, paths(edits)) : {},
    refuses.reads ? laid(refuses.reads, paths(reads)) : {},
  ].reduce<Json>((all, setting) => layered(all, setting) as Json, {});
}

/** The lines a harness that takes its refused commands in a file of its own adds to that file, by the file's path. */
export function refusalLines(kit: Kit, harness: HarnessSpec): Record<string, string> {
  const commands = harness.refuses?.commands;
  if (!commands || !("file" in commands)) return {};
  const lines = refusedCommands(kit).map(({ words, why }) =>
    commands.line.replace("{words}", JSON.stringify(words)).replace("{why}", JSON.stringify(why)),
  );
  return { [commands.file]: lines.join("\n") };
}
