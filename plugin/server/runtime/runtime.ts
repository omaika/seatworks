import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Kit, SensorSpec } from "../catalog/kit/kit.ts";
import { seatOf } from "../catalog/kit/roles.ts";
import type { ModelCache } from "../catalog/paseo/models.ts";
import { type IndexedProxy, choicesFor, indexedProxies } from "../catalog/seat/servers.ts";
import { placeGuides, sweepSnapshots } from "../catalog/seat/snapshots.ts";
import { errorText } from "../core/errors.ts";
import { isRecord } from "../core/json.ts";
import { daemonLog } from "../core/logger.ts";
import { deskSocket, home, nodeBin, stateRoot } from "../core/paths.ts";
import type {
  AgentConfig,
  CodeIndex,
  HookAgent,
  Host,
  HostHooks,
  Judge,
  PermissionRequested,
  SessionOpen,
  TurnEnded,
  Workspaces,
} from "../core/ports.ts";
import type { ToolReply, ToolRequest } from "../desk/context.ts";
import { Desk } from "../desk/desk.ts";
import { type Project, projectOf } from "../desk/project/project.ts";
import { loadLedger } from "../desk/store/ledger.ts";
import { appendRecord } from "../desk/store/records.ts";
import { TOOLS } from "../desk/tools/registry.ts";
import { stampKit } from "../upkeep/older-seats.ts";
import { codeIndex } from "./seat/code-index.ts";
import { ChatCards } from "./panel/chat-cards.ts";
import { HumanPanel } from "./panel/human.ts";
import { ProjectsPanel } from "./panel/projects.ts";
import type { Panel } from "./panel/rpc.ts";
import { SettingsPanel } from "./panel/settings.ts";
import { UpkeepPanel } from "./panel/upkeep.ts";
import { SeatKeys } from "./seat/keys.ts";
import { composeMail } from "./mail/compose-mail.ts";
import { mailRules } from "./mail/mail-rules.ts";
import { Outbox } from "./mail/outbox.ts";
import { Patrol } from "./round/patrol.ts";
import { PatrolClock } from "./round/patrol-clock.ts";
import { ProviderSync } from "./provider-sync.ts";
import { SeatLaunch } from "./seat/seat-launch.ts";
import { Seating } from "./seat/seating.ts";
import { TeamSocket } from "./seat/team-socket.ts";
import { TeamSource } from "./team-source.ts";
import { TurnRules } from "./turns.ts";
import { PermissionRules } from "./permissions.ts";
import { PermissionWaits } from "./permission-waits.ts";
import { Watches } from "./watch/watches.ts";
import { watchView } from "./panel/watch-view.ts";
import { Watching } from "./watching.ts";
import { Leftovers } from "./seat/leftovers.ts";
import type { Marked } from "../core/marked-processes.ts";
import { seatLetters } from "../desk/letters/seat-letters.ts";
import { ProjectRegistry } from "./project-registry.ts";

type RuntimeOptions = {
  outboxFile?: string;
  codeIndex?: (proxy: IndexedProxy) => CodeIndex;
  sensor?: (spec: SensorSpec, key: string) => Judge;
};

export class Runtime implements HostHooks {
  readonly kit: Kit;
  readonly outbox: Outbox;
  readonly desk: Desk;
  readonly panel: Panel;
  private readonly keys = new SeatKeys();
  private readonly waits = new PermissionWaits();
  private readonly registry = new ProjectRegistry();
  private readonly socket: TeamSocket;
  private readonly source: TeamSource;
  private readonly seating: Seating;
  private readonly turns: TurnRules;
  private readonly permissions: PermissionRules;
  private readonly patrol: Patrol;
  private readonly cards: ChatCards;
  private readonly watches: Watches;
  private readonly leftovers = new Leftovers();
  private readonly watching: Watching;
  private readonly sync: ProviderSync;
  private readonly launch: SeatLaunch;
  private readonly clock: PatrolClock;
  private readonly makeIndex: (proxy: IndexedProxy) => CodeIndex;
  private readonly host: Host;

