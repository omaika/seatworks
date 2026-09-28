import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { test } from "node:test";
import { resolveTeam } from "../../server/catalog/team/team.ts";
import { makeLink } from "../../server/core/fs.ts";
import { contentRoot, stateRoot, worktreeRoot } from "../../server/core/paths.ts";
import { writeJson } from "../../server/core/store.ts";
import { emptyLedger } from "../../server/domain/ledger.ts";
import { removeGarbage, scanGarbage } from "../../server/upkeep/clean.ts";
import { escaped } from "../gates.ts";
import { makeKit } from "../kit.ts";
import { reported } from "../console.ts";
import { noRead } from "../no-read.ts";
import { tempDir } from "../tempdir.ts";

function world() {
  const kit = makeKit();
  const home = tempDir("sw2-home-");
  const root = tempDir("sw2-repo-");
  const shop = { root, slug: "shop-abc123", state: join(stateRoot(home), "projects", "shop-abc123") };
  const seat = (name: string) => {
    const dir = join(home, name.includes("claude") ? ".claude/profiles" : ".omp/seats", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), "{}");
    return dir;
  };
  const copy = (name: string, dirty = false) => {
    const dir = join(worktreeRoot(home), shop.slug, name);
    mkdirSync(dir, { recursive: true });
    if (dirty) {
      execFileSync("git", ["init", "-q", dir]);
      writeFileSync(join(dir, "work.txt"), "unsaved");
    }
    return dir;
  };
  const live: { provider: string; slug: string }[] = [];
  let lead = "claude";
  const ctx = {
    kit,
    home,
    known: [shop],
    live,
    teamFor: () => resolveTeam(kit, {}, { roles: { lead: { harness: lead } } }),
  };
  return { home, shop, seat, copy, live, ctx, moveLead: (to: string) => (lead = to) };
}

/**
 * Ways this platform spells one folder that are not how the plugin spells it: through a link to it, and on Windows its 8.3
 * short form and another case. Each is a spelling a seat's link into the kit can read back as.
 */
function otherSpellings(dir: string, alias: string): { label: string; root: string }[] {
  makeLink(alias, dir);
  const spellings = [{ label: "alias", root: alias }];
  if (process.platform === "win32") {
    const short = execFileSync("cmd", ["/c", `for %I in ("${dir}") do @echo %~sI`], { encoding: "utf-8" }).trim();
    if (short && short !== dir) spellings.push({ label: "short", root: short });
    spellings.push({ label: "case", root: join(dirname(dir), basename(dir).toUpperCase()) });
  }
  return spellings;
}

/**
 * Leaves `dir` listable while what is in it will not be looked at, and hands back what puts it right; nothing where this
 * platform will not have it that way, since a mode that takes search off a folder is POSIX's alone.
 */
function entriesWillNotStat(dir: string): (() => void) | undefined {
  chmodSync(dir, 0o400);
  const put = () => chmodSync(dir, 0o700);
  try {
    lstatSync(join(dir, readdirSync(dir)[0] ?? ""));
  } catch {
    return put;
  }
  put();
  return undefined;
}

/** A link at `path` whose text is relative to the folder it lies in; false where an ordinary account may make no such link. */
function linkRelative(path: string, target: string): boolean {
  mkdirSync(dirname(path), { recursive: true });
  try {
    symlinkSync(relative(dirname(path), target), path);
    return true;
  } catch {
    // Windows without Developer Mode lets an ordinary account point only a junction at a folder, and that takes a full path.
    return false;
  }
}

const found = async (ctx: Parameters<typeof scanGarbage>[0]) =>
  (await scanGarbage(ctx))
    .map((item) => [item.kind, item.path, item.why, item.held, item.careful] as const)
    .sort((a, b) => a[1].localeCompare(b[1]));

