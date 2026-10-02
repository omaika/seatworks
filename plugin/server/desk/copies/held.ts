import { join } from "node:path";
import type { Ledger } from "../../domain/ledger.ts";

/** This process among every one that ran the plugin: a pid alone comes round again, its start time with it does not. */
const holder = (): string => `${process.pid}@${performance.timeOrigin}`;

/**
 * The copies the desk is using: each slot's, and each lane tip's while a run in this process holds it. Paseo runs the
 * plugin in a process of its own and a reload starts another, so a hold another process took has no run left.
 */
export function heldCopies(ledger: Ledger): Set<string> {
  const held = new Set(Object.values(ledger.slots).map((slot) => slot.path));
  for (const [path, by] of Object.entries(ledger.tips ?? {})) if (by === holder()) held.add(path);
  return held;
}

/**
 * Holds a path for one run's copy of `lane`'s tip under `root`, never handed out twice: a sweep still removing an old
 * folder at a path given again would take the new copy with it. Called under the ledger lock, which also drops holds
 * another process left.
 */
export function holdTip(ledger: Ledger, root: string, lane: string): string {
  for (const [path, by] of Object.entries(ledger.tips ?? {})) if (by !== holder()) letTipGo(ledger, path);
  ledger.seq.tip = (ledger.seq.tip ?? 0) + 1;
  const path = join(root, `tip-${lane}-${ledger.seq.tip}`);
  ledger.tips = { ...ledger.tips, [path]: holder() };
  return path;
}

export function letTipGo(ledger: Ledger, path: string): void {
  delete ledger.tips?.[path];
  if (ledger.tips && Object.keys(ledger.tips).length === 0) delete ledger.tips;
}