  constructor(kit: Kit, host: Host, options: RuntimeOptions = {}) {
    this.kit = kit;
    this.host = host;
    this.makeIndex = options.codeIndex ?? codeIndex;
    this.source = new TeamSource(kit);
    this.seating = new Seating(kit, this.source, { node: nodeBin(), socket: deskSocket() });
    const rules = {
      ...mailRules(kit, (agentId) =>
        this.registry.known().find((project) => loadLedger(project.state).agents[agentId]),
      ),
      // A Watcher's case has its time from when it arrives, not from when it was posted.
      delivered: (letters: { key: string }[], at: number) => this.desk.watcher.delivered(letters, at),
    };
    this.outbox = new Outbox(options.outboxFile ?? join(stateRoot(), "outbox.json"), composeMail, host.seats, rules);
    const log = (project: Project, line: string) => this.log(project, line);
    const remember = (project: Project) => this.remember(project);
    this.desk = new Desk({
      kit,
      tools: TOOLS,
      outbox: this.outbox,
      seats: host.seats,
      workspaces: this.providing(host.workspaces),
      log,
      teamFor: (project) => this.source.teamFor(project),
      indexesFor: (project) => this.indexesFor(project),
      sensor: options.sensor,
    });
    this.socket = this.teamSocket();
    this.turns = new TurnRules({
      kit,
      desk: this.desk,
      attention: (project) => this.source.teamFor(project).attention,
      remember,
    });
    this.permissions = new PermissionRules({
      kit,
      desk: this.desk,
      seats: host.seats,
      hitlOn: (project) => this.source.teamFor(project).hitl.on,
      log,
    });
    this.watching = new Watching({
      kit,
      source: this.source,
      desk: this.desk,
      watches: () => this.watches,
    });
    this.watches = this.watchesOf(kit);
    this.cards = new ChatCards({
      kit,
      source: this.source,
      seats: host.seats,
      waits: this.waits,
      supervisorFor: (project) => this.desk.supervisorFor(project),
    });
    this.patrol = new Patrol({
      kit,
      source: this.source,
      registry: this.registry,
      desk: this.desk,
      seats: host.seats,
      outbox: this.outbox,
      turns: this.turns,
      watches: this.watches,
      remember,
      cards: this.cards,
    });
    this.clock = new PatrolClock({ host, patrol: this.patrol, source: this.source, desk: this.desk });
    this.sync = new ProviderSync({
      kit,
      models: host.models,
      config: host.config,
      seats: host.seats,
      source: this.source,
      registry: this.registry,
      modelsChanged: () => this.seating.forget(),
    });
    this.launch = new SeatLaunch(kit, this.seating, this.keys, remember);
    this.panel = this.panelOf(kit);
  }

  private watchesOf(kit: Kit): Watches {
    return new Watches({
      kit,
      seats: this.host.seats,
      context: (seat) => this.watching.context(seat),
      found: (watch, facts) => this.watching.found(watch, facts),
      looked: (watch, look) => this.watching.looked(watch, look),
      spoke: (seat, text) =>
        void this.turns
          .spoke(seat, text)
          .catch((error: unknown) =>
            daemonLog.error("a word the Human wrote to a seat could not be passed on:", error),
          ),
    });
  }

