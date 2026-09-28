import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { TestContext } from "node:test";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadKit } from "../../server/catalog/kit/kit.ts";
import { executableIn, pathDirs } from "../../server/core/paths.ts";
import { seatBin } from "../../server/catalog/seat/seat-bin.ts";
import { tempDir } from "../tempdir.ts";

const PLUGIN = fileURLToPath(new URL("../..", import.meta.url));
const WIN = process.platform === "win32";
const COMSPEC = process.env.COMSPEC ?? "cmd.exe";

/** The files one command takes in a seat's bin directory: on Windows the batch file its shells find beside the script Git Bash finds. */
const filesFor = (name: string) => (WIN ? [name, `${name}.cmd`] : [name]);

/**
 * The shim in a seat's bin directory, started as a seat's own tools start a program. On Windows that has to be cmd with
 * the batch file: Node cannot start a .cmd itself, and nothing else in that directory can be started at all.
 */
const shimGit = (dir: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) =>
  WIN
    ? spawnSync(COMSPEC, ["/d", "/c", "call", join(dir, "git.cmd"), ...args], { ...options, encoding: "utf-8" })
    : spawnSync(join(dir, "git"), args, { ...options, encoding: "utf-8" });

const shQuoted = (arg: string) => `'${arg.replaceAll("'", `'\\''`)}'`;
const cmdQuoted = (arg: string) => (/[\s&|<>^"]/.test(arg) ? `"${arg.replaceAll('"', '""')}"` : arg);

/** PATH with `dir` first, under the one spelling: Windows would read either of two keys, and a spread would leave both. */
function pathFirst(dir: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^path$/i.test(name)) delete env[name];
  env.PATH = `${dir}${delimiter}${process.env.PATH ?? ""}`;
  return env;
}

/**
 * The shells a seat's own tools run a command line in, each with a word that puts a command second: cmd on Windows,
 * beside the Git Bash that reads the script where it is on PATH, and sh elsewhere. The bin directory goes first on PATH.
 * Git for Windows leaves its usr/bin off PATH unless its installer was told otherwise, so a run that reaches no sh says
 * which half of the directory nothing exercised: a green job that quietly proved less is worse than one that says so.
 */
function shellsAt(dir: string, t: TestContext) {
  const sh = WIN ? (executableIn(pathDirs(), "sh") ?? executableIn(pathDirs(), "bash")) : "/bin/sh";
  if (!sh)
    t.diagnostic(
      "no sh or bash on PATH: nothing ran the extensionless script Git Bash reads, only the batch file cmd finds",
    );
  const forms = [
    ...(WIN ? [{ file: COMSPEC, lead: ["/d", "/c"], quote: cmdQuoted, second: "call" }] : []),
    ...(sh ? [{ file: sh, lead: ["-c"], quote: shQuoted, second: "env" }] : []),
  ];
  return forms.map(({ file, lead, quote, second }) => ({
    how: file,
    second,
    run: (argv: string[]) =>
      spawnSync(file, [...lead, argv.map(quote).join(" ")], { encoding: "utf-8", env: pathFirst(dir) }),
  }));
}

/** What a batch file's echo writes, read as the shim's own output is: cmd ends a line with a carriage return. */
const lines = (text: string) => text.replaceAll("\r\n", "\n");
const BRANCH_REWRITES = [
  ["-d"],
  ["--delete"],
  ["--del"],
  ["-m", "moved"],
  ["--move", "moved"],
  ["--mo", "moved"],
  ["-C", "copied"],
  ["-vd"],
  ["--forc", "HEAD"],
];
const ALLOWED = [
  ["status", "--short"],
  ["branch"],
  ["branch", "-vv"],
  ["branch", "-c", "main", "copy"],
  ["branch", "aside"],
  ["branch", "--sort", "-committerdate"],
  ["worktree", "list"],
  ["log", "--oneline"],
];

