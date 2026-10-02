import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmSync, rmdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { CleanItem, CleanView } from "../../shared/upkeep-views.ts";
import type { Kit } from "../catalog/kit/kit.ts";
import type { Team } from "../catalog/team/team.ts";
import { git, pristineState } from "../core/git.ts";
import { contentRoot, expandHome, guidesDir, stateRoot, worktreeRoot } from "../core/paths.ts";
import { errorText } from "../core/errors.ts";
import { daemonLog } from "../core/logger.ts";
import { readLedger } from "../desk/store/ledger.ts";
import { heldCopies } from "../desk/copies/held.ts";
import type { Project } from "../desk/project/project.ts";
import { landsAt, present } from "../core/fs.ts";
import { isRecord } from "../core/json.ts";
import { readKept } from "../core/store.ts";

type Found = Omit<CleanItem, "shown">;

type CleanContext = {
  kit: Kit;
  home: string;
  known: Project[];
  teamFor(project: Project): Team;
  live: { provider: string; slug: string }[];
};

function bytesOf(path: string): number {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return 0;
  }
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const name of readdirSync(path)) total += bytesOf(join(path, name));
  return total;
}

function entries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

const item = (path: string, kind: CleanItem["kind"], why: string, extra: Partial<Found> = {}): Found => ({
  path,
  kind,
  why,
  bytes: bytesOf(path),
  careful: false,
  held: null,
  ...extra,
});

/** Nothing else removes a seat directory, but one an open seat runs in is never garbage: its harness is reading it. */
function seats(ctx: CleanContext): Found[] {
  const { kit } = ctx;
  const attached = new Map(ctx.known.map((project) => [project.slug, project]));
  const running = new Set(ctx.live.map((seat) => `${seat.provider}|${seat.slug}`));
  const roots = new Set(Object.values(kit.harnesses).map((harness) => expandHome(harness.profileRoot, ctx.home)));
  const agents = Object.keys(kit.harnesses)
    .map((id) => id.replace(/[^a-z0-9]/gi, "\\$&"))
    .join("|");
  const named = new RegExp(
    `^${kit.prefix.replace(/[^a-z0-9]/gi, "\\$&")}([a-z0-9-]+?)-(${agents})-([a-z0-9-]+-[0-9a-f]{6})$`,
  );
  const found: Found[] = [];
  for (const root of roots) {
    for (const name of entries(root)) {
      const [, role, agent, slug] = named.exec(name) ?? [];
      if (!role || !agent || !slug) continue;
      if (running.has(`${kit.prefix}${role}-${agent}|${slug}`)) continue;
      const path = join(root, name);
      const project = attached.get(slug);
      const spec = kit.roles.find((entry) => entry.role === role);
      const now = project && spec ? ctx.teamFor(project).roles[role]?.harness : undefined;
      if (!project) found.push(item(path, "seat", `${slug} is not attached`));
      else if (!spec) found.push(item(path, "seat", `this version has no ${role} role`));
      else if (now && now.id !== agent) found.push(item(path, "seat", `the ${spec.label} sits on ${now.label} now`));
    }
  }
  return found;
}

async function copies(ctx: CleanContext): Promise<Found[]> {
  const root = worktreeRoot(ctx.home);
  const attached = new Map(ctx.known.map((project) => [project.slug, project]));
  const found: Found[] = [];
  for (const slug of entries(root)) {
    const project = attached.get(slug);
    let held: Set<string>;
    try {
      held = new Set(project ? [...heldCopies(readLedger(project.state))].map((path) => resolve(path)) : []);
    } catch {
      // A ledger that will not read says nothing about which copies are free, so none of them are.
      continue;
    }
    for (const name of entries(join(root, slug))) {
      const path = join(root, slug, name);
      if (held.has(resolve(path))) continue;
      const why = project ? "the desk holds no slot for it" : `${slug} is not attached`;
      // Work in a copy no slot names is likely a crashed seat's and in no commit, so it is shown, not taken.
      const state = existsSync(join(path, ".git")) ? await pristineState(path) : "clean";
      found.push(
        item(
          path,
          "copy",
          why,
          state === "clean" ? {} : { held: state === "dirty" ? "it has uncommitted changes" : "git could not read it" },
        ),
      );
    }
  }
  return found;
}

/** Records outlive Detach on purpose, so attaching again finds its lanes and CONTEXT.md. */
function records(ctx: CleanContext): Found[] {
  const base = join(stateRoot(ctx.home), "projects");
  const attached = new Map(ctx.known.map((project) => [project.slug, project]));
  const found: Found[] = [];
  for (const slug of entries(base)) {
    const path = join(base, slug);
    const project = attached.get(slug);
    if (project && existsSync(project.root)) continue;
    const meta = project ? undefined : readKept(join(path, "meta.json"), {}, isRecord);
    if (meta && "fault" in meta) {
      found.push(
        item(path, "records", "a project's records, but which project is not known", {
          held: meta.fault,
          careful: true,
        }),
      );
      continue;
    }
    const concept = existsSync(join(path, "CONTEXT.md"));
    const why = project ? `attached, but ${project.root} is gone` : "detached; attaching it again would find its lanes";
    found.push(
      item(path, "records", concept ? `${why}. It holds the project's CONTEXT.md` : why, {
        careful: concept || !project,
      }),
    );
  }
  return found;
}

type Links = { targets: string[]; unreadable: string | undefined };

