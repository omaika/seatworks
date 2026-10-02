import { type Layer, REVIEW_OFF } from "../../shared/settings.ts";
import type { TeamView } from "../../shared/views.ts";

/** What each key field holds, by sensor id: the owner's only copy of a key until it is saved. */
export type KeyDrafts = Readonly<Record<string, string>>;

/** A sensor's key row, and whether this page's own settings ask that sensor: a page that never asks it only offers the key. */
type KeyRow<S> = { sensor: S; asked: boolean };

type KeyLine<S> = { rows: KeyRow<S>[]; drafts: KeyDrafts };

/** A typed key belongs to the field it was typed into: once that field is gone, so is the key, and it does not come back with the field. */
function keptDrafts(drafts: KeyDrafts, rows: readonly KeyRow<{ id: string }>[]): KeyDrafts {
  const shown = new Set(rows.map((row) => row.sensor.id));
  if (Object.keys(drafts).every((id) => shown.has(id))) return drafts;
  return Object.fromEntries(Object.entries(drafts).filter(([id]) => shown.has(id)));
}

function reads(attention: TeamView["attention"], id: string): boolean {
  return (attention.brain === "sensor" || attention.brain === "both") && attention.sensor === id;
}

/** The watch's key row: only for a sensor its brains read with, so a watch that never asks a sensor never warns of its key. */
export function watchKeyLine<S extends { id: string }>(
  sensors: readonly S[],
  attention: TeamView["attention"],
  drafts: KeyDrafts,
): KeyLine<S> {
  const rows = sensors.filter((entry) => reads(attention, entry.id)).map((sensor) => ({ sensor, asked: true }));
  return { rows, drafts: keptDrafts(drafts, rows) };
}

/** Review's line: the select's own value, so an inherited choice never looks picked here, and a key row for the sensor that asks, or with review Off on the machine every one, since a project may still name any. */
export function reviewLine<S extends { id: string }>(
  sensors: readonly S[],
  { review, attention }: Pick<TeamView, "review" | "attention">,
  values: Layer,
  machine: Layer,
  layer: "machine" | "project",
  drafts: KeyDrafts,
): KeyLine<S> & { value: string; asks: string } {
  const chosen = values.review?.sensor ?? (layer === "project" ? machine.review?.sensor : undefined);
  const off = layer === "machine" && chosen === REVIEW_OFF;
  const rows = off
    ? sensors.map((sensor) => ({ sensor, asked: reads(attention, sensor.id) }))
    : sensors.filter((entry) => entry.id === (chosen ?? review.sensor)).map((sensor) => ({ sensor, asked: true }));
  return {
    value: values.review?.sensor ?? "",
    asks: off ? "one for each check review asks in a project that names it" : "one for each check review asks",
    rows,
    drafts: keptDrafts(drafts, rows),
  };
}

type KeyWords = { label: string; hint: string; status: { text: string; warn: boolean } | null };

/** What a key row says: the machine page holds the key, a project page only says whether it is there. */
export function keyWords(
  { label, key }: { label: string; key: string },
  { asked, kept, layer, role }: { asked: boolean; kept: boolean; layer: "machine" | "project"; role: string },
): KeyWords {
  if (layer === "project")
    return {
      label: key,
      hint: `Kept on this machine for every project. Add, replace or forget it under Machine defaults, on the ${role}.`,
      status: { text: kept ? "set" : "not set", warn: !kept },
    };
  if (!asked)
    return {
      label: `${key}, optional`,
      hint: `Needed only when a project turns ${label} on.${kept ? " Kept on this machine and never shown again." : ""}`,
      status: null,
    };
  return {
    label: key,
    hint: kept
      ? "Kept on this machine and never shown again. Type another to replace it."
      : `${label} asks nothing without one.`,
    status: null,
  };
}
