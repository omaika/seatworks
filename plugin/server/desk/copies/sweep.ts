import { recordEvent } from "../store/event-log.ts";
import { existsSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { errorText } from "../../core/errors.ts";
import { removeWorktree } from "../../core/git.ts";
import type { Workspaces } from "../../core/ports.ts";
import { worktreeRoot } from "../../core/paths.ts";
import type { DeskBase } from "../base.ts";
import type { Ledger } from "../../domain/ledger.ts";
import { heldCopies } from "./held.ts";
import type { Project } from "../project/project.ts";
import { unsavedIn } from "./unsaved.ts";

/**
 * What the desk opened and nothing holds any more. Liveness is read under the ledger lock when used: `reserve` writes
 * its row before `git worktree add`, as a lane tip's gate writes its path.
 */
export async function sweepCopies(
  { ledgers, log }: Pick<DeskBase, "ledgers" | "log">,
  workspaces: Workspaces,
  project: Project,
  busy: boolean,
): Promise<void> {
  const heldIds = (ledger: Ledger): Set<string> => {
    const held = new Set<string>();
    for (const slot of Object.values(ledger.slots)) if (slot.workspaceId) held.add(slot.workspaceId);
    for (const lane of Object.values(ledger.lanes))
      if (lane.status === "open" && lane.workspaceId) held.add(lane.workspaceId);
    return held;
  };
  for (const workspace of await workspaces.owned(project.slug)) {
    if (busy && workspace.name === project.slug) continue;
    if (heldIds(ledgers.read(project)).has(workspace.id)) continue;
    try {
      await workspaces.archive(workspace.id);
      recordEvent(project, { kind: "workspace.swept", workspace: workspace.id, name: workspace.name });
    } catch (error) {
      log(project, `workspace ${workspace.name} could not be swept: ${errorText(error)}`);
    }
  }
  const root = join(worktreeRoot(), project.slug);
  if (!root.startsWith(worktreeRoot()) || !existsSync(root)) return;
  // Removal outside the lock is safe because a slot id is never handed out twice, nor a tip's path while its gate runs.
  const held = heldCopies(ledgers.read(project));
  const strays = readdirSync(root)
    .map((name) => join(root, name))
    .filter((path) => !held.has(path));
  for (const path of strays) {
    if (heldCopies(ledgers.read(project)).has(path)) continue;
    // Work no commit holds is the Human's to keep or throw away: Clean shows such a copy and never takes it.
    if (existsSync(join(path, ".git")) && (await unsavedIn(path))) continue;
    await removeWorktree(project.root, path);
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Left for the next sweep, which asks again whether anything holds it.
    }
    recordEvent(project, { kind: "worktree.swept", path });
  }
  try {
    if (readdirSync(root).length === 0) rmdirSync(root);
  } catch {
    // Not empty yet, or gone already.
  }
}
