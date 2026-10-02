import {
  type AttentionChoice,
  type HitlChoice,
  type Layer,
  type LevelId,
  type McpChoice,
  REVIEW_OFF,
  type RoleChoice,
} from "../../shared/settings.ts";

export type Source = "here" | "machine" | "default";

export function sourceOf(
  values: Layer,
  machine: Layer,
  pick: (layer: Layer) => unknown,
  layer: "machine" | "project",
): Source {
  if (pick(values) !== undefined) return "here";
  if (layer === "project" && pick(machine) !== undefined) return "machine";
  return "default";
}

function prune<T extends object>(values: Layer, key: "roles" | "mcp", id: string, entry: T): Layer {
  const group = { ...(values[key] as Record<string, T> | undefined) };
  if (Object.keys(entry).length === 0) delete group[id];
  else group[id] = entry;
  const next = { ...values };
  if (Object.keys(group).length === 0) delete next[key];
  else (next[key] as Record<string, T>) = group;
  return next;
}

export function setRole(values: Layer, role: string, choice: RoleChoice, newHarness = false): Layer {
  const current = values.roles?.[role] ?? {};
  // A new harness drops the old one's model and thinking, but not the seat's rules: those are the owner's writing.
  const base: RoleChoice = newHarness ? (current.rules ? { rules: current.rules } : {}) : current;
  return prune(values, "roles", role, { ...base, ...choice });
}

/** An emptied list is a narrowing to nobody, so a re-paste keeps it rather than hand the new token to every role. */
export function keptRoles(narrowed: string[] | undefined, reachable: string[]): string[] {
  return narrowed ? narrowed.filter((role) => reachable.includes(role)) : reachable;
}

type LevelSeat = Pick<RoleChoice, "harness" | "model" | "thinking">;

/** A seat after one pick: a new agent drops the old one's model and thinking, a new model its thinking. */
export function nextSeat(seat: LevelSeat, change: LevelSeat): LevelSeat {
  if (change.harness !== undefined && change.harness !== seat.harness) return { harness: change.harness };
  if (change.model !== undefined && change.model !== seat.model) return { harness: seat.harness, model: change.model };
  return { ...seat, ...change };
}

/** A level's seat put in whole, or with `null` left to Defaults; a level left with no seat goes with it. */
export function setLevelSeat(values: Layer, level: LevelId, role: string, seat: LevelSeat | null): Layer {
  const { [role]: _was, ...others } = values.levels?.[level] ?? {};
  const seats = seat ? { ...others, [role]: seat } : others;
  const { [level]: _level, ...kept } = values.levels ?? {};
  const levels = Object.keys(seats).length > 0 ? { ...kept, [level]: seats } : kept;
  const { levels: _old, ...rest } = values;
  return Object.keys(levels).length > 0 ? { ...rest, levels } : rest;
}

/** The resolver does not fence models against the catalogue, so show the one in force and flag it when the agent does not list it. */
export function modelRow(
  model: string,
  models: { id: string; label: string }[],
): { value: string; options: { label: string; value: string }[]; stray: boolean } {
  const known = models.map((entry) => ({ label: entry.label, value: entry.id }));
  const stray = Boolean(model) && !models.some((entry) => entry.id === model);
  return { value: model, stray, options: stray ? [...known, { label: model, value: model }] : known };
}

export function setAttention(values: Layer, choice: AttentionChoice): Layer {
  return { ...values, attention: { ...values.attention, ...choice } };
}

export function setHitl(values: Layer, choice: HitlChoice): Layer {
  return { ...values, hitl: { ...values.hitl, ...choice } };
}

/** A pasted server has no kit template to re-enable it, so it is dropped, url and token with it, not marked removed. */
export function dropMcp(values: Layer, id: string): Layer {
  return prune(values, "mcp", id, {});
}

export function setMcp(values: Layer, id: string, choice: McpChoice): Layer {
  const current = values.mcp?.[id] ?? {};
  const settings = { ...current.settings, ...choice.settings };
  const entry: McpChoice = { ...current, ...choice };
  if (Object.keys(settings).length > 0) entry.settings = settings;
  else delete entry.settings;
  return prune(values, "mcp", id, entry);
}

/** A sensor's key set, or with `null` forgotten; the server keeps any other key the values show as KEPT. */
export function withKey(values: Layer, id: string, key: string | null): Layer {
  const { [id]: _was, ...others } = values.sensor ?? {};
  const sensor = key ? { ...others, [id]: { key } } : others;
  return { ...values, sensor: Object.keys(sensor).length > 0 ? sensor : undefined };
}

/** None goes back to the kit's sensor for review; only REVIEW_OFF stops it, never the watch's brains. */
export function setReviewSensor(values: Layer, sensor: string | undefined): Layer {
  const { review: _was, ...rest } = values;
  return sensor ? { ...rest, review: { sensor } } : rest;
}

/** The sensors whose key review's line offers: the one that asks, or with review Off on the machine every one, since a project may still name any. */
export function reviewKeySensors<S extends { id: string }>(
  sensors: readonly S[],
  chosen: string | undefined,
  kits: string | null,
  layer: "machine" | "project",
): S[] {
  if (layer === "machine" && chosen === REVIEW_OFF) return [...sensors];
  return sensors.filter((entry) => entry.id === (chosen ?? kits));
}

/** Emptied, no language is set and the Supervisor answers as its prompt has it. */
export function setLanguage(values: Layer, language: string): Layer {
  const { language: _was, ...rest } = values;
  return language.trim() ? { ...rest, language: language.trim() } : rest;
}
