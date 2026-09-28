import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { AgentConfig, SessionOpen } from "../../core/ports.ts";
import { type Json, layered, setPath } from "../../core/json.ts";
import {
  type HarnessSpec,
  type Kit,
  type McpServers,
  type ModelSpec,
  PASEO_SERVER,
  type RoleSpec,
} from "../kit/kit.ts";
import { seatOf } from "../kit/roles.ts";
import { modelFor, thinkingFor } from "../team/model-choice.ts";
import type { Team } from "../team/team.ts";
import { preapprovedFor } from "./servers.ts";

type RenderPrompt = (role: RoleSpec) => string;

/** Only what the role declares it writes: state also holds the desk's record, whose `gate` runs unsandboxed in the daemon. */
export function stateWrites(role: RoleSpec, state: string): string[] {
  return (role.writes ?? []).map((entry) => join(state, entry.replace(/\/$/, "")));
}

export function applyRole(
  kit: Kit,
  team: Team,
  config: AgentConfig,
  render: RenderPrompt,
  state?: string,
  servers: McpServers = {},
): AgentConfig {
  const seat = seatOf(kit, config.provider);
  if (!seat) return config;
  const { role, harness } = seat;
  const next: AgentConfig = { ...config };
  const { model, preferred } = modelOf(kit, team, config, role, harness);
  if (model) next.model = model.id;
  if (harness.provider.profileModeId) next.modeId = harness.provider.profileModeId;
  const thinking = thinkingFor(harness, model, preferred, config.thinkingOptionId);
  if (thinking !== undefined) next.thinkingOptionId = thinking;
  else delete next.thinkingOptionId;
  const prompt = render(role);
  next.systemPrompt = config.systemPrompt ? `${prompt}\n\n${config.systemPrompt}` : prompt;
  if (harness.mcp.delivery === "launch" && Object.keys(servers).length > 0) {
    next.mcpServers = { ...(config.mcpServers ?? {}), ...servers };
    if (harness.mcp.preapprove) {
      const preapproved = preapprovedFor(kit, team, role.role);
      next.toolPolicy = {
        preapproved: preapproved.filter((ref) => ref.server in servers || ref.server === PASEO_SERVER),
      };
    }
  }
  const providerOptions = providerOptionsOf(harness, role, config, state);
  if (providerOptions !== config.providerOptions) next.providerOptions = providerOptions;
  return next;
}

/** Paseo's model where the catalog lists it, else the team's for the role on this harness, else the agent's default; and the thinking the team chose for that model. */
function modelOf(
  kit: Kit,
  team: Team,
  config: AgentConfig,
  role: RoleSpec,
  harness: HarnessSpec,
): { model?: ModelSpec; preferred?: string } {
  const chosen = team.roles[role.role];
  const own = chosen?.harness.id === harness.id ? chosen : undefined;
  const listed = (harness.models ?? []).find((entry) => entry.id === config.model);
  const model = listed ?? own?.model ?? modelFor(harness, undefined, kit.roles);
  return { model, preferred: own && own.model?.id === model?.id ? own.thinking : undefined };
}

/** The paths the role writes under the state, and the project as its context, where the harness takes them at launch. */
function providerOptionsOf(
  harness: HarnessSpec,
  role: RoleSpec,
  config: AgentConfig,
  state: string | undefined,
): Json | undefined {
  let options = config.providerOptions;
  if (harness.stateWrites?.delivery === "launch" && state)
    for (const path of stateWrites(role, state)) options = appendAt(options, harness.stateWrites.path, path);
  if (harness.projectContextOption && config.cwd) options = appendAt(options, harness.projectContextOption, config.cwd);
  return options;
}

/** `options` with `value` added to the list at the dot path `path`, the records on the way copied rather than changed. */
function appendAt(options: Json | undefined, path: string, value: string): Json {
  const added: Json = {};
  setPath(added, path.split("."), [value]);
  return layered(options, added) as Json;
}

/** Each of `imports` the project has, unless a file its agent reads there takes it in already: Claude reads AGENTS.md only where there is no CLAUDE.md. */
export function projectImports(harness: HarnessSpec, root: string | undefined): string {
  const spec = harness.projectInstructions;
  if (!spec || !root) return "";
  const read = spec.reads
    .filter((file) => existsSync(join(root, file)))
    .map((file) => readFileSync(join(root, file), "utf-8"))
    .join("\n");
  return spec.imports
    .filter((file) => existsSync(join(root, file)) && !new RegExp(`@(\\./)?${escaped(file)}\\b`).test(read))
    .map((file) => `${spec.importAs.replace("{path}", join(root, file))}\n`)
    .join("");
}

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `env` with `name` under that spelling alone: Windows reads a variable's name in any case, and a spread keeps each. */
function setAlone(env: Record<string, string>, name: string, value: string): void {
  for (const key of Object.keys(env)) if (key !== name && key.toUpperCase() === name) delete env[key];
  env[name] = value;
}

/**
 * The harness's own env too, as Paseo may run one agent server for every seat of a harness; TMPDIR, where every seat is told
 * its scratch files go, is always set, as Linux services and Windows often have none, and on Windows TEMP and TMP, which
 * its tools and shells read there, name it too. `shim` goes first on the PATH Paseo gave the seat.
 */
export function seatEnv(
  kit: Kit,
  request: SessionOpen,
  seatPath: string,
  project: { root: string; state: string },
  shim?: string,
): SessionOpen {
  const seat = seatOf(kit, request.provider);
  if (!seat) return request;
  const scratch = request.env.TMPDIR ?? tmpdir();
  const env: Record<string, string> = {
    ...request.env,
    ...seat.harness.provider.env,
    [seat.harness.configDirEnv]: seatPath,
    ...(seat.harness.settings.overlayEnv
      ? { [seat.harness.settings.overlayEnv]: join(seatPath, seat.harness.settings.file) }
      : {}),
    TMPDIR: scratch,
    SEATWORKS_ROLE: seat.role.role,
    SEATWORKS_KIT: kit.dir,
    SEATWORKS_PROJECT: project.root,
    SEATWORKS_STATE: project.state,
  };
  if (process.platform === "win32") for (const name of ["TEMP", "TMP"]) setAlone(env, name, scratch);
  if (shim) {
    const given = Object.entries(request.env).find(([key]) => key.toUpperCase() === "PATH")?.[1];
    setAlone(env, "PATH", [shim, given ?? process.env.PATH].filter(Boolean).join(delimiter));
  }
  return { ...request, env };
}
