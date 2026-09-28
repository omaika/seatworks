// A seat's git, first on its PATH on every agent: a guard against mistakes, not a wall. It refuses what only the desk
// does to branches and working copies however the command is spelled (-C, -c, --git-dir, an alias), and runs the rest
// as the real git would. What git itself starts (hooks, rebase --exec, bisect run, submodule foreach) runs the real
// git, as does a git named by its full path. Moving the branch checked out (merge, rebase, reset, cherry-pick) is left
// to each role's own rules: a seat that may write stands on its task's branch, since none checks out or switches. Any
// other ref moved, by whatever command, is refused, since the desk's record names them.
// It works only in the seat's own copy of the project ($SEATWORKS_WORKTREE): the Human's checkout and every other
// seat's copy of the same repository are refused, which on an agent with no sandbox is all that keeps them apart; a
// repository of any other making, as a test suite builds, is not.
// Run as: git-shim.mjs <git> <args>.
import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";

const [git, ...argv] = process.argv.slice(2);

const VALUED = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix", "--config-env", "--list-cmds", "--attr-source"]);

const DESKS = new Set(["push", "pull", "checkout", "switch", "update-ref", "stash", "send-pack", "http-push", "receive-pack", "fast-import", "filter-branch", "filter-repo"]);

const OWN = new Set(["merge", "rebase", "reset", "cherry-pick", "add", "blame", "branch", "commit", "config", "diff", "fetch", "grep", "log", "ls-files", "rev-parse", "show", "status", "worktree"]);

const DEPTH = 10;

function split(args) {
  let at = 0;
  while (at < args.length && args[at].startsWith("-")) at += VALUED.has(args[at]) ? 2 : 1;
  return { globals: args.slice(0, at), command: args[at], rest: args.slice(at + 1) };
}

/** What git prints for these arguments, or nothing where it fails. */
function gitSays(globals, args) {
  const run = spawnSync(git, [...globals, ...args], { encoding: "utf-8" });
  return run.status === 0 ? run.stdout.trim() : "";
}

/**
 * Each long option of the git command `path` names, and whether it takes a value, as git's own completion reads them,
 * so a cut name resolves as this git resolves it. Outside a repository there is no ref to move, and none are needed.
 */
function longsOf(globals, path) {
  const said = gitSays(globals, [...path, "--git-completion-helper-all"]);
  const longs = new Map(
    said
      .split(/\s+/)
      .filter((word) => word.startsWith("--") && word !== "--")
      .map((word) => (word.endsWith("=") ? [word.slice(2, -1), true] : [word.slice(2), false])),
  );
  if (longs.size === 0 && gitSays(globals, ["rev-parse", "--git-dir"]))
    refuse(`git could not list the options of git ${path.join(" ")}, which this check reads to see whether it moves a ref; it needs git 2.18 or newer`);
  return longs;
}

/** The long option `cut` names: its whole name, or the one option it begins; nothing where git would refuse it. */
function resolved(cut, longs) {
  if (longs.has(cut)) return cut;
  const begun = [...longs.keys()].filter((name) => name.startsWith(cut));
  return begun.length === 1 ? begun[0] : undefined;
}

/**
 * A command's arguments as git reads them: each option by its long name with its value, and the operands. `longsFor` is
 * asked only where a long option is given; `shorts` maps a letter to its long names, the last ending in `=` where it
 * takes a value and `?` where the value is only attached.
 */
