import { daemonLog } from "../../core/logger.ts";
import { stopMarked } from "../../core/marked-processes.ts";

/** Paseo closes an archived agent's own process tree after its hook; what is left once it has is not in that tree. */
const AFTER_CLOSE_MS = 10_000;

/** Paseo puts the agent's id in the environment of everything the agent starts, and a process that outlives its starter keeps it. */
const MARK = "PASEO_AGENT_ID";

type Pending = { timer: NodeJS.Timeout; abort: AbortController };

/** The seats opened again while the sweep at start is not done, which it must not stop what is left of, and the pass now running. */
type Startup = { reopened: Set<string>; pass?: AbortController };

/** Stops what an archived seat's commands left running, off the archive hook so a slow listing never holds it. */
export class Leftovers {
  private readonly pending = new Map<string, Pending>();
  private readonly abort = new AbortController();
  private startup: Startup | undefined = { reopened: new Set() };

  /** Sweeps for the seat once Paseo has closed it. */
  schedule(agentId: string): void {
    if (this.abort.signal.aborted) return;
    this.cancel(agentId);
    const abort = new AbortController();
    const timer = setTimeout(() => void this.sweep(agentId, abort.signal), AFTER_CLOSE_MS);
    this.pending.set(agentId, { timer, abort });
  }

  /** The agent is running again under the same id, so what carries its mark is no longer left over. */
  cancel(agentId: string): void {
    this.startup?.reopened.add(agentId);
    this.startup?.pass?.abort();
    const pending = this.pending.get(agentId);
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.abort.abort();
    this.pending.delete(agentId);
  }

  private async sweep(agentId: string, own: AbortSignal): Promise<void> {
    try {
      const stopped = await stopMarked(MARK, [agentId], AbortSignal.any([own, this.abort.signal]));
      for (const pid of stopped) daemonLog.info(`stopped process ${pid} left running by archived seat ${agentId}`);
    } catch (error) {
      if (!own.aborted && !this.abort.signal.aborted)
        daemonLog.error(`could not stop what archived seat ${agentId} left running:`, error);
    } finally {
      if (this.pending.get(agentId)?.abort.signal === own) this.pending.delete(agentId);
    }
  }

  /** At start, for seats archived while the plugin was not running to hear of it: one listing of processes serves them all. A seat opened again meanwhile is left out, and a pass it interrupts is run again without it. */
  async sweepAll(agentIds: string[]): Promise<void> {
    const startup = this.startup;
    if (!startup) return;
    try {
      while (!this.abort.signal.aborted) {
        const ids = agentIds.filter((id) => !startup.reopened.has(id));
        const pass = new AbortController();
        startup.pass = pass;
        try {
          const stopped = await stopMarked(MARK, ids, AbortSignal.any([pass.signal, this.abort.signal]));
          for (const pid of stopped)
            daemonLog.info(`stopped process ${pid} left running by a seat archived before start`);
          if (!pass.signal.aborted) return;
        } catch (error) {
          if (!pass.signal.aborted) throw error;
        }
      }
    } catch (error) {
      if (!this.abort.signal.aborted)
        daemonLog.error("could not stop what seats archived before start left running:", error);
    } finally {
      this.startup = undefined;
    }
  }

  dispose(): void {
    this.abort.abort();
    for (const { timer } of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }
}