test("a seat's shell, on the PATH the desk gives it, refuses what only the desk does however it is spelled, and runs the rest with the real git", (t) => {
  const root = tempDir("sw2-shim-");
  execFileSync("git", ["-C", root, "init", "-q", "-b", "main"]);
  execFileSync("git", [
    "-C",
    root,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@x",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "seed",
  ]);
  const state = tempDir("sw2-shim-state-");
  mkdirSync(join(state, "bin"));
  // A command an older kit refused, left in the directory: what it holds is never run, only swept.
  writeFileSync(join(state, "bin", "hub"), "a command this kit no longer refuses\n");
  const kit = loadKit(PLUGIN);
  const dir = seatBin(kit, state)!;
  assert.deepEqual(
    readdirSync(dir).sort(),
    ["git", ...Object.keys(kit.refused)].flatMap(filesFor).sort(),
    "each command in the form this platform's shells start, and nothing the kit no longer refuses left refusing",
  );

  const git = (...args: string[]) => shimGit(dir, args);
  const refused = (...args: string[]) => {
    const ran = git(...args);
    return ran.status === 1 && /^git: refused: /.test(ran.stderr);
  };
  assert.equal(git("-C", root, "config", "alias.sw", "switch").status, 0);
  const spelled: [string, string[]][] = [
    ["-C does not hide a push", ["-C", root, "push", "origin", "main"]],
    ["nor does an alias given inline", ["-c", "alias.p=push", "-C", root, "p"]],
    ["nor one kept in the repository's config", ["-C", root, "sw", "-c", "elsewhere"]],
    ["nor an alias that opens with an option of git's own", ["-c", "alias.y=-p push", "-C", root, "y"]],
    [
      "nor a chain of aliases deeper than the shim reads, which it refuses rather than runs",
      [
        ...Array.from({ length: 11 }, (_, at) => [
          "-c",
          `alias.a${at + 1}=${at === 10 ? "push" : `a${at + 2}`}`,
        ]).flat(),
        "-C",
        root,
        "a1",
      ],
    ],
    [
      "nor a shell alias, whose git runs with git's own directory first on PATH",
      ["-c", "alias.s=!git push", "-C", root, "s"],
    ],
    [
      "nor naming the repository by its parts",
      ["--no-pager", `--git-dir=${join(root, ".git")}`, `--work-tree=${root}`, "checkout", "-b", "x"],
    ],
    ["a pull merges as a merge does", ["-C", root, "pull", "--no-rebase", ".", "main"]],
    ["a new working copy is the desk's to make", ["-C", root, "worktree", "add", join(root, "..", "aside")]],
    ...BRANCH_REWRITES.map((flags): [string, string[]] => [
      `git branch ${flags.join(" ")}: the desk's record would name a branch that is gone, and git takes a long option cut short`,
      ["-C", root, "branch", flags[0]!, "main", ...flags.slice(1)],
    ]),
  ];
  for (const [why, args] of spelled) assert.ok(refused(...args), why);
  for (const args of ALLOWED) {
    const ran = git("-C", root, ...args);
    assert.equal(ran.status, 0, `${args.join(" ")}: ${ran.stderr}`);
  }
  assert.equal(
    git("-C", root, "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-q", "--allow-empty", "-m", "work").status,
    0,
  );
  assert.match(
    git("-C", root, "log", "--oneline").stdout,
    /work\n[^\n]*seed/,
    "and what it runs is the real git's doing",
  );

  const shells = shellsAt(dir, t);
  assert.ok(shells.length > 0, "a shell of the platform's own to run a command line in");
  assert.ok(Object.keys(kit.refused).length > 0);
  for (const { how, second, run } of shells) {
    assert.match(
      run(["git", "-C", root, "push"]).stderr,
      /^git: refused: git push/,
      `found by name in ${how}, as a seat's shell finds it`,
    );
    for (const [name, why] of Object.entries(kit.refused)) {
      const ran = run([second, name, "--version"]);
      assert.deepEqual(
        [ran.status, lines(ran.stderr)],
        [1, `${name}: refused: ${why}. Say what you need to whoever gave you the work.\n`],
        `${name}, looked up on PATH as ${how} does, past any rule that reads only a command line's first word`,
      );
    }
  }
});

test("a seat settles what conflicts on its task's branch through its git: merging the base in, rebasing and backing out, resetting its own history", () => {
  const root = tempDir("sw2-shim-own-");
  const real = (...args: string[]) =>
    execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@x", ...args], { encoding: "utf-8" });
  real("init", "-q", "-b", "main");
  writeFileSync(join(root, "a.txt"), "seed\n");
  real("add", "-A");
  real("commit", "-qm", "seed");
  real("switch", "-qc", "task/l1-t1-cart");
  writeFileSync(join(root, "a.txt"), "task\n");
  real("commit", "-qam", "task");
  real("switch", "-q", "main");
  writeFileSync(join(root, "a.txt"), "base\n");
  real("commit", "-qam", "base");
  const dir = seatBin(loadKit(PLUGIN), tempDir("sw2-shim-own-state-"))!;
  const git = (...args: string[]) => shimGit(dir, ["-C", root, "-c", "user.name=t", "-c", "user.email=t@x", ...args]);
  const refused = (...args: string[]) => /^git: refused: /.test(git(...args).stderr);

  real("switch", "-q", "task/l1-t1-cart");
  assert.equal(git("rebase", "main").status === 0, false, "a rebase that stops on a conflict stops as git's own");
  assert.ok(!refused("rebase", "--abort"), "and the seat may back out of it");
  const merged = git("merge", "main");
  assert.ok(!/^git: refused/.test(merged.stderr), "the base merged into its own branch, to settle what conflicts");
  writeFileSync(join(root, "a.txt"), "task and base\n");
  real("add", "a.txt");
  assert.equal(git("commit", "-qm", "settle").status, 0);
  assert.equal(git("reset", "--soft", "HEAD~1").status, 0, "its own history is its own");
});

