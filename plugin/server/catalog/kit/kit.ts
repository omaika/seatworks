import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { REVIEW_OFF } from "../../../shared/settings.ts";
import type { Attention } from "../../../shared/views.ts";
import { DESK_OWNED } from "../../core/paths.ts";
import { EcosystemFile } from "./schema/ecosystem.ts";
import { HarnessFile } from "./schema/harness.ts";
import { McpFile } from "./schema/mcp.ts";
import { PaseoFile, RefusedFile, RolesFile } from "./schema/roles.ts";
import { AttentionFile, ChecksFile, PatternsFile, SensorFile } from "./schema/sensor.ts";

type ThinkingSpec = { id: string; label: string; isDefault?: boolean };
export type ModelSpec = { id: string; label: string; isDefault?: boolean; thinkingOptions?: ThinkingSpec[] };
export type McpServers = Record<string, unknown>;

type ListedRole = z.infer<typeof RolesFile>["roles"][number];
type RoleFile = Exclude<ListedRole, { like: string }>;
/** A role as loaded: a follower has taken the defaults of the role it follows, and one `like` another all but its name and defaults. */
export type RoleSpec = Omit<RoleFile, "defaults"> & { defaults: NonNullable<RoleFile["defaults"]>; like?: string };
/** `models` is not the harness file's: Paseo lists them, and the kit holds the last list. */
export type HarnessSpec = z.infer<typeof HarnessFile> & { models?: ModelSpec[] };
export type McpEntry = z.infer<typeof McpFile> & { dir: string };
export type McpTransport = HarnessSpec["mcp"]["transports"][number];
export type Ecosystem = z.infer<typeof EcosystemFile>;
export type ProxySpec = NonNullable<McpEntry["proxy"]>;
export type SensorSpec = z.infer<typeof SensorFile>;
export type CheckSpec = z.infer<typeof ChecksFile>[string];
export type PatternSpec = z.infer<typeof PatternsFile>[string];

export type Kit = {
  dir: string;
  prefix: string;
  roles: RoleSpec[];
  harnesses: Record<string, HarnessSpec>;
  mcp: Record<string, McpEntry>;
  toolSets: Record<string, Record<string, ArgSchema>>;
  own?: string;
  attention: Attention;
  ecosystem: Ecosystem;
  paseoTools: string[];
  refused: Record<string, string>;
  sensors: Record<string, SensorSpec>;
  checks: Record<string, CheckSpec>;
  patterns: Record<string, PatternSpec>;
  problems: string[];
};

function subdirs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

export type ArgSchema = {
  type?: string;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  items?: ArgSchema;
  minItems?: number;
  maxItems?: number;
  properties?: Record<string, ArgSchema>;
  required?: string[];
  description?: string;
};

function loadToolSets(dir: string): Record<string, Record<string, ArgSchema>> {
  const file = join(dir, "mcp", "tools.json");
  if (!existsSync(file)) return {};
  const raw = JSON.parse(readFileSync(file, "utf-8")) as Record<string, { name?: string; inputSchema?: ArgSchema }[]>;
  return Object.fromEntries(
    Object.entries(raw).map(([set, tools]) => [
      set,
      Object.fromEntries(tools.map((tool) => [String(tool.name ?? ""), tool.inputSchema ?? {}])),
    ]),
  );
}

function parsed<T extends z.ZodType>(schema: T, file: string, what: string): z.infer<T> {
  const result = schema.safeParse(JSON.parse(readFileSync(file, "utf-8")));
  if (!result.success) throw new Error(`${what} is not as the kit reads it:\n${z.prettifyError(result.error)}`);
  return result.data;
}

