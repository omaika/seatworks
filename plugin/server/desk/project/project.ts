import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { gitCommonDir, trackedFiles } from "../../core/git.ts";
import { LAND_AS, type LandAs } from "../../core/land.ts";
import { type Json, getPath, isRecord } from "../../core/json.ts";
import { stateRoot } from "../../core/paths.ts";
import { keptFault, readKept, writeJson } from "../../core/store.ts";
import type { Ecosystem, Kit } from "../../catalog/kit/kit.ts";
import { RiskRule } from "../../catalog/kit/schema/ecosystem.ts";
import { coverOf, serialPaths } from "../../core/scope.ts";

export type Project = { root: string; slug: string; state: string };

type GateOn = "lane" | "task";

export const LANE_HOMES = ["onBranch", "newBranch", "isolate"] as const;
/** Where a lane works when the call opening it does not say: the standing answer to the question status asks. */
export type LaneHome = (typeof LANE_HOMES)[number];

/**
 * `serialOnly` and `riskRules` are the project's own when it set them; without, the kit's hold, so a change to the kit
 * reaches it. `askFirst` is the Human's standing order: a landing that touches one of these paths waits for them.
 */
export type ProjectConfig = {
  base?: string;
  gate?: string;
  gateTimeoutMinutes: number;
  gateOn: GateOn;
  serialOnly?: string[];
  landAs: LandAs;
  laneHome?: LaneHome;
  askFirst: string[];
  riskRules?: RiskRule[];
  setup?: string;
};

/** `project.json` as the desk writes it: a field there that does not read is a fault, never a default in its place. */
const ProjectFile = z.strictObject({
  base: z.string().optional(),
  gate: z.string().optional(),
  gateTimeoutMinutes: z.number().positive().optional(),
  gateOn: z.enum(["lane", "task"]).optional(),
  serialOnly: z.array(z.string()).optional(),
  landAs: z.enum(LAND_AS).optional(),
  laneHome: z.enum(LANE_HOMES).optional(),
  askFirst: z.array(z.string()).optional(),
  riskRules: z.array(RiskRule).optional(),
  setup: z.string().optional(),
});

/** Each field of `project.json`, as a call that sets some of them names them. */
export type ProjectFields = z.output<typeof ProjectFile>;

/** Enough for every copy a machine keeps at once: copy paths are never reused, so the cache is bounded. */
const CACHED_PROJECTS = 512;
const cache = new Map<string, Project>();

export function gitRoot(cwd: string): string {
  const common = gitCommonDir(cwd);
  if (!common) return cwd;
  return basename(common) === ".git" ? dirname(common) : common;
}

function slugFor(root: string): string {
  const name =
    basename(root)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "project";
  return `${name}-${createHash("sha1").update(root).digest("hex").slice(0, 6)}`;
}