  private panelOf(kit: Kit): Panel {
    const { source, registry } = this;
    const changed = () => this.teamChanged();
    const reconcile = () => this.sync.reconcile();
    const seats = this.host.seats;
    const watch = (project: Project) => watchView(project, source.teamFor(project), kit);
    const settings = new SettingsPanel({
      kit,
      source,
      registry,
      changed,
      reconcile,
      models: () => this.refreshModels(),
      paseoTools: () => this.host.tools(),
      providerEnv: async (provider) => {
        const env = (await this.host.config.read()).providers?.[provider]?.env;
        return isRecord(env)
          ? (Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === "string")) as Record<
              string,
              string
            >)
          : {};
      },
    });
    const adopt = (project: Project, draft: unknown) => settings.adopt(project, draft);
    return {
      settings,
      projects: new ProjectsPanel({
        kit,
        source,
        registry,
        seats,
        workspaces: this.host.workspaces,
        held: () => this.outbox.held(),
        watch,
        changed,
        reconcile,
        adopt,
        desk: this.desk,
      }),
      upkeep: new UpkeepPanel({ kit, source, registry, seats }),
      human: new HumanPanel({ kit, registry, human: this.desk.human, cards: this.cards }),
    };
  }

  private teamSocket(): TeamSocket {
    return new TeamSocket(deskSocket(), {
      whose: (key) => this.keys.whose(key),
      choices: (role, cwd) => choicesFor(this.kit, this.source.teamFor(projectOf(cwd)), role),
      answer: (request, cancelled) =>
        this.answer(request, cancelled).catch((error) => ({ ok: false, text: `The desk failed: ${errorText(error)}` })),
      mailLost: (request, reply) => this.desk.mailLost(request, reply),
    });
  }

  /**
   * A seat's call, answered with the mail held for it: its turn reads it there, with nothing sent that could replace
   * that turn, so a seat whose turns are all short still reads word that asks nothing. A reloaded plugin has Paseo's API
   * only once a hook or a panel call brings it: a call waits for it rather than fail to reach a seat.
   */
  async answer(request: ToolRequest, cancelled: AbortSignal): Promise<ToolReply> {
    await this.host.reached();
    const reply = await this.desk.answer(request, { cancelled });
    // A stopped call's reply is read by nobody: its seat's mail stays held for the next.
    const held = request.agent ? await this.outbox.take(request.agent, () => !cancelled.aborted) : undefined;
    return held ? { ...reply, text: `${reply.text}\n\n---\n\nMail the desk held for you:\n\n${held}` } : reply;
  }

  /** Paseo refuses a seat on a provider it lacks, and a team may have moved since the last pass. */
  private providing(workspaces: Workspaces): Workspaces {
    return {
      ...workspaces,
      seat: async (workspace, spec) => {
        await this.sync.reconcile();
        return workspaces.seat(workspace, spec);
      },
    };
  }

  /** The team or its skills changed: seats are built again, and shown the choices their fields take now. */
  private teamChanged(): void {
    this.seating.forget();
    this.socket.refresh();
  }

  /** Resolves once Paseo's providers are in step with the attached projects, which waits for Paseo's API to arrive. */
  prepare(): Promise<void> {
    try {
      mkdirSync(stateRoot(), { recursive: true });
      placeGuides(this.kit);
      sweepSnapshots();
      stampKit(this.kit, home());
    } catch (error) {
      daemonLog.error("could not prepare the state directory:", error);
    }
    for (const problem of this.source.teamFor().errors) daemonLog.error(`settings: ${problem}`);
    return this.sync.reconcile();
  }

  /** Tells whoever supervises the seat's lane what its archived seat left running; the Human decides what to do of it. */
  private async reportLeftovers(project: Project, agentId: string, found: Marked[]): Promise<void> {
    const ledger = loadLedger(project.state);
    const bound = ledger.agents[agentId];
    const lane = ledger.lanes[bound?.lane ?? ""];
    const to = await this.desk.supervisorFor(project, lane?.opener);
    const posted = await this.desk.post(to, seatLetters.leftovers(agentId, bound?.lane, bound?.task, found));
    if (posted === "nobody") daemonLog.info(`${project.slug}: nobody is seated to hear what ${agentId} left running`);
  }

  create(config: AgentConfig, env: Record<string, string> = {}): { config: AgentConfig; env: Record<string, string> } {
    return this.launch.create(config, env);
  }

  async created(agent: HookAgent): Promise<void> {
    this.watches.follow(agent);
  }

  async archived(agent: HookAgent): Promise<void> {
    this.keys.forget(agent.id);
    this.waits.forget(agent.id);
    this.outbox.archived(agent.id);
    this.turns.forget(agent.id);
    this.watches.drop(agent.id);
    if (seatOf(this.kit, agent.provider)) {
      const project = projectOf(agent.cwd);
      this.leftovers.schedule(agent.id, (found) => this.reportLeftovers(project, agent.id, found));
    }
    this.desk.archived(projectOf(agent.cwd), agent.id, this.watches.watched(agent.provider));
  }

  start(): void {
    this.socket.listen();
    this.clock.start();
  }

  dispose(): void {
    this.socket.close();
    this.watches.dispose();
    this.leftovers.dispose();
    this.clock.stop();
    this.desk.dispose();
  }

  sessionOpen(request: SessionOpen): SessionOpen {
    if (request.purpose === "interactive") this.leftovers.cancel(request.agentId);
    return this.launch.sessionOpen(request);
  }

  async turnStarted(agent: HookAgent): Promise<void> {
    this.turns.started(agent.id);
    this.outbox.turnStarted(agent.id);
  }

  async turnEnded(event: TurnEnded): Promise<void> {
    this.outbox.turnEnded(event.agent.id);
    this.turns.malformedCalls(event);
    try {
      const archiving = this.desk.archiving(event.agent.id);
      if (archiving) await this.desk.archive(event.agent.id, true);
      await this.desk.stopped(event.agent.id);
      if (archiving) return;
      await this.turns.ended(event);
    } finally {
      await this.outbox.pump(event.agent.id);
    }
  }

  permissionRequested(event: PermissionRequested): Promise<void> {
    if (event.request.id) this.waits.asked(event.agent.id, event.request.id);
    return this.permissions.permission(event);
  }

  private remember(project: Project): void {
    this.desk.projects.set(project.slug, project);
    this.registry.record(project);
  }

  private indexesFor(project: Project): CodeIndex[] {
    return indexedProxies(this.source.teamFor(project)).map((proxy) => this.makeIndex(proxy));
  }

  refreshModels(): Promise<ModelCache> {
    return this.sync.refreshModels();
  }

  private log(project: Project, line: string): void {
    appendRecord(project.state, "attention", `${new Date().toISOString()}  ${line}\n`);
  }
}
