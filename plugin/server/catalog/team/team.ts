import { availableParallelism } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Layer, REVIEW_OFF } from "../../../shared/settings.ts";
import type { Attention, Hitl } from "../../../shared/views.ts";
import type { HarnessSpec, Kit, SensorSpec } from "../kit/kit.ts";
import { type McpState, resolveMcp } from "./mcp-states.ts";
import { presetOn } from "./model-choice.ts";
import { type RoleSeat, resolveRole } from "./role-seats.ts";
import { can, seatedAs } from "../kit/roles.ts";

/**
 * The brains that read what the watch's eye sees: the sensor, with its key where a layer keeps one, and the role that
 * judges; `mode` says which of them read.
 */
type Brains = {
  mode: "off" | "sensor" | "seat" | "both";
  sensor?: { id: string; sensor: SensorSpec; key?: string };
  seat?: string;
};

/** The sensor that asks review's checks, with its key where the machine keeps one; none when off or the kit knows no such sensor. */
type ReviewJudge = { off: boolean; sensor?: { id: string; sensor: SensorSpec; key?: string } };

/** The kit as the machine's and the project's settings leave it: each role's seat, the MCP servers, attention and the judges. */
export type Team = {
  roles: Record<string, RoleSeat>;
  mcp: Record<string, McpState>;
  attention: Attention;
  hitl: Hitl;
  brains: Brains;
  review: ReviewJudge;
  rules: string;
  language?: string;
  gatesAtOnce: number;
  errors: string[];
};

const QUESTIONS_PER_DAY = 3;

/** `unread` layers are reported, since resolving to nothing looked like a complete team the owner never wrote. */
export function resolveTeam(kit: Kit, machine: Layer = {}, project: Layer = {}, unread: string[] = []): Team {
  const errors: string[] = [...kit.problems, ...unread];
  const layers = [machine, project];
  layers.forEach((layer, index) => {
    const where = index === 0 ? "The machine settings" : "The project settings";
    for (const name of Object.keys(layer.roles ?? {}))
      if (!kit.roles.some((role) => role.role === name)) errors.push(`${where} name an unknown role ${name}`);
  });
  const mcp = resolveMcp(kit, layers, errors);
  const roles = resolveRoles(kit, layers, mcp, errors);
  const attention = {
    ...kit.attention,
    ...stripUndefined(machine.attention),
    ...stripUndefined(project.attention),
  };
  // Questions are counted across every project, so only the machine can say how many a day the Human takes.
  if (project.hitl?.questionsPerDay !== undefined)
    errors.push(
      "The project settings set hitl.questionsPerDay, which only the machine's can: it counts every project's",
    );
  const hitl = {
    on: project.hitl?.on ?? machine.hitl?.on ?? false,
    questionsPerDay: machine.hitl?.questionsPerDay ?? QUESTIONS_PER_DAY,
  };
  if (project.gatesAtOnce !== undefined)
    errors.push(
      "The project settings set gatesAtOnce, which only the machine's can: every project's gates share its processors",
    );
  if (project.language !== undefined)
    errors.push(
      "The project settings set language, which only the machine's can: the Human is the same in every project",
    );
  return {
    roles,
    mcp,
    attention,
    hitl,
    brains: brainsOf(kit, attention, layers, errors),
    review: reviewOf(kit, layers, errors),
    rules: [machine.rules, project.rules].filter((text) => text && text.trim()).join("\n\n"),
    ...(machine.language ? { language: machine.language } : {}),
    gatesAtOnce: machine.gatesAtOnce ?? Math.max(1, Math.floor(availableParallelism() / 2)),
    errors,
  };
}

/** Each role's seat; a role that follows another starts from what that role has in force. */
function resolveRoles(
  kit: Kit,
  layers: Layer[],
  mcp: Record<string, McpState>,
  errors: string[],
): Record<string, RoleSeat> {
  const own: Record<string, RoleSeat> = {};
  for (const role of kit.roles) {
    if (role.follows !== undefined) continue;
    const seat = resolveRole(kit, role, layers, mcp, errors);
    if (seat) own[role.role] = seat;
  }
  const roles: Record<string, RoleSeat> = {};
  for (const role of kit.roles) {
    const followed = role.follows === undefined ? undefined : own[role.follows];
    const origin = followed
      ? { harness: followed.harness.id, model: followed.model?.id, thinking: followed.thinking }
      : undefined;
    const seat = role.follows === undefined ? own[role.role] : resolveRole(kit, role, layers, mcp, errors, origin);
    if (seat) roles[role.role] = seat;
  }
  return roles;
}

