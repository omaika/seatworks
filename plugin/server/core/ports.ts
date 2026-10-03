export type SeatView = {
  id: string;
  title?: string | null;
  provider: string;
  cwd: string;
  status: string;
  updatedAt: string;
  createdAt?: string;
  archivedAt?: string | null;
  labels?: Record<string, string>;
  pendingPermissions?: PendingPermission[];
  lastUsage?: SeatUsage | null;
};

/** What a seat's agent reports of its use, where it reports any: Claude's cost counts from when its agent started. */
type SeatUsage = { totalCostUsd?: number; contextWindowUsedTokens?: number; contextWindowMaxTokens?: number };

/** Whether a seat is in a turn; one still starting is, since its first turn is already under way. */
export function midTurn(status: string | null | undefined): boolean {
  return status === "running" || status === "initializing";
}

export type PendingPermission = {
  id: string;
  kind?: string;
  name?: string;
  title?: string;
  description?: string;
  input?: Record<string, unknown>;
};

export type PermissionResponse =
  { behavior: "allow"; updatedInput?: Record<string, unknown> } | { behavior: "deny"; message?: string };

export type SeatLook = {
  id: string;
  provider?: string;
  title?: string | null;
  cwd?: string | null;
  status?: string | null;
  archivedAt?: string | null;
  pendingPermissions?: PendingPermission[];
};

export type SeatSpec = {
  config: Record<string, unknown>;
  parent?: string;
  title: string;
  prompt: string;
  labels: Record<string, string>;
};

/** One timeline entry, whole: `seqStart` is its first source row and `seq` its last, so one read back after a gap can restate rows already told. */
export type StreamRow = {
  item: Record<string, unknown>;
  seqStart: number;
  seq: number;
  epoch: string;
  turnId: string | null;
  replay: boolean;
};

/** `idle`: when the seat was last read it was in no turn, so a turn whose end went unseen is over; `lost`: the stream failed and stopped. */
export type Seen =
  | { kind: "row"; row: StreamRow }
  | {
      kind: "turn";
      phase: "started" | "completed" | "failed" | "canceled";
      turnId: string | null;
      error?: string;
      at?: number;
    }
  | { kind: "idle" }
  | { kind: "reset" }
  | { kind: "lost"; error: string };

export type Stream = { readonly ready: Promise<void>; stop(): void };

/** A row of the plugin's own in a seat's chat: posting one again under the same id replaces it where it stands. */
export type ChatCard = { id: string; kind: string; version: number; data: unknown };

export type Seats = {
  open(): Promise<SeatView[]>;
  look(id: string): Promise<SeatLook>;
  /** Never into a running turn, unless `into` cuts that turn short for it. */
  send(id: string, text: string, kinds: string[], into?: "interrupt"): Promise<void>;
  /** The last `limit` entries of the seat's history, whole, as Paseo projects them; an archived seat is started again to read it. */
  history(id: string, limit: number): Promise<StreamRow[]>;
  respond(id: string, requestId: string, response: PermissionResponse): Promise<void>;
  archive(id: string): Promise<void>;
  watch(id: string, see: (seen: Seen) => void): Stream;
  post(id: string, card: ChatCard): Promise<void>;
};

export type Workspace = { id: string; project: string };

export type Workspaces = {
  /** The folder as Paseo's own project list shows it: its workspace found, or made. */
  open(path: string): Promise<Workspace>;
  named(name: string): Promise<Workspace | undefined>;
  owned(prefix: string): Promise<{ id: string; name: string }[]>;
  make(title: string, path: string, project?: string): Promise<Workspace>;
  retitle(workspace: string, title: string): Promise<void>;
  seat(workspace: string, spec: SeatSpec): Promise<SeatLook>;
  archive(workspace: string): Promise<void>;
};

export type HookAgent = { id: string; provider: string; cwd: string; title?: string | null };

export type TimelineItem = {
  readonly type: string;
  readonly text?: unknown;
  readonly status?: unknown;
  readonly error?: unknown;
  readonly name?: unknown;
  readonly detail?: unknown;
  readonly callId?: unknown;
};

export type TurnEnded = {
  agent: HookAgent;
  turnId: string | null;
  outcome: { kind: "completed" } | { kind: "failed"; error: { message: string } } | { kind: "canceled" };
  timeline: readonly TimelineItem[];
};