function loadMcp(dir: string): Record<string, McpEntry> {
  const root = join(dir, "catalog", "mcp");
  const entries: Record<string, McpEntry> = {};
  for (const id of subdirs(root)) {
    const file = join(root, id, "mcp.json");
    if (!existsSync(file)) continue;
    const entry = parsed(McpFile, file, `catalog/mcp/${id}/mcp.json`);
    if (entry.id !== id) throw new Error(`catalog/mcp/${id}/mcp.json names itself ${entry.id}`);
    if (entry.rule && !existsSync(join(root, id, entry.rule)))
      throw new Error(`MCP ${id} names rule ${entry.rule}, which is missing`);
    for (const skill of entry.skills ?? []) {
      if (!existsSync(join(root, id, "skills", skill, "SKILL.md")))
        throw new Error(`MCP ${id} names skill ${skill}, but its SKILL.md is missing`);
    }
    entries[id] = { ...entry, dir: join(root, id) };
  }
  return entries;
}

/** The shipped sensors, each replaced by one of the same name in the state root's `sensor` folder, which may add more. */
function loadSensors(dir: string, stateDir?: string): Record<string, SensorSpec> {
  const sensors: Record<string, SensorSpec> = {};
  const roots = [{ root: join(dir, "catalog", "sensor"), shown: "catalog/sensor" }];
  if (stateDir) roots.push({ root: join(stateDir, "sensor"), shown: join(stateDir, "sensor") });
  for (const { root, shown } of roots)
    for (const name of existsSync(root) ? readdirSync(root).filter((entry) => entry.endsWith(".json")) : []) {
      const sensor = parsed(SensorFile, join(root, name), `${shown}/${name}`);
      if (`${sensor.id}.json` !== name) throw new Error(`${shown}/${name} names itself ${sensor.id}`);
      if (sensor.id === REVIEW_OFF)
        throw new Error(`${shown}/${name} takes ${REVIEW_OFF}, the word review's Off is kept as`);
      sensors[sensor.id] = sensor;
    }
  return sensors;
}

/** The state root's copy where it has one, else the shipped file: how an arrangement of the owner's replaces the kit's. */
export function ownOrShipped(own: string | undefined, shipped: string): string {
  return own && existsSync(own) ? own : shipped;
}

function chosen(shipped: string, stateDir?: string): string {
  return ownOrShipped(stateDir && join(stateDir, basename(shipped)), shipped);
}

/** The kit in `dir`, with any file of the same name in `stateDir` replacing the shipped one; throws naming what is wrong. */
export function loadKit(dir: string, stateDir?: string): Kit {
  const raw = parsed(RolesFile, chosen(join(dir, "roles.json"), stateDir), "roles.json");
  const ecosystem = parsed(EcosystemFile, chosen(join(dir, "catalog", "ecosystem.json"), stateDir), "ecosystem.json");
  const harnesses = loadHarnesses(dir);
  const roles = loadRoles(raw.roles, harnesses);
  const refused = parsed(RefusedFile, chosen(join(dir, "catalog", "refused.json"), stateDir), "refused.json");
  checkRefused(refused, harnesses);
  const problems: string[] = [];
  const patterns = watchedPatterns(
    parsed(PatternsFile, chosen(join(dir, "catalog", "patterns.json"), stateDir), "patterns.json"),
    roles,
    problems,
  );
  return {
    dir,
    prefix: raw.providerPrefix ?? "",
    roles,
    harnesses,
    mcp: loadMcp(dir),
    toolSets: loadToolSets(dir),
    own: stateDir ? join(stateDir, "own") : undefined,
    attention: parsed(AttentionFile, chosen(join(dir, "catalog", "attention.json"), stateDir), "attention.json"),
    ecosystem,
    paseoTools: parsed(PaseoFile, chosen(join(dir, "catalog", "paseo.json"), stateDir), "paseo.json").tools,
    refused,
    sensors: loadSensors(dir, stateDir),
    checks: parsed(ChecksFile, chosen(join(dir, "catalog", "checks.json"), stateDir), "checks.json"),
    patterns,
    problems,
  };
}

/**
 * A pattern watches seats by what they can do, and an arrangement of other roles may watch none of it: what no watched role
 * can is reported, and a pattern left watching nothing is left out.
 */