test("clean up lists only what nothing will use again: seats nothing will sit in, copies no slot holds, detached records and unlinked copies of the guides", async (t) => {
  const { home, shop, seat, copy, live, ctx, moveLead } = world();
  const said = reported(t);
  assert.deepEqual(await found(ctx), [], "a machine with nothing left over lists nothing");
  const current = seat("sw2-lead-claude-shop-abc123");
  const detached = seat("sw2-peer-omp-gone-def456");
  const hyphened = seat("sw2-second-reviewer-claude-gone-def456");
  const removedRole = seat("sw2-scout-omp-shop-abc123");
  seat("sw2-peer-omp-old-fff000");
  live.push({ provider: "sw2-peer-omp", slug: "old-fff000" });
  seat("sw2-lead-claude");
  const held = copy("S1");
  const free = copy("S2");
  const dirty = copy("S3", true);
  writeJson(join(shop.state, "ledger.json"), {
    ...emptyLedger(),
    slots: { S1: { id: "S1", path: held, lane: "L1", createdAt: 1 } },
  });
  const old = join(stateRoot(home), "projects", "old-fff000");
  mkdirSync(old, { recursive: true });
  writeFileSync(join(old, "CONTEXT.md"), "# Old");
  const unread = join(stateRoot(home), "projects", "shop-abc999");
  mkdirSync(unread, { recursive: true });
  writeFileSync(join(unread, "meta.json"), "{ not json");
  const used = join(contentRoot(home), "guides-aaaaaaaaaaaa");
  const stale = join(contentRoot(home), "guides-bbbbbbbbbbbb");
  mkdirSync(used, { recursive: true });
  mkdirSync(stale, { recursive: true });
  makeLink(join(stateRoot(home), "guides"), used);
  assert.deepEqual(
    await found(ctx),
    [
      ["seat", detached, "gone-def456 is not attached", null, false],
      ["seat", hyphened, "gone-def456 is not attached", null, false],
      ["seat", removedRole, "this version has no scout role", null, false],
      ["copy", free, "the desk holds no slot for it", null, false],
      ["copy", dirty, "the desk holds no slot for it", "it has uncommitted changes", false],
      ["snapshot", stale, "no seat links to it", null, false],
      [
        "records",
        old,
        "detached; attaching it again would find its lanes. It holds the project's CONTEXT.md",
        null,
        true,
      ],
      [
        "records",
        unread,
        "a project's records, but which project is not known",
        `${join(unread, "meta.json")} is there but could not be read: it is not JSON at position 2 (line 1 column 3)`,
        true,
      ],
    ].sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
    "never a seat a seat is running in, a copy a slot holds, a copy of the guides in use, or a name that is no seat's",
  );
  const alias = join(home, "content-alias");
  const spellings = otherSpellings(contentRoot(home), alias);
  for (const { label, root } of spellings) {
    mkdirSync(join(contentRoot(home), `guides-${label}`), { recursive: true });
    mkdirSync(join(current, "kit", label), { recursive: true });
    makeLink(join(current, "kit", label, "guides"), join(root, `guides-${label}`));
  }
  const relatively = join(contentRoot(home), "guides-relative");
  mkdirSync(relatively, { recursive: true });
  if (!linkRelative(join(current, "kit", "relative", "guides"), relatively)) rmSync(relatively, { recursive: true });
  assert.deepEqual(
    (await found(ctx)).flatMap(([kind, path]) => (kind === "snapshot" ? [path] : [])),
    [stale],
    `a snapshot a seat links to is kept however the link spells the content root (${spellings
      .map(({ label }) => label)
      .join(", ")}${existsSync(relatively) ? ", relative to the link's own folder" : ""})`,
  );

  const readKitAgain = noRead(join(current, "kit"));
  assert.deepEqual(
    (await found(ctx)).flatMap(([kind, path]) => (kind === "snapshot" ? [path] : [])),
    [],
    "a folder under a seat that cannot be read may link to any copy of the guides, so none of them is offered",
  );
  readKitAgain();

  const readProfilesAgain = noRead(join(home, ".claude", "profiles"));
  assert.deepEqual(
    (await found(ctx)).flatMap(([kind, path]) => (kind === "snapshot" ? [path] : [])),
    [],
    "a harness's folder of seats that is there and will not be listed hides every seat's links, so no copy is offered",
  );
  readProfilesAgain();
  assert.match(
    said(),
    new RegExp(`${escaped(join(home, ".claude", "profiles"))} is there and would not be read`),
    "the owner is told which folder stopped the sweep, rather than being left with a cleanup that quietly does nothing",
  );

  // Linked while the folder it names is there, so every platform makes the link its own way, and emptied afterwards:
  // what is left is a link whose own tail has gone, through a spelling of the content root that is not the plugin's.
  const dangling = join(contentRoot(home), "guides-dangling");
  mkdirSync(join(dangling, "skills"), { recursive: true });
  mkdirSync(join(current, "kit", "dangling"), { recursive: true });
  makeLink(join(current, "kit", "dangling", "guides"), join(alias, "guides-dangling", "skills"));
  rmSync(join(dangling, "skills"), { recursive: true });
  assert.deepEqual(
    (await found(ctx)).flatMap(([kind, path]) => (kind === "snapshot" ? [path] : [])),
    [stale],
    "a link whose own tail has gone still holds the copy of the guides it lies in, alias and all",
  );

  const stattable = entriesWillNotStat(join(current, "kit"));
  assert.deepEqual(
    (await found(ctx)).flatMap(([kind, path]) => (kind === "snapshot" ? [path] : [])),
    stattable ? [] : [stale],
    stattable
      ? "a seat's folder that lists but whose entries will not be looked at may link to any copy of the guides, so none is offered"
      : "this platform makes no folder that lists while its entries will not be looked at, so the scan runs as it always does",
  );
  if (stattable)
    assert.match(said(), new RegExp(`${escaped(join(current, "kit", ""))}[^\n]* is there and would not be read`));
  stattable?.();

  const seatsOfOmp = join(home, ".omp", "seats");
  renameSync(seatsOfOmp, `${seatsOfOmp}-away`);
  assert.deepEqual(
    (await found(ctx)).flatMap(([kind, path]) => (kind === "snapshot" ? [path] : [])),
    [stale],
    "a harness with no folder of seats at all holds nothing: it is not there, rather than there and unreadable",
  );
  renameSync(`${seatsOfOmp}-away`, seatsOfOmp);

  moveLead("omp");
  assert.deepEqual(
    (await found(ctx)).find(([, path]) => path === current),
    ["seat", current, "the Lead sits on Oh My Pi now", null, false],
    "a seat whose role moved to another agent",
  );

  // Read taken off the records it sits in is what stops the ledger being looked at on either platform; a symlink to
  // itself, which staged this before, is not an ordinary Windows account's to make.
  t.after(noRead(shop.state));
  assert.deepEqual(
    (await found(ctx)).filter(([kind]) => kind === "copy"),
    [],
    "a ledger that cannot even be looked at says no copy is free",
  );
});