export type PermissionRequested = { agent: HookAgent; request: PendingPermission };

/** Creating an agent, so far as a seat's launch sets it; Paseo's request holds more, and the rest passes through unchanged. */
export type AgentConfig = {
  provider: string;
  cwd: string;
  model?: string;
  modeId?: string;
  thinkingOptionId?: string;
  systemPrompt?: string;
  mcpServers?: Record<string, unknown>;
  toolPolicy?: { preapproved: { kind: string; server: string; tool: string }[] };
  providerOptions?: Record<string, unknown>;
};

export type SessionOpen = {
  agentId: string;
  reason: "create" | "resume" | "refresh" | "import";
  /** `history`: Paseo loads the agent only to show its past, and no agent runs. */
  purpose: "interactive" | "history";
  provider: string;
  cwd: string;
  env: Record<string, string>;
};

export type HostHooks = {
  create(config: AgentConfig, env: Record<string, string>): { config: AgentConfig; env: Record<string, string> };
  sessionOpen(request: SessionOpen): SessionOpen;
  turnStarted(agent: HookAgent): Promise<void>;
  turnEnded(event: TurnEnded): Promise<void>;
  permissionRequested(event: PermissionRequested): Promise<void>;
  created(agent: HookAgent): Promise<void>;
  archived(agent: HookAgent): Promise<void>;
};

export type ModelList = {
  models?: {
    id: string;
    label: string;
    isSelectable?: boolean;
    thinkingOptions?: { id: string; label: string }[];
    defaultThinkingOptionId?: string;
  }[];
  error?: string | null;
};

export type Models = {
  refresh(provider: string, cwd: string): Promise<void>;
  list(provider: string, cwd: string): Promise<ModelList>;
};

/** Paseo's own config as its API reads it, so far as the plugin touches it. */
export type DaemonConfig = {
  providers?: Record<string, Record<string, unknown>>;
  agentProfiles?: ({ id?: unknown } & Record<string, unknown>)[];
};

/** A change to Paseo's config: providers merged into those it holds, ids removed, the profile list replaced whole. */
export type ConfigPatch = {
  providers?: Record<string, Record<string, unknown>>;
  removeProviders?: string[];
  agentProfiles?: Record<string, unknown>[];
};

/** Paseo checks, saves and applies a patch at once, with no reload; both wait for Paseo's API to reach the plugin. */
export type PaseoConfig = {
  read(): Promise<DaemonConfig>;
  patch(change: ConfigPatch): Promise<void>;
};

/** Paseo as the plugin reaches it; `connected` is false, and `reached` unsettled, until a hook or a panel call has handed over its API. */
export type Host = {
  connected(): boolean;
  reached(): Promise<void>;
  /** Paseo's own tools as it lists them to its agents, or why they could not be listed; none where the desk cannot ask. */
  tools(): Promise<{ names: string[] } | { error: string } | undefined>;
  seats: Seats;
  workspaces: Workspaces;
  models: Models;
  config: PaseoConfig;
};

/** A question as the catalog words it, the fields the code fills filled: one condition, or a pick among its criteria. */
export type Question = {
  type: "condition" | "pick";
  instructions: string | Record<string, string>;
  criteria: Record<string, string>;
};

/** A condition's answer is how likely it holds, from 0 to 1; a pick's, the criterion picked and how sure of it. */
export type Answer = { likely: number } | { pick: string; confidence: number };

export type Judgement = {
  answers: Record<string, Answer>;
  model: string;
  tokens?: number;
  why?: Record<string, string>;
};

export type Judge = { ask(state: Record<string, unknown>, questions: Record<string, Question>): Promise<Judgement> };

/** A project's code index as a seat's IDE tools reach it: opened for a copy, kept in step, closed with it. */
export type CodeIndex = {
  id: string;
  gitExclude: string[];
  open(path: string): Promise<{ ok: boolean; text: string }>;
  sync(path: string): Promise<{ ok: boolean; text: string }>;
  close(path: string): Promise<{ ok: boolean; text: string }>;
};

/** "duplicate": dropped as a repeat of a letter already sent. */
export type Posted = "sent" | "held" | "duplicate";

/** `withdraw` takes back a letter still held for `to`: whether it was. */
export type Mailer = {
  post(letter: { to: string; key: string; text: string; wakes?: false }): Promise<Posted>;
  withdraw(to: string, key: string): Promise<boolean>;
};