function watchedPatterns(
  patterns: Record<string, PatternSpec>,
  roles: RoleSpec[],
  problems: string[],
): Record<string, PatternSpec> {
  const watched = roles.filter((role) => role.can?.includes("watched"));
  const kept: Record<string, PatternSpec> = {};
  for (const [id, pattern] of Object.entries(patterns)) {
    const unwatched = pattern.watches.filter((capability) => !watched.some((role) => role.can?.includes(capability)));
    const idle = unwatched.length === pattern.watches.length;
    for (const capability of unwatched)
      problems.push(
        `The pattern ${id} watches what can ${capability}, and no watched role in this kit can${idle ? ", so it is left out" : ""}`,
      );
    if (!idle) kept[id] = pattern;
  }
  return kept;
}

function loadHarnesses(dir: string): Record<string, HarnessSpec> {
  const harnesses: Record<string, HarnessSpec> = {};
  for (const id of subdirs(join(dir, "harness"))) {
    const file = join(dir, "harness", id, "harness.json");
    if (!existsSync(file)) continue;
    const harness = parsed(HarnessFile, file, `harness ${id}`);
    if (harness.id !== id) throw new Error(`harness ${id} calls itself ${harness.id} but sits in harness/${id}`);
    harnesses[id] = harness;
  }
  return harnesses;
}

/** Each role with its defaults, a follower taking those of the role it follows; checked against the harnesses there are. */
function loadRoles(given: ListedRole[], harnesses: Record<string, HarnessSpec>): RoleSpec[] {
  const listed = given.map((role) => ("like" in role ? likeRole(role, given) : role));
  const roles = listed.map((role) => {
    if (role.follows === undefined) return role;
    const followed = listed.find((other) => other.role === role.follows);
    if (role.defaults)
      throw new Error(
        `role ${role.role} follows ${role.follows} and names defaults of its own; it takes one or the other`,
      );
    if (!followed || followed === role)
      throw new Error(`role ${role.role} follows ${role.follows}, which is no other role in roles.json`);
    if (followed.follows !== undefined)
      throw new Error(
        `role ${role.role} follows ${role.follows}, which follows ${followed.follows} in turn; a role follows one that chooses for itself`,
      );
    return { ...role, defaults: followed.defaults };
  });
  for (const role of roles) {
    if (!role.defaults) throw new Error(`role ${role.role} has no default harness`);
    const owned = (role.writes ?? []).map((entry) => entry.replace(/\/$/, "")).filter((entry) => DESK_OWNED.has(entry));
    if (owned.length > 0)
      throw new Error(`role ${role.role} writes ${owned.join(", ")}, which is the desk's own record`);
    if (!harnesses[role.defaults.harness])
      throw new Error(
        `role ${role.role} defaults to harness ${role.defaults.harness}, which has no harness/${role.defaults.harness}/harness.json`,
      );
  }
  return roles as RoleSpec[];
}

/** A role like another: that role in all but its name, words, defaults and, when it gives one, its prompt. */
function likeRole(role: Extract<ListedRole, { like: string }>, listed: ListedRole[]): RoleFile & { like: string } {
  const liked = listed.find((other) => other.role === role.like);
  if (!liked || liked === role || "like" in liked)
    throw new Error(`role ${role.role} is like ${role.like}, which is no other role in roles.json that is its own`);
  const { follows: _follows, ...own } = liked;
  return { ...own, ...role, description: role.description ?? liked.description };
}

/** A seat's own agent is started through the PATH these go first on, and its git through the shim: neither may be refused. */
function checkRefused(refused: Record<string, string>, harnesses: Record<string, HarnessSpec>): void {
  for (const name of Object.keys(refused)) {
    const starts = Object.values(harnesses).find((harness) => harness.provider.env?.SEATWORKS_AGENT_BIN === name);
    if (name === "git" || starts)
      throw new Error(
        `refused.json refuses ${name}, which ${starts ? `every ${starts.id} seat is started with` : "the kit's git shim runs"}, through the same PATH`,
      );
  }
}

export const TEAM_SERVER = "team";
export const SEAT_KEY = "SEATWORKS_DESK_KEY";
export const PASEO_SERVER = "paseo";