/** The brains the settings chose, each only where the kit has it: a sensor by its id, a seat by a role that can judge; none with the watch off. */
function brainsOf(kit: Kit, attention: Attention, layers: Layer[], errors: string[]): Brains {
  const mode = attention.watch ? attention.brain : "off";
  if (mode === "off") return { mode };
  const judges = kit.roles.filter((role) => can(role, "judge")).map((role) => role.role);
  const seat = judges[0];
  if ((mode === "seat" || mode === "both") && !seat)
    errors.push(`The watch's brain is ${mode}, but no role in this kit can judge`);
  const found = kit.sensors[attention.sensor];
  if ((mode === "sensor" || mode === "both") && !found)
    errors.push(
      `The watch's sensor is ${attention.sensor || "not named"}, which is no sensor the kit knows (${Object.keys(kit.sensors).join(", ") || "none"})`,
    );
  const key = layers
    .map((layer) => layer.sensor?.[attention.sensor]?.key)
    .filter(Boolean)
    .at(-1);
  return {
    mode,
    ...(found && mode !== "seat" ? { sensor: { id: attention.sensor, sensor: found, ...(key ? { key } : {}) } } : {}),
    ...(seat && mode !== "sensor" ? { seat } : {}),
  };
}

/** Review's own sensor, the kit's where no layer names one, or off where the last to choose says so; the watch's brains never decide it. */
function reviewOf(kit: Kit, layers: Layer[], errors: string[]): ReviewJudge {
  const id =
    layers
      .map((layer) => layer.review?.sensor)
      .filter(Boolean)
      .at(-1) ?? kit.attention.sensor;
  if (id === REVIEW_OFF) return { off: true };
  const found = kit.sensors[id];
  if (!found) {
    if (id) errors.push(`Review's sensor is ${id}, which is no sensor the kit knows`);
    return { off: false };
  }
  const key = layers
    .map((layer) => layer.sensor?.[id]?.key)
    .filter(Boolean)
    .at(-1);
  return { off: false, sensor: { id, sensor: found, ...(key ? { key } : {}) } };
}

function stripUndefined<T extends object>(value: T | undefined): Partial<T> {
  return Object.fromEntries(Object.entries(value ?? {}).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}

/** The team with one role moved to another harness: its preset where the harness is its own, else that harness's default. */
export function withHarness(team: Team, roleName: string, harness: HarnessSpec): Team {
  const seat = team.roles[roleName];
  if (!seat || seat.harness.id === harness.id) return team;
  const roles = Object.values(team.roles).map((entry) => entry.role);
  const { model, thinking } = presetOn(seat.role, harness, roles);
  return { ...team, roles: { ...team.roles, [roleName]: { ...seat, harness, model, thinking } } };
}

/** A server needing what the project lacks (an IDE's folder) is switched off, or a Peer is told to use a tool that cannot answer. */
export function servingProject(team: Team, root: string): Team {
  const lacking = new Set(
    Object.values(team.mcp)
      .filter((state) => state.enabled && (state.entry?.requires ?? []).some((path) => !existsSync(join(root, path))))
      .map((state) => state.id),
  );
  if (lacking.size === 0) return team;
  return {
    ...team,
    mcp: Object.fromEntries(
      Object.entries(team.mcp).map(([id, state]) => [id, lacking.has(id) ? { ...state, enabled: false } : state]),
    ),
    roles: Object.fromEntries(
      Object.entries(team.roles).map(([name, seat]) => [
        name,
        { ...seat, mcp: seat.mcp.filter((id) => !lacking.has(id)) },
      ]),
    ),
  };
}

export function rulesFor(team: Team, roleName: string): string {
  const seat = team.roles[roleName];
  if (!seat) return "";
  const parts: string[] = [];
  const as = seatedAs(seat.role);
  for (const id of seat.mcp) {
    const state = team.mcp[id]!;
    const { entry } = state;
    const lines: string[] = [];
    const rule = state.rule ?? (entry?.rule ? readFileSync(join(entry.dir, entry.rule), "utf-8").trim() : "");
    if (rule.trim()) lines.push(rule.trim());
    const tools = entry?.kind === "proxy" ? ((state.tools ?? entry.tools)?.[as] ?? []) : [];
    if (tools.length > 0) lines.push(`Your ${state.label} tools: ${tools.map((tool) => `\`${tool}\``).join(", ")}.`);
    const note = entry?.roleNotes?.[as];
    if (note) lines.push(note);
    if (lines.length > 0) parts.push(lines.join("\n\n"));
  }
  if (team.language && can(seat.role, "supervise"))
    parts.push(
      `## The Human's language\n\nSpeak to the Human in ${team.language}. Write to the rest of the team in English, which it works in and the watch reads.`,
    );
  if (team.rules) parts.push(`## Rules from the Human\n\n${team.rules.trim()}`);
  if (seat.rules) parts.push(`## Rules from the Human, for the ${seat.role.label}\n\n${seat.rules}`);
  return parts.length > 0 ? `# Working rules\n\n${parts.join("\n\n")}\n` : "";
}

export function skillDirsFor(team: Team, roleName: string): Map<string, string> {
  const found = new Map<string, string>();
  const seat = team.roles[roleName];
  if (!seat) return found;
  for (const id of seat.mcp) {
    const { entry } = team.mcp[id]!;
    if (entry) for (const skill of entry.skills ?? []) found.set(skill, join(entry.dir, "skills", skill));
  }
  return found;
}