/** Whether an error over a path says there is nothing there, rather than that what is there will not be read. */
function gone(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** What is in `dir`: nothing where the folder is not there, and undefined where it is there and will not be listed. */
function names(dir: string): string[] | undefined {
  try {
    return readdirSync(dir);
  } catch (error) {
    return gone(error) ? [] : undefined;
  }
}

function linksInto(dir: string, depth: number, found: Links): void {
  const here = names(dir);
  if (!here) {
    // A folder that will not be listed may hold a link into any snapshot, so it holds every one of them rather than none.
    found.unreadable ??= dir;
    return;
  }
  for (const name of here) {
    const path = join(dir, name);
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      // What is there and will not be looked at may be a link into any snapshot; only what has gone holds nothing.
      if (!gone(error)) found.unreadable ??= path;
      continue;
    }
    if (stat.isSymbolicLink()) {
      try {
        // A link's text is its own: a relative one points from the folder the link lies in, not from where this process stands.
        found.targets.push(resolve(dir, readlinkSync(path)));
      } catch (error) {
        // Text that will not be read may name any snapshot, so it holds every one of them; only a link that has gone holds none.
        if (!gone(error)) found.unreadable ??= path;
      }
    } else if (stat.isDirectory() && depth > 0) linksInto(path, depth - 1, found);
  }
}

/**
 * Where a link's target lands, canonicalised once: what of the path is there decides it, and a tail that has gone - a
 * dangling link, or one into a file since removed - is left as the link spells it, below a folder that was canonicalised.
 */
function targetLandsAt(target: string): string {
  const gone: string[] = [];
  let at = target;
  while (!present(at) && dirname(at) !== at) {
    gone.unshift(basename(at));
    at = dirname(at);
  }
  return join(landsAt(at), ...gone);
}

/** A copy of the guides or a skill no seat directory links to: the sweep would take it in two weeks. */
function snapshots(ctx: CleanContext): Found[] {
  const root = contentRoot(ctx.home);
  const links: Links = { targets: [], unreadable: undefined };
  linksInto(dirname(guidesDir(ctx.home)), 0, links);
  for (const harness of Object.values(ctx.kit.harnesses)) {
    const seatRoot = expandHome(harness.profileRoot, ctx.home);
    const there = names(seatRoot);
    if (!there) links.unreadable ??= seatRoot;
    else for (const name of there) if (name.startsWith(ctx.kit.prefix)) linksInto(join(seatRoot, name), 3, links);
  }
  if (links.unreadable) {
    daemonLog.error(`every copy of the guides was left alone: ${links.unreadable} is there and would not be read`);
    return [];
  }
  const taken = entries(root).filter((name) => !/\.\d+\.building$/.test(name));
  const named = new Map(taken.map((name) => [landsAt(join(root, name)), name]));
  const linked = new Set<string>();
  for (const target of links.targets)
    for (let at = targetLandsAt(target), up = dirname(at); ; [at, up] = [up, dirname(up)]) {
      const name = named.get(at);
      if (name !== undefined) {
        linked.add(name);
        break;
      }
      if (up === at) break;
    }
  return taken
    .filter((name) => !linked.has(name))
    .map((name) => item(join(root, name), "snapshot", "no seat links to it"));
}

/** A path as the owner reads it: under their home folder, from `~`, on whatever platform. */
function shownOf(path: string, home: string): string {
  const rest = relative(home, path);
  return rest && !rest.startsWith("..") && !isAbsolute(rest) ? join("~", rest) : path;
}

export async function scanGarbage(ctx: CleanContext): Promise<CleanItem[]> {
  const found = [...seats(ctx), ...(await copies(ctx)), ...records(ctx), ...snapshots(ctx)];
  return found.map((each) => ({ ...each, shown: shownOf(each.path, ctx.home) }));
}

/** The repository a linked working copy belongs to, read before the copy is gone. */
function commonDir(copy: string): string | undefined {
  try {
    const gitdir = /^gitdir: (.+)$/m.exec(readFileSync(join(copy, ".git"), "utf-8"))?.[1]?.trim();
    return gitdir ? dirname(dirname(gitdir)) : undefined;
  } catch {
    return undefined;
  }
}

/** Rescans first: the list the owner picked from is older, and a seat may have started in one of those folders since. */
export async function removeGarbage(ctx: CleanContext, picked: string[]): Promise<CleanView> {
  const now = new Map((await scanGarbage(ctx)).map((found) => [found.path, found]));
  const removed: string[] = [];
  const failed: CleanView["failed"] = [];
  for (const path of picked) {
    const found = now.get(path);
    if (!found || found.held) {
      failed.push({ path, shown: shownOf(path, ctx.home), error: found?.held ?? "it is in use now, or already gone" });
      continue;
    }
    try {
      const common = found.kind === "copy" ? commonDir(path) : undefined;
      // A copy the desk locked keeps its record, and its branch with it, through a prune: the lock goes first.
      if (common && existsSync(common)) await git(common, ["worktree", "unlock", path]);
      rmSync(path, { recursive: true, force: true });
      if (common && existsSync(common)) await git(common, ["worktree", "prune"]);
      if (found.kind === "copy" && entries(dirname(path)).length === 0) rmdirSync(dirname(path));
      removed.push(path);
    } catch (error) {
      failed.push({ path, shown: shownOf(path, ctx.home), error: errorText(error) });
    }
  }
  return { items: await scanGarbage(ctx), removed, failed };
}
