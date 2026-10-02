import { recordEvent } from "../store/event-log.ts";
import { join } from "node:path";
import { runGate } from "../../core/gate.ts";
import { unsavedIn } from "../copies/unsaved.ts";
import type { Kit } from "../../catalog/kit/kit.ts";
import type { DeskBase } from "../base.ts";
import { changeOf } from "../lanes/land-facts.ts";
import type { Lane } from "../../domain/lane.ts";
import { type Project, gitTimeout, loadConfig, riskRulesOf, rulesFor } from "./project.ts";
import { rmSync } from "node:fs";
import { addDetached, headSha, removeWorktree } from "../../core/git.ts";
import { worktreeRoot } from "../../core/paths.ts";
import { bringIncluded } from "../copies/worktree-include.ts";
import { setUpCopy } from "../copies/setup.ts";
import { holdTip, letTipGo } from "../copies/held.ts";

/** `ran` is whether anything ran: a lane with no gate and nothing to rehearse passes with nothing run. */
type GateVerdict = { ok: boolean; text: string; ran: boolean };

/** One command of a gate run: the project's gate, or a risk rule's rehearsal, named as `what`. */
type Step = { command: string; what: string };

type StepRun = Step & { ok: boolean; stopped: boolean; seconds: number; tail: string; logFile: string; failed: string };

/** The rehearsals of the risk rules `files` reach: a change git cannot read meets every rule, not none. */
function rehearsals(project: Project, kit: Kit, files: string[] | undefined): Step[] {
  const rules = riskRulesOf(project, kit).filter((rule) => rule.rehearse);
  return (files ? rulesFor(rules, files) : rules).map((rule) => ({
    command: rule.rehearse!,
    what: `${rule.rehearse}, rehearsing that ${rule.invariant},`,
  }));
}

/**
 * Runs `steps` in `cwd` in order, each logged under `id` and the run's one time, within the project's gate timeout:
 * all of them, or up to the first that fails when `stopAtRed`.
 */
async function runSteps(
  { stopping, gates }: Pick<DeskBase, "stopping" | "gates">,
  project: Project,
  id: string,
  cwd: string,
  steps: Step[],
  stopAtRed: boolean,
): Promise<StepRun[]> {
  const minutes = loadConfig(project.state).gateTimeoutMinutes;
  const at = Date.now();
  const runs: StepRun[] = [];
  for (const [index, step] of steps.entries()) {
    const logFile = join(project.state, "gates", `${id}-${at}${index > 0 ? `-${index}` : ""}.log`);
    const result = await gates.run(() => runGate(step.command, cwd, logFile, minutes * 60_000, stopping));
    const failed = result.stopped
      ? "was stopped as the plugin stopped"
      : result.timedOut
        ? `timed out after ${minutes} minutes`
        : `failed with exit ${result.code}`;
    runs.push({
      ...step,
      ok: result.ok,
      stopped: result.stopped,
      seconds: result.seconds,
      tail: result.tail,
      logFile,
      failed,
    });
    if (stopAtRed && !result.ok) break;
  }
  return runs;
}

/** The project's gate on the lane, then each rehearsal its change reaches, every one run: red in any is a red gate. */
export async function laneGate(
  desk: Pick<DeskBase, "kit" | "stopping" | "gates">,
  project: Project,
  lane: Lane,
): Promise<GateVerdict> {
  const { gate } = loadConfig(project.state);
  const rehearsing = riskRulesOf(project, desk.kit).some((rule) => rule.rehearse);
  const files = rehearsing ? (await changeOf(project, lane)).files : [];
  const steps = [...(gate ? [{ command: gate, what: gate }] : []), ...rehearsals(project, desk.kit, files)];
  if (steps.length === 0 || !lane.worktree) return { ok: true, text: "no gate set", ran: false };
  const unsaved = await unsavedIn(lane.worktree, !lane.slot);
  if (unsaved) return { ok: false, text: `the gate did not run: the lane's working copy ${unsaved}`, ran: false };
  const runs = await runSteps(desk, project, lane.id, lane.worktree, steps, false);
  for (const run of runs)
    recordEvent(project, {
      kind: run.ok ? "gate.passed" : "gate.failed",
      lane: lane.id,
      seconds: run.seconds,
      command: run.command,
    });
  const text = runs.map((run) =>
    run.ok
      ? `${run.what} passed on the lane branch in ${run.seconds}s`
      : `${run.what} ${run.failed} on the lane branch.\n\n${run.tail}\n\nFull log: ${run.logFile}`,
  );
  return { ok: runs.every((run) => run.ok), text: text.join("\n\n"), ran: true };
}

type GateRun = { ok: boolean; note: string; tail: string; logFile: string };

