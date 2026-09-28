import { createHash } from "node:crypto";
import { existsSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Kit } from "../../catalog/kit/kit.ts";
import { can, seatOf } from "../../catalog/kit/roles.ts";
import { errorText } from "../../core/errors.ts";
import { daemonLog } from "../../core/logger.ts";
import { gitCommonDir } from "../../core/git.ts";
import { isRecord } from "../../core/json.ts";
import { worktreeRoot } from "../../core/paths.ts";
import type { SeatView, Seats, Workspaces } from "../../core/ports.ts";
import { type Project, projectOf } from "../../desk/project/project.ts";
import { loadLedger, readLedger } from "../../desk/store/ledger.ts";
import { flowView } from "../../desk/views/flow.ts";
import { statusPage } from "../../desk/views/status.ts";
import type { Added, Paths, ProjectRow, Removed, StatusView } from "../../../shared/views.ts";
import type { FlowRead, WatchView } from "../../../shared/flow-views.ts";
import type { TeamSource } from "../team-source.ts";
import type { ProjectRegistry } from "../project-registry.ts";
import { listFolders } from "./folders.ts";
import type { ProjectsRpc } from "./rpc.ts";
import { firstUnder } from "../../core/fs.ts";
import { writeProjectBlock } from "../../catalog/seat/project-block.ts";
import type { Desk } from "../../desk/desk.ts";
import { landLetters } from "../../desk/letters/land-letters.ts";

export const unknownProject = (slug: string) => `No project named ${slug} has been seen on this machine.`;

type ProjectsDeps = {
  kit: Kit;
  source: TeamSource;
  registry: ProjectRegistry;
  seats: Seats;
  workspaces: Workspaces;
  held: () => { to: string; text: string; at: number; until: number }[];
  watch: (project: Project, seats: Iterable<SeatView>) => WatchView;
  changed: () => void;
  reconcile: () => Promise<void>;
  adopt: (project: Project, draft: unknown) => Promise<string | undefined>;
  desk: Pick<Desk, "post" | "supervisorFor">;
};

export class ProjectsPanel implements ProjectsRpc {
  private readonly deps: ProjectsDeps;

  constructor(deps: ProjectsDeps) {
    this.deps = deps;
  }

  projects(): ProjectRow[] {
    return this.deps.registry.known().map((project) => ({ slug: project.slug, root: project.root }));
  }

  /** Attaches the project at `root`, and saves the setup `values` chose for it in the same call. */
  async addProject(root: string, values?: unknown): Promise<Added> {
    const path = root.trim();
    if (!path || !existsSync(path) || !statSync(path).isDirectory())
      return { error: `${path || "That path"} is not a directory on this machine.` };
    const project = projectOf(path);
    this.deps.registry.record(project);
    // record() only logs failures; an attach whose slug cannot be found leaves every screen for it dead.
    if (!this.deps.registry.named(project.slug))
      return { error: `${project.root} could not be put on record; see the daemon log.` };
    const changed = writeProjectBlock(this.deps.kit, project.root);
    const note = changed ? "The Seatworks block changed in AGENTS.md; commit it." : undefined;
    if (changed)
      await this.deps.desk.post(await this.deps.desk.supervisorFor(project), landLetters.blockChanged(project.root));
    const refused =
      isRecord(values) && Object.keys(values).length > 0 ? await this.deps.adopt(project, values) : undefined;
    await this.deps.reconcile();
    // Paseo's own project list is where the Human starts the Supervisor; detaching leaves it there, as the Human's.
    await this.deps.workspaces
      .open(project.root)
      .catch((error: unknown) =>
        daemonLog.error(
          `${project.root} is attached, but Paseo did not open it as a project; open it in Paseo:`,
          error,
        ),
      );
    return { slug: project.slug, root: project.root, ...(refused ? { refused } : {}), ...(note ? { note } : {}) };
  }

  candidateProjects(roots: string[]): string[] {
    const attached = new Set(this.deps.registry.known().map((project) => project.root));
    const worktrees = worktreeRoot();
    const keep: string[] = [];
    for (const given of roots) {
      const path = given.trim();
      if (!path || path === worktrees || firstUnder(worktrees, path)) continue;
      let real: string;
      try {
        if (!statSync(path).isDirectory()) continue;
        real = realpathSync(path);
      } catch {
        continue;
      }
      if (!gitCommonDir(real)) continue;
      const project = projectOf(real);
      if (project.root !== real || attached.has(project.root)) continue;
      keep.push(given);
    }
    return keep;
  }

