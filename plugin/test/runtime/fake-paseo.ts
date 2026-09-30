import type { ConfigPatch, DaemonConfig } from "../../server/core/ports.ts";
import { FakeTimeline } from "./fake-timeline.ts";

export type Pending = {
  id: string;
  kind: string;
  name: string;
  title?: string;
  description?: string;
  input?: Record<string, unknown>;
};
type Fake = {
  id: string;
  provider: string;
  cwd: string;
  title: string;
  status: string;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  sent: string[];
  sentIds: string[];
  steered: string[];
  interrupted: string[];
  pending: Pending[];
  answered: {
    requestId: string;
    response: { behavior: string; message?: string; updatedInput?: { answers?: Record<string, string> } };
  }[];
  prompt?: string;
  promptId?: string;
  labels: Record<string, string>;
  workspaceId?: string;
};

type Held = { providers: Record<string, Record<string, unknown>>; agentProfiles?: Record<string, unknown>[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function deepMerge(held: Record<string, unknown>, change: Record<string, unknown>): Record<string, unknown> {
  const next = { ...held };
  for (const [key, value] of Object.entries(change)) {
    if (value === undefined) continue;
    const current = next[key];
    next[key] = isRecord(current) && isRecord(value) ? deepMerge(current, value) : value;
  }
  return next;
}

/**
 * Paseo's config API as the daemon keeps the config in memory (daemon-config-store.js, provider-registry.js): a patch
 * merges in at every depth, the providers it removes go after that merge, the profile list is replaced whole, and a
 * provider of no built-in agent that names none to extend refuses the whole patch.
 */
export function fakeConfig(initial: DaemonConfig = {}) {
  let held: Held = structuredClone({ providers: {}, ...initial });
  const builtIn = new Set(["claude", "codex", "copilot", "opencode", "pi", "omp"]);
  const patches: ConfigPatch[] = [];
  const api = {
    async get() {
      return { requestId: "get", config: structuredClone(held) };
    },
    async patch(change: ConfigPatch) {
      patches.push(structuredClone(change));
      const { removeProviders = [], ...rest } = change;
      const next = structuredClone(deepMerge(held, rest)) as Held;
      for (const id of removeProviders) delete next.providers[id];
      for (const [id, provider] of Object.entries(next.providers))
        if (!builtIn.has(id) && !provider.extends) throw new Error(`Custom provider '${id}' requires an extends value`);
      held = next;
      return { requestId: "patch", config: structuredClone(held) };
    },
  };
  /** Whether an agent can be made on `provider`, which Paseo refuses for one its config does not hold. */
  const configured = (provider: string) => builtIn.has(provider) || provider in held.providers;
  return { api, held: () => held, patches, configured };
}

/** Paseo as the harness runs it: its agents, workspaces and timelines in memory, answering as the daemon would. */
export function fakePaseo() {
  const config = fakeConfig();
  const agents = new Map<string, Fake>();
  const workspaces = new Map<string, string>();
  const workspaceNames = new Map<string, string>();
  const workspaceProjects = new Map<string, string>();
  const archivedWorkspaces = new Set<string>();
  const timelines = new Map<string, InstanceType<typeof FakeTimeline>>();
  const timelineOf = (id: string) => {
    const found = timelines.get(id) ?? new FakeTimeline();
    timelines.set(id, found);
    return found;
  };
  let count = 0;
  const ref = (id: string) => {
    const agent = agents.get(id);
    return {
      id,
      timeline: timelineOf(id),
      get status() {
        return agent?.status ?? null;
      },
      get cwd() {
        return agent?.cwd ?? null;
      },
      get archivedAt() {
        return agent?.archivedAt ?? null;
      },
      get pendingPermissions() {
        return agent?.pending ?? [];
      },
      async refresh() {},
      current() {
        return agent ? { id: agent.id, provider: agent.provider, cwd: agent.cwd, title: agent.title } : null;
      },
      async send(text: string, options?: { activeTurnBehavior?: string; messageId?: string }) {
        agent?.sent.push(text);
        if (options?.messageId) agent?.sentIds.push(options.messageId);
        if (options?.activeTurnBehavior === "steer") agent?.steered.push(text);
        if (options?.activeTurnBehavior === "interrupt") agent?.interrupted.push(text);
      },
      async respondToPermission({ requestId, response }: Fake["answered"][number]) {
        const at = agent?.pending.findIndex((request) => request.id === requestId) ?? -1;
        if (!agent || at < 0) throw new Error(`No pending permission request with id '${requestId}'`);
        agent.pending.splice(at, 1);
        agent.answered.push({ requestId, response });
      },
      async archive() {
        archiveWithChildren(id);
      },
    };
  };
  // Paseo 0.10.2 archives an agent's children with it, and theirs (`cascadeArchiveChildren`).
  const archiveWithChildren = (id: string): void => {
    const agent = agents.get(id);
    if (!agent || agent.archivedAt) return;
    Object.assign(agent, { archivedAt: new Date().toISOString(), status: "closed" });
    for (const child of agents.values())
      if (child.labels["paseo.parent-agent-id"] === id) archiveWithChildren(child.id);
  };
  const add = (
    provider: string,
    cwd: string,
    title: string,
    status = "idle",
    prompt?: string,
    labels: Record<string, string> = {},
  ) => {
    const id = `agent-${++count}`;
    agents.set(id, {
      id,
      provider,
      cwd,
      title,
      status,
      archivedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      sent: [],
      sentIds: [],
      steered: [],
      interrupted: [],
      pending: [],
      answered: [],
      prompt,
      labels,
    });
    return id;
  };
  const workspace = (id: string) => ({
    id,
    projectId: workspaceProjects.get(id) ?? null,
    async setTitle(title: string) {
      workspaceNames.set(id, title);
      return { title };
    },
    agents: {
      async create(options: {
        config: { provider: string };
        parent?: string;
        title: string;
        prompt: string;
        clientMessageId?: string;
        labels?: Record<string, string>;
      }) {
        const provider = options.config.provider.split("/")[0]!;
        if (!config.configured(provider)) throw new Error(`Provider ${provider} is not configured`);
        // Paseo keeps an agent's parent as this label, and never pushes an agent that has one.
        const labels = { ...options.labels, ...(options.parent ? { "paseo.parent-agent-id": options.parent } : {}) };
        const made = add(
          options.config.provider,
          workspaces.get(id)!,
          options.title,
          "running",
          options.prompt,
          labels,
        );
        Object.assign(agents.get(made)!, { promptId: options.clientMessageId, workspaceId: id });
        return ref(made);
      },
    },
  });
  const paseo = {
    agents: {
      ref,
      // The daemon caps a page at 200 rows and reports the rest through pageInfo, so the fake does too.
      async list(options?: { page?: { limit?: number; cursor?: string } }) {
        const all = [...agents.values()].map((agent) => ({ agent: { ...agent, pendingPermissions: agent.pending } }));
        const from = Number(options?.page?.cursor ?? 0);
        const limit = options?.page?.limit ?? 200;
        const next = from + limit;
        return {
          entries: all.slice(from, next),
          pageInfo: {
            hasMore: next < all.length,
            nextCursor: next < all.length ? String(next) : null,
            prevCursor: null,
          },
        };
      },
    },
    workspaces: {
      // The daemon finds the folder's oldest live workspace, or makes one (open_project_request).
      async open(cwd: string) {
        const found = [...workspaces].find(([id, path]) => path === cwd && !archivedWorkspaces.has(id));
        return found ? workspace(found[0]) : paseo.workspaces.create({ source: { path: cwd } });
      },
      // The daemon files a directory under the given project, or makes one of the directory when given none.
      async create({ title, source }: { title?: string; source: { path: string; projectId?: string } }) {
        const id = `ws-${workspaces.size + 1}`;
        workspaces.set(id, source.path);
        workspaceProjects.set(id, source.projectId ?? `prj:${source.path}`);
        if (title) workspaceNames.set(id, title);
        return workspace(id);
      },
      async list() {
        return {
          entries: [...workspaces.keys()].map((id) => ({
            id,
            projectId: workspaceProjects.get(id)!,
            name: workspaceNames.get(id) ?? "",
            archivingAt: archivedWorkspaces.has(id) ? new Date().toISOString() : null,
          })),
          pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
        };
      },
      // The daemon archives every agent a workspace owns with it (workspace-archive-service.js, archiveWorkspaceContents).
      async archive(id: string) {
        const workspaceId = typeof id === "string" ? id : (id as { id: string }).id;
        archivedWorkspaces.add(workspaceId);
        for (const agent of agents.values()) if (agent.workspaceId === workspaceId) archiveWithChildren(agent.id);
        return { archivedAt: new Date().toISOString() };
      },
      ref: workspace,
    },
    config: config.api,
  };
  return {
    paseo: paseo as never,
    config,
    agents,
    add,
    workspaces,
    workspaceNames,
    workspaceProjects,
    archivedWorkspaces,
    timelineOf,
  };
}