/**
 * The project's gate on a task, then a rehearsal for each risk rule the task's `files` reach, stopping at the first
 * that fails. Undefined when this project does not gate tasks.
 */
export async function taskGate(
  desk: Pick<DeskBase, "kit" | "stopping" | "gates" | "ledgers" | "log">,
  project: Project,
  task: { id: string; lane: string },
  cwd: string,
  files: string[] | undefined,
): Promise<GateRun | undefined> {
  const taskId = task.id;
  const config = loadConfig(project.state);
  if (!config.gate || config.gateOn !== "task") return undefined;
  const steps = [{ command: config.gate, what: config.gate }, ...rehearsals(project, desk.kit, files)];
  const runs = await runSteps(desk, project, taskId, cwd, steps, true);
  const notes = runs.map((run, index) =>
    run.ok
      ? `${run.what} passed in ${run.seconds}s`
      : index === 0
        ? `${run.what}: the gate ${run.failed}`
        : `${run.what} ${run.failed}`,
  );
  const last = runs.at(-1)!;
  const lane = desk.ledgers.read(project).lanes[task.lane];
  const tip = !runs[0]!.ok && lane ? [await onLaneTip(desk, project, lane, config.gate)] : [];
  return { ok: last.ok, tail: last.tail, logFile: last.logFile, note: [...notes, ...tip].join("; ") };
}

/**
 * Whether the gate that failed on a task fails on its lane's tip too, run there in a copy made as a task's is, once for
 * each tip: a red task on a red lane is not the task's doing alone, which the Lead weighs before overGate.
 */
async function onLaneTip(
  desk: Pick<DeskBase, "stopping" | "gates" | "ledgers" | "log">,
  project: Project,
  lane: Lane,
  command: string,
): Promise<string> {
  const sha = await headSha(project.root, lane.branch);
  if (!sha) return `the same gate was not run on ${lane.branch}, which git could not read`;
  const said = (ok: boolean) =>
    `the same gate on ${lane.branch} at ${sha.slice(0, 7)}, in a copy made as a task's is, ${ok ? "passes" : "fails too"}`;
  if (lane.tipGate?.sha === sha) return said(lane.tipGate.ok);
  // Held before git makes it, as a slot's row is, so no sweep takes it from under the setup or the gate.
  const path = desk.ledgers.transact(project, (ledger) => holdTip(ledger, join(worktreeRoot(), project.slug), lane.id));
  const copy = { id: `tip-${lane.id}`, path };
  try {
    if (!(await addDetached(project.root, copy.path, sha, gitTimeout(project))))
      return `the same gate was not run on ${lane.branch}: git could not make a copy of it`;
    const missed = await bringIncluded(project.root, copy.path);
    if (missed) desk.log(project, `the copy of ${lane.branch}'s tip: ${missed}`);
    const setUp = await setUpCopy(desk, project, copy);
    // A copy its setup broke says nothing of the tip, so no verdict stands for this commit and the next red asks again.
    if (setUp && !setUp.ok)
      return `the same gate was not run on ${lane.branch} at ${sha.slice(0, 7)}: the project's setup in its copy ${setUp.failed}; its log is ${setUp.logFile}`;
    const [run] = await runSteps(desk, project, `${lane.id}-tip`, copy.path, [{ command, what: command }], true);
    // A run the plugin's stop cut short never finished, so it says nothing of the tip either.
    if (run!.stopped)
      return `the same gate on ${lane.branch} at ${sha.slice(0, 7)} ${run!.failed}, so it says nothing yet`;
    desk.ledgers.setLane(project, lane.id, (entry) => {
      entry.tipGate = { sha, ok: run!.ok };
    });
    return said(run!.ok);
  } finally {
    // The path is this run's alone, so what is there, a half-made copy too, is its own to remove.
    try {
      await removeWorktree(project.root, copy.path);
      rmSync(copy.path, { recursive: true, force: true });
    } finally {
      // Let go even where removal failed: the sweep then takes what is left.
      desk.ledgers.transact(project, (ledger) => letTipGo(ledger, copy.path));
    }
  }
}

/** What the MERGED letter says about the gate, from what actually ran. */
export function gateNote(
  project: Project,
  task?: { handback?: { gate?: { ok: boolean; note: string; over?: string } } },
): string {
  const config = loadConfig(project.state);
  if (!config.gate) return "none set";
  if (config.gateOn !== "task")
    return "not run on merges, so the lane branch can break between reports; it runs on the whole lane when you report it ready";
  const ran = task?.handback?.gate;
  // A red gate merges only over its Lead's word, so a red one here always carries the reason.
  return ran
    ? `ran on this task: ${ran.note}${ran.ok ? "" : ` — merged over it: ${ran.over}`}`
    : "did not run on this task: it was not handed back while the project gated each task";
}