  async removeProject(slug: string): Promise<Removed> {
    const project = this.deps.registry.named(slug);
    if (!project) return { error: unknownProject(slug) };
    // A seat still working in the project records it again on the next round, so detaching it first would not hold.
    let live: string[];
    try {
      live = (await this.deps.seats.open())
        .filter(
          (seat) =>
            !seat.archivedAt && seatOf(this.deps.kit, seat.provider)?.role.tools && projectOf(seat.cwd).slug === slug,
        )
        .map((seat) => seat.id);
    } catch (error) {
      return {
        error: `Paseo did not say which seats are working in ${slug} (${errorText(error)}), so its settings stay.`,
      };
    }
    if (live.length > 0)
      return {
        error: `${slug} stays: ${live.length} seat${live.length === 1 ? " is" : "s are"} still working in it (${live.join(", ")}): archive ${live.length === 1 ? "it" : "them"} first, since a working seat puts the project back on record.`,
      };
    const ledger = loadLedger(project.state);
    const open = Object.values(ledger.lanes).filter((lane) => lane.status !== "closed").length;
    // A closed lane still restoring the owner's copy is live: detached, the repo stays on its branch for good.
    const restoring = Object.values(ledger.lanes).filter((lane) => lane.restoring).length;
    // A free slot row left by a failed checkout is the desk's pool, not a copy anyone holds.
    const copies = Object.values(ledger.slots).filter((slot) => slot.lane || slot.task || slot.releasing).length;
    if (open > 0 || copies > 0 || restoring > 0) {
      const held = [
        open > 0 ? `${open} open or waiting lane(s)` : "",
        restoring > 0
          ? `${restoring} closed lane(s) whose working copy — the project's own — is not back on its base branch yet: a seat is still writing there, or the copy has changes that stop the switch (see restore.held in events.log)`
          : "",
        copies > 0 ? `${copies} working cop${copies === 1 ? "y" : "ies"} still checked out` : "",
      ].filter(Boolean);
      return {
        error: `${slug} has ${held.join(" and ")}, so its settings stay.${open > 0 ? " Close the lanes first." : ""}`,
      };
    }
    for (const name of ["settings.json", "meta.json"]) rmSync(join(project.state, name), { force: true });
    try {
      if (readdirSync(project.state).length === 0) rmSync(project.state, { recursive: true, force: true });
    } catch {
      // Gone already, or holding more than the desk put there: the folder stays.
    }
    this.deps.registry.forget(slug);
    this.deps.changed();
    await this.deps.reconcile();
    return { removed: slug };
  }

  listPaths(path?: string): Paths {
    return listFolders(path);
  }

  async status(slug: string): Promise<StatusView> {
    const project = this.deps.registry.named(slug);
    if (!project) return { text: "", error: unknownProject(slug) };
    const seats = new Map((await this.deps.seats.open()).map((seat) => [seat.id, seat]));
    const human = this.deps.source.teamFor(project).hitl.on;
    return { text: statusPage(this.deps.kit, project, seats, Date.now(), this.deps.held(), human) };
  }

  async flow(slug: string, since?: string, open?: string[]): Promise<FlowRead> {
    const project = this.deps.registry.named(slug);
    if (!project) return { error: unknownProject(slug) };
    const seats = new Map((await this.deps.seats.open()).map((seat) => [seat.id, seat]));
    const roles = new Map(
      this.deps.kit.roles.map((role) => [role.role, { label: role.label, supervises: can(role, "supervise") }]),
    );
    const seated = [...seats.values()]
      .map((seat) => ({ seat, as: seatOf(this.deps.kit, seat.provider) }))
      .filter(({ seat, as }) => as && Boolean(seat.cwd) && projectOf(seat.cwd).slug === project.slug)
      .sort((a, b) => Date.parse(b.seat.updatedAt) - Date.parse(a.seat.updatedAt))
      .map(({ seat, as }) => ({
        id: seat.id,
        role: as!.role.role,
        unsandboxed: !as!.harness.sandboxedOn?.some((platform) => platform === process.platform),
      }));
    const view = flowView(project, readLedger(project.state), seats, Date.now(), new Set(open ?? []), roles, seated);
    // Live state, but part of the revision, or the card freezes whenever the ledger does not change.
    const watch = this.deps.watch(project, seats.values());
    const revision = createHash("sha1")
      .update(`${view.revision}${JSON.stringify(watch)}`)
      .digest("hex")
      .slice(0, 16);
    return since && since === revision ? { unchanged: true, revision } : { ...view, watch, revision };
  }
}