export function projectOf(cwd: string, base = stateRoot(), rootOf: (cwd: string) => string = gitRoot): Project {
  const key = `${base}\n${cwd}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const root = rootOf(cwd);
  const slug = slugFor(root);
  const project = { root, slug, state: join(base, "projects", slug) };
  cache.set(key, project);
  if (cache.size > CACHED_PROJECTS) cache.delete(cache.keys().next().value!);
  return project;
}

function scriptBody(file: string, name: string): string | undefined {
  try {
    const body = getPath(JSON.parse(readFileSync(file, "utf-8")) as unknown, ["scripts", name]);
    return typeof body === "string" ? body : undefined;
  } catch {
    return undefined;
  }
}

/** A script a package file names, unless it is the placeholder its tool writes when there is none. */
function scriptIn(file: string, name: string, unset: string): boolean {
  const body = scriptBody(file, name);
  return body !== undefined && !body.includes(unset);
}

/**
 * The first of the ecosystem's gates for this platform whose files the project holds; one running a package script needs
 * the script.
 */
export function detectGate(root: string, ecosystem: Ecosystem): string | undefined {
  const has = (name: string) => existsSync(join(root, name));
  for (const gate of ecosystem.gates) {
    if (gate.platforms && !gate.platforms.some((platform) => platform === process.platform)) continue;
    const file = gate.files.find(has);
    if (!file || (gate.script && !scriptIn(join(root, file), gate.script, ecosystem.unsetScript))) continue;
    return Object.entries(gate.lockfiles ?? {}).find(([lockfile]) => has(lockfile))?.[1] ?? gate.run;
  }
  return undefined;
}

/** The commands that run `gate`: it, then the test runner its script starts, as a seat runs its own module's tests. */
export function gateCommands(root: string, gate: string | undefined, ecosystem: Ecosystem): string[] {
  if (!gate?.trim()) return [];
  const script = new RegExp(`^(?:${ecosystem.scriptRunners.join("|")})(?: run)? ([\\w:.-]+)$`).exec(gate.trim())?.[1];
  const body = script ? scriptBody(join(root, "package.json"), script) : undefined;
  if (body === undefined) return [gate];
  // The script's last command runs the tests; its runner is the program plus at most one word, never a path.
  const words = body
    .split(/&&|\|\||;/)
    .at(-1)!
    .trim()
    .split(/\s+/)
    .slice(0, 2);
  const runner = words.slice(0, words.findIndex((word) => !/^[\w@.:-]+$/.test(word)) >>> 0).join(" ");
  return runner && runner !== gate ? [gate, runner] : [gate];
}

export function configFile(state: string): string {
  return join(state, "project.json");
}

/** The Supervisor alone writes it; a Lead is pointed at it once there is one. */
export function conceptFile(state: string): string | undefined {
  const file = join(state, "CONTEXT.md");
  return existsSync(file) ? file : undefined;
}

/**
 * The project's standing orders from one read, absent ones their defaults, or why they cannot be read: a landing
 * then waits for the Human, and the watch reads the seat without them.
 */
export function readProjectConfig(state: string): { config: ProjectConfig } | { fault: string } {
  const file = configFile(state);
  const read = readKept<Json>(file, {}, isRecord);
  if ("fault" in read) return read;
  const parsed = ProjectFile.safeParse(read.value);
  if (parsed.success) return { config: configOf(parsed.data) };
  const issue = parsed.error.issues[0]!;
  return { fault: `${file} does not hold what the plugin keeps there: ${issue.path.join(".")}: ${issue.message}` };
}

/** The project's standing orders; ones that cannot be read throw, not stand in as defaults the Human never set. */
export function loadConfig(state: string): ProjectConfig {
  const read = readProjectConfig(state);
  if ("fault" in read) throw keptFault(read.fault);
  return read.config;
}

/** How long a git step the desk runs for the project may take: a large repository checks out and merges slowly too. */
export const gitTimeout = (project: Project) => loadConfig(project.state).gateTimeoutMinutes * 60_000;

/** An empty gate is the project's answer, kept by a read: undefined, open_lane would seed a detected gate over it. */
function configOf(stored: ProjectFields): ProjectConfig {
  return {
    base: stored.base || undefined,
    gate: stored.gate,
    gateTimeoutMinutes: stored.gateTimeoutMinutes ?? 30,
    gateOn: stored.gateOn ?? "task",
    serialOnly: Array.isArray(stored.serialOnly) ? stored.serialOnly.map(String) : undefined,
    landAs: stored.landAs ?? "squash",
    laneHome: stored.laneHome,
    askFirst: stored.askFirst ?? [],
    riskRules: stored.riskRules,
    setup: stored.setup || undefined,
  };
}

/**
 * Where the next lane works in a project whose own copy is free: as its call or the standing choice says, or else
 * the question of where, which is real only over uncommitted work or a branch that is not the base.
 */
export function laneHomeFor(
  asked: LaneHome | undefined,
  config: ProjectConfig,
  branch: string | undefined,
  work: string[] | undefined,
): LaneHome | { question: string } {
  const chosen = asked ?? config.laneHome;
  if (chosen === "onBranch" || chosen === "isolate") return chosen;
  // A new branch here would be switched to over the Human's uncommitted work, so that choice cannot hold over some.
  if (!branch || !work || (chosen === "newBranch" && work.length === 0)) return "newBranch";
  if (work.length > 0)
    return {
      question: `carry on ${branch} here (onBranch), a new branch that takes the uncommitted work along (onBranch with newBranch), or a copy of its own that leaves it where it is (isolate)`,
    };
  if (!config.base || branch === config.base) return "newBranch";
  return {
    question: `carry on ${branch} here (onBranch), a new branch off ${config.base} here (isolate false), or a copy of its own (isolate)`,
  };
}

export function serialOnlyOf(project: Project, kit: Kit): string[] {
  return loadConfig(project.state).serialOnly ?? kit.ecosystem.serialOnly;
}

/**
 * The paths of `cwd` one writer at a time may write, as git tracks them now; where git cannot list the copy, every
 * rule counts as matched, so the protection holds rather than lapses.
 */
export async function serialIn(kit: Kit, project: Project, cwd: string): Promise<string[]> {
  const rules = serialOnlyOf(project, kit);
  const tracked = await trackedFiles(cwd);
  return tracked ? serialPaths(tracked, rules) : rules;
}

export function riskRulesOf(project: Project, kit: Kit): RiskRule[] {
  return loadConfig(project.state).riskRules ?? kit.ecosystem.riskRules;
}

/** The rules whose paths cover any of `files`: what a review of them must answer, and what rehearses them. */
export function rulesFor(rules: RiskRule[], files: string[]): RiskRule[] {
  return rules.filter((rule) => rule.paths.map(coverOf).some((cover) => files.some((file) => cover.test(file))));
}

export function saveConfig(state: string, config: ProjectConfig): void {
  writeJson(configFile(state), config);
}