test("removal takes only what a fresh scan still finds free, and leaves a folder a seat has started in since and a copy with work in it", async () => {
  const { seat, copy, live, ctx } = world();
  const one = seat("sw2-peer-omp-gone-def456");
  const two = seat("sw2-lead-omp-gone-def456");
  const free = copy("S2");
  const dirty = copy("S3", true);
  const picked = (await found(ctx)).map(([, path]) => path);
  live.push({ provider: "sw2-lead-omp", slug: "gone-def456" });

  const result = await removeGarbage(ctx, picked);
  assert.deepEqual(result.removed.sort(), [one, free].sort());
  assert.deepEqual(
    result.failed.sort((a, b) => a.path.localeCompare(b.path)),
    [
      {
        path: two,
        shown: join("~", ".omp", "seats", "sw2-lead-omp-gone-def456"),
        error: "it is in use now, or already gone",
      },
      {
        path: dirty,
        shown: join("~", ".local", "share", "seatworks-v3", "worktrees", "shop-abc123", "S3"),
        error: "it has uncommitted changes",
      },
    ].sort((a, b) => a.path.localeCompare(b.path)),
  );
  assert.deepEqual(
    [existsSync(one), existsSync(free), existsSync(two), existsSync(join(dirty, "work.txt"))],
    [false, false, true, true],
  );
});

test("a copy the desk locked goes whole when removed, leaving git no record that holds its branch", async () => {
  const { home, shop, ctx } = world();
  const run = (cwd: string, ...args: string[]) =>
    execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@x", ...args], { encoding: "utf-8" });
  run(shop.root, "init", "-q", "-b", "main");
  run(shop.root, "commit", "-q", "--allow-empty", "-m", "seed");
  const left = join(worktreeRoot(home), shop.slug, "S4");
  run(shop.root, "worktree", "add", "-q", "-b", "task/l1-t1-left", left);
  run(shop.root, "worktree", "lock", "--reason", "seatworks: L1-T1", left);

  const result = await removeGarbage(ctx, [left]);
  assert.deepEqual([result.removed, result.failed], [[left], []]);
  assert.doesNotMatch(run(shop.root, "worktree", "list", "--porcelain"), /S4/, "git keeps no locked record of it");
  run(shop.root, "branch", "-D", "task/l1-t1-left");
});