function parsed(rest, longsFor, shorts = {}) {
  const longs = rest.some((arg) => arg.startsWith("--") && arg !== "--") ? longsFor() : new Map();
  const [options, operands] = [[], []];
  for (let at = 0; at < rest.length; at++) {
    const arg = rest[at];
    if (arg === "--") {
      operands.push(...rest.slice(at + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const [cut, ...value] = arg.slice(2).split("=");
      const name = resolved(cut, longs) ?? cut;
      options.push({ name, value: value.length ? value.join("=") : longs.get(name) ? rest[++at] : undefined });
    } else if (/^-./.test(arg)) {
      for (let letter = 1; letter < arg.length; letter++) {
        const names = shorts[arg[letter]]?.split(" ");
        if (!names) break;
        const last = names.pop();
        options.push(...names.map((name) => ({ name })));
        const attached = arg.slice(letter + 1);
        if (last.endsWith("=")) options.push({ name: last.slice(0, -1), value: attached || rest[++at] });
        else if (last.endsWith("?")) options.push({ name: last.slice(0, -1), value: attached || undefined });
        else options.push({ name: last });
        if (/[=?]$/.test(last)) break;
      }
    } else operands.push(arg);
  }
  return { options, operands };
}

/** Whether option `name` is on at the end: its last mention is not `--no-<name>`. */
const on = (options, name) => options.findLast((option) => [name, `no-${name}`].includes(option.name))?.name === name;
const valueOf = (options, name) => options.findLast((option) => option.name === name)?.value;
const has = (options, ...names) => options.some((option) => names.includes(option.name));
const lands = (spec) => (spec.includes(":") ? spec.slice(spec.lastIndexOf(":") + 1) : "");

/** The fetch refspecs configured for `remote`, or for every remote, that land outside a remote's own mirror. */
function configuredMoves(globals, remote) {
  const pattern = remote ? `^remote\\.${remote.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.fetch$` : "^remote\\..*\\.fetch$";
  return gitSays(globals, ["config", "--get-regexp", pattern])
    .split(/\r?\n/)
    .filter((line) => {
      const to = lands(line.split(/\s+/)[1] ?? "");
      return to !== "" && !to.startsWith("refs/remotes/");
    });
}

/** The remote a bare git fetch fetches: the current branch's, else origin. */
function defaultRemote(globals) {
  const branch = gitSays(globals, ["symbolic-ref", "--short", "-q", "HEAD"]);
  return (branch && gitSays(globals, ["config", "--get", `branch.${branch}.remote`])) || "origin";
}

const FETCH_SHORTS = { v: "verbose", q: "quiet", a: "append", f: "force", m: "multiple", t: "tags", n: "no-tags", j: "jobs=", p: "prune", P: "prune-tags", k: "keep", u: "update-head-ok", o: "server-option=", 4: "ipv4", 6: "ipv6" };

/** Why git fetch would move a ref past a remote's own mirror: into a ref it or its config names, over a tag, or pruning tags. */
function fetchMoves(rest, globals) {
  const { options, operands } = parsed(rest, () => longsOf(globals, ["fetch"]), FETCH_SHORTS);
  const forced = ["force", "prune-tags", "stdin"].find((name) => on(options, name));
  if (forced) return `git fetch --${forced} moves or deletes local refs, and that is the desk's to do; fetch by the remote's name, which moves only its remote-tracking refs`;
  const many = on(options, "all") || on(options, "multiple");
  const named = [...options.filter((option) => option.name === "refmap").map((option) => option.value ?? ""), ...(many ? [] : operands.slice(1))];
  const into = named.map(lands).find((to) => to !== "");
  if (into) return `git fetch into ${into} moves a ref by hand, and that is the desk's to do; fetch by the remote's name, which moves only its remote-tracking refs`;
  const configured = configuredMoves(globals, many ? undefined : (operands[0] ?? defaultRemote(globals)));
  return configured.length ? `git fetch lands where ${configured[0]} says, outside the remote's own mirror, and that is the desk's to do` : undefined;
}

const REBASE_SHORTS = { q: "quiet", v: "verbose", n: "no-stat", C: "C=", f: "force-rebase", m: "merge", i: "interactive", S: "gpg-sign?", x: "exec=", r: "rebase-merges?", s: "strategy=", X: "strategy-option=" };
const REBASE_UNDERWAY = ["continue", "abort", "skip", "quit", "edit-todo", "show-current-patch"];

/** Why git rebase would move a ref past the seat's own branch: checking out another it names, or updating those in its range. */
function rebaseMoves(rest, globals) {
  const { options, operands } = parsed(rest, () => longsOf(globals, ["rebase"]), REBASE_SHORTS);
  // A rebase stopped on the seat's own branch goes on or backs out as it began, and git takes no other option beside these.
  if (has(options, ...REBASE_UNDERWAY)) return undefined;
  const updates = options.some((option) => option.name.endsWith("update-refs"))
    ? on(options, "update-refs")
    : gitSays(globals, ["config", "--type=bool", "--get", "rebase.updateRefs"]) === "true";
  if (updates) return "git rebase that updates the refs in its range moves branches other than yours; rebase with --no-update-refs";
  const branch = on(options, "root") ? operands[0] : operands[1];
  if (branch === undefined || branch === "HEAD") return undefined;
  const [named, mine] = [gitSays(globals, ["rev-parse", "--symbolic-full-name", branch]), gitSays(globals, ["symbolic-ref", "-q", "HEAD"])];
  if (named && named === mine) return undefined;
  return `git rebase naming ${branch} checks it out first, and that is the desk's to do; rebase the branch you stand on`;
}

const BRANCH_SHORTS = { v: "verbose", q: "quiet", t: "track?", u: "set-upstream-to=", r: "remotes", a: "all", d: "delete", D: "delete force", m: "move", M: "move force", c: "copy", C: "copy force", l: "list", f: "force", i: "ignore-case" };
const TAG_SHORTS = { l: "list", n: "n?", d: "delete", v: "verify", a: "annotate", m: "message=", F: "file=", e: "edit", s: "sign", u: "local-user=", f: "force", i: "ignore-case" };
const SUBTREE_LONGS = new Map([["prefix", true], ["annotate", true], ["branch", true], ["onto", true], ["message", true], ["quiet", false], ["debug", false], ["ignore-joins", false], ["rejoin", false], ["squash", false], ["gpg-sign", false]]);

/** For each command that can move a ref, why these arguments would move one past the seat's own branch. */
const MOVES = {
  branch: (rest, globals) => {
    const { options } = parsed(rest, () => longsOf(globals, ["branch"]), BRANCH_SHORTS);
    return ["force", "delete", "move"].some((name) => on(options, name))
      ? "git branch that forces, deletes, renames or overwrites a branch is the desk's to do"
      : undefined;
  },
  worktree: (rest) => (rest[0] !== "list" ? "git worktree changes working copies, and that is the desk's to do" : undefined),
  fetch: fetchMoves,
  tag: (rest, globals) => {
    const { options } = parsed(rest, () => longsOf(globals, ["tag"]), TAG_SHORTS);
    return on(options, "force") || on(options, "delete")
      ? "git tag that forces or deletes moves a tag every copy shares, and that is the desk's to do"
      : undefined;
  },
  "symbolic-ref": (rest, globals) => {
    const { options, operands } = parsed(rest, () => longsOf(globals, ["symbolic-ref"]), { q: "quiet", d: "delete", m: "m=" });
    return operands.length > 1 || on(options, "delete")
      ? "git symbolic-ref that writes or deletes moves HEAD or a ref, and that is the desk's to do; reading one is yours"
      : undefined;
  },
  replace: (rest, globals) => {
    const { options, operands } = parsed(rest, () => longsOf(globals, ["replace"]), { l: "list", d: "delete", e: "edit", g: "graft", f: "force" });
    const lists = has(options, "list") || (operands.length === 0 && options.every((option) => option.name.endsWith("format")));
    return lists ? undefined : "git replace changes the history every copy reads, and that is the desk's to do; listing is yours";
  },
  reflog: (rest, globals) =>
    ["expire", "delete"].includes(rest[0]) && on(parsed(rest.slice(1), () => longsOf(globals, ["reflog", rest[0]])).options, "updateref")
      ? "git reflog --updateref moves the ref it names, and that is the desk's to do; git reset moves your own branch"
      : undefined,
  replay: (rest, globals) =>
    valueOf(parsed(rest, () => longsOf(globals, ["replay"])).options, "ref-action") !== "print"
      ? "git replay moves the refs it replays, and that is the desk's to do; --ref-action=print shows what it would do"
      : undefined,
  history: (rest, globals) => {
    if (!["reword", "split"].includes(rest[0])) return undefined;
    const { options } = parsed(rest.slice(1), () => longsOf(globals, ["history", rest[0]]));
    return on(options, "dry-run") || valueOf(options, "update-refs") === "head"
      ? undefined
      : `git history ${rest[0]} rewrites every branch holding the commit, and that is the desk's to do; --update-refs=head rewrites only yours`;
  },
  bisect: (rest) =>
    rest[0] === "reset" && rest.length > 1
      ? "git bisect reset to a commit checks it out, and that is the desk's to do; git bisect reset returns you to your branch"
      : undefined,
  rebase: rebaseMoves,
  remote: (rest, globals) => {
    const sub = rest.find((arg) => !arg.startsWith("-"));
    if (["rename", "remove", "rm"].includes(sub)) return "git remote rename or remove moves every ref of a remote the desk fetches and pushes through";
    if (sub === "add" && has(parsed(rest.slice(rest.indexOf(sub) + 1), () => longsOf(globals, ["remote", "add"])).options, "mirror"))
      return "git remote add --mirror makes the remote's fetch or push move local refs, and that is the desk's to do";
    const configured = sub === "update" ? configuredMoves(globals) : [];
    return configured.length ? `git remote update lands where ${configured[0]} says, outside the remote's own mirror, and that is the desk's to do` : undefined;
  },
  subtree: (rest) => {
    const { options, operands } = parsed(rest, () => SUBTREE_LONGS, { q: "quiet", d: "debug", P: "prefix=", b: "branch=", m: "message=" });
    if (operands[0] === "push") return "git subtree push is a push, and that is the desk's to do";
    return operands[0] === "split" && has(options, "branch")
      ? "git subtree split --branch moves the branch it names, and that is the desk's to do; split without it prints the commit"
      : undefined;
  },
};

function refusal(command, rest, globals) {
  if (DESKS.has(command)) return `git ${command} moves branches or working copies, and that is the desk's to do`;
  return Object.hasOwn(MOVES, command) ? MOVES[command](rest, globals) : undefined;
}

/**
 * The words an alias stands for, read with the same options, so `git -c alias.p=push p` is read as a push; git ignores
 * an alias named for a command of its own. A shell alias comes back as its text, since what it runs cannot be read
 * here.
 */
function expanded(globals, command) {
  if (OWN.has(command)) return undefined;
  const run = spawnSync(git, [...globals, "config", "--get", `alias.${command}`], { encoding: "utf-8" });
  const alias = run.status === 0 ? run.stdout.trim() : "";
  if (!alias) return undefined;
  return alias.startsWith("!") ? alias : alias.split(/\s+/);
}

/** The copy git works in for these options and the repository it is a copy of; nothing where it works in none. */
function copyOf(globals) {
  const run = spawnSync(git, [...globals, "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], {
    encoding: "utf-8",
  });
  const [top, common] = run.status === 0 ? run.stdout.trim().split(/\r?\n/) : [];
  if (!top || !common) return undefined;
  try {
    return { top: realpathSync.native(top), common: realpathSync.native(common) };
  } catch {
    return undefined;
  }
}

function refuse(why) {
  process.stderr.write(`git: refused: ${why}. Say what you need to whoever gave you the work.\n`);
  process.exit(1);
}

let { globals, command, rest } = split(argv);
const own = process.env.SEATWORKS_WORKTREE;
if (own && command) {
  const [here, mine] = [copyOf(globals), copyOf(["-C", own])];
  if (here && mine && here.common === mine.common && here.top !== mine.top)
    refuse(`this git works in ${here.top}, not in your own copy ${mine.top}; read another copy's work by its branch from yours`);
}
for (let depth = 0; command; depth++) {
  const why = refusal(command, rest, globals);
  if (why) refuse(why);
  const words = expanded(globals, command);
  if (!words) break;
  if (depth === DEPTH) refuse(`git ${command} is an alias more than ${DEPTH} deep, past what this check reads; run what it stands for`);
  // git runs a shell alias with its own directory first on PATH, so the git inside it would pass this shim unread.
  if (typeof words === "string") refuse(`git ${command} is a shell alias, which runs git out of this check's sight; run its commands directly`);
  // An alias may open with options of git's own, as `-p push` does: its command is read after them.
  const again = split([...words, ...rest]);
  globals = [...globals, ...again.globals];
  ({ command, rest } = again);
}

const ran = spawnSync(git, argv, { stdio: "inherit" });
if (ran.error) {
  process.stderr.write(`git: ${ran.error.message}\n`);
  process.exit(127);
}
process.exit(ran.status ?? 1);