test("a seat's git works only in its own copy of the project: the Human's checkout and other seats' copies are refused, any other repository is not", () => {
  const root = tempDir("sw2-shim-own-copy-");
  const real = (...args: string[]) =>
    execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@x", ...args], { encoding: "utf-8" });
  real("init", "-q", "-b", "main");
  real("commit", "-q", "--allow-empty", "-m", "seed");
  const copies = tempDir("sw2-shim-copies-");
  const [mine, theirs] = [join(copies, "S0"), join(copies, "S1")];
  real("worktree", "add", "-q", "-b", "task/l1-t1", mine);
  real("worktree", "add", "-q", "-b", "task/l1-t2", theirs);
  const scratch = tempDir("sw2-shim-scratch-");
  execFileSync("git", ["-C", scratch, "init", "-q"]);
  const dir = seatBin(loadKit(PLUGIN), tempDir("sw2-shim-own-copy-state-"))!;
  const git = (cwd: string, ...args: string[]) =>
    shimGit(dir, args, { cwd, env: { ...process.env, SEATWORKS_WORKTREE: mine } });
  for (const [where, cwd, args] of [
    ["its own copy", mine, ["status"]],
    ["its own copy, named from a folder inside it", join(mine, "."), ["log", "--oneline"]],
    ["a repository of its own making, as a test suite's", scratch, ["status"]],
    ["no repository at all", tempDir("sw2-shim-bare-"), ["--version"]],
  ] as const) {
    const ran = git(cwd, ...args);
    assert.equal(ran.status, 0, `${where}: ${ran.stderr}`);
  }
  for (const [where, cwd, args] of [
    ["the Human's own checkout", root, ["status"]],
    ["another seat's copy", theirs, ["log"]],
    ["the Human's checkout named with -C", mine, ["-C", root, "commit", "--allow-empty", "-m", "x"]],
    ["or by its parts", mine, [`--git-dir=${join(root, ".git")}`, `--work-tree=${root}`, "status"]],
  ] as const) {
    const ran = git(cwd, ...args);
    assert.match(ran.stderr, /^git: refused: this git works in [^\n]*, not in your own copy/, where);
  }
});

/**
 * seat-bin read afresh while this process says it is Windows: that module settles which platform it writes for as it
 * loads, so the Windows arm is only reachable from another machine through a load of its own.
 */
const seatBinSayingWin32 = async (): Promise<typeof seatBin> => {
  const fresh: unknown = await import(
    `${new URL("../../server/catalog/seat/seat-bin.ts", import.meta.url).href}?win32`
  );
  return (fresh as { seatBin: typeof seatBin }).seatBin;
};

test("on Windows a seat's PATH directory holds a batch file beside each script, since cmd runs no shell script", async (t) => {
  const was = Object.getOwnPropertyDescriptor(process, "platform")!;
  const path = process.env.PATH;
  t.after(() => {
    Object.defineProperty(process, "platform", was);
    process.env.PATH = path;
  });
  // A git named as Windows installs it, so the directory is written for a machine that has one.
  const found = tempDir("sw2-shim-win-path-");
  writeFileSync(join(found, "git.exe"), "", { mode: 0o755 });
  const mine = tempDir("sw2-shim-win-own-");
  writeFileSync(join(mine, "refused.json"), JSON.stringify({ hub: "100% the desk's, & (its own)" }));
  const kit = loadKit(PLUGIN, mine);
  Object.defineProperty(process, "platform", { ...was, value: "win32" });
  process.env.PATH = found;

  const dir = (await seatBinSayingWin32())(kit, tempDir("sw2-shim-win-state-"))!;
  assert.deepEqual(
    readdirSync(dir).sort(),
    ["git", "git.cmd", "hub", "hub.cmd"],
    "one of each: the batch file cmd and PowerShell find, and the script the Git Bash some agents run commands in finds",
  );
  const read = (name: string) => readFileSync(join(dir, name), "utf-8");
  assert.match(read("git"), /^#!\/bin\/sh\n/, "the script is what it is on every platform");
  const batch = read("git.cmd");
  assert.match(batch, /^@echo off\r\n/, "a batch file cmd does not echo back at the seat");
  assert.deepEqual(
    batch.split("\r\n").filter((line) => line.includes("\n")),
    [],
    "with the line ends cmd needs",
  );
  assert.ok(
    batch.includes(`"${join(found, "git.exe")}"`) && batch.includes(`"${join(kit.dir, "bin", "git-shim.mjs")}"`),
    "running the kit's shim over the git the seat's PATH finds past it, each path quoted against a space in it",
  );
  assert.match(batch, /%\*\r\n$/, "and handed every argument the seat gave");
  const refusal = read("hub.cmd");
  assert.ok(
    refusal.includes(">&2 echo hub: refused: 100%% the desk's, ^& ^(its own^)."),
    "a refusal says why on cmd's own terms, where &, ( and ) start something and % reads a variable",
  );
  assert.match(refusal, /exit \/b 1\r\n$/, "and fails, as the script does");
});
