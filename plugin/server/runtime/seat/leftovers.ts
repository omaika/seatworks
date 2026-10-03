import { daemonLog } from "../../core/logger.ts";
import { type Marked, findMarked } from "../../core/marked-processes.ts";

/** Paseo closes an archived agent's own process tree after its hook; what is left once it has is not in that tree. */
const AFTER_CLOSE_MS = 10_000;

/** Paseo puts the agent's id in the environment of everything the agent starts, and a process that outlives its starter keeps it. */
const MARK = "PASEO_AGENT_ID";

type Pending = { timer: NodeJS.Timeout; abort: AbortController };
type Report = (found: Marked[]) => Promise<void>;

/** Looks for what an archived seat's commands left running, off the archive hook so a slow listing never holds it, and reports what it finds. */
export class Leftovers {
  private readonly pending = new Map<string, Pending>();
  private readonly abort = new AbortController();

  /** Looks for the seat's leftovers once Paseo has closed it, and hands any it finds to `report`. */
  schedule(agentId: string, report: Report): void {
    if (this.abort.signal.aborted) return;
    this.cancel(agentId);
    const abort = new AbortController();
    const timer = setTimeout(() => void this.look(agentId, report, abort.signal), AFTER_CLOSE_MS);
    this.pending.set(agentId, { timer, abort });
  }

  /** The agent is running again under the same id, so what carries its mark is no longer left over. */
  cancel(agentId: string): void {
    const pending = this.pending.get(agentId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.abort.abort();
    this.pending.delete(agentId);
  }

  private async look(agentId: string, report: Report, own: AbortSignal): Promise<void> {
    try {
      const found = await findMarked(MARK, agentId, AbortSignal.any([own, this.abort.signal]));
      if (found.length > 0 && !own.aborted) await report(found);
    } catch (error) {
      if (!own.aborted && !this.abort.signal.aborted)
        daemonLog.error(`could not report what archived seat ${agentId} left running:`, error);
    } finally {
      if (this.pending.get(agentId)?.abort.signal === own) this.pending.delete(agentId);
    }
  }

  dispose(): void {
    this.abort.abort();
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }
}
