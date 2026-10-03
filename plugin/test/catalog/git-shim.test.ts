import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { TestContext } from "node:test";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadKit } from "../../server/catalog/kit/kit.ts";
import { executableIn, pathDirs } from "../../server/core/paths.ts";
import { seatBin } from "../../server/catalog/seat/seat-bin.ts";
import { harness } from "../runtime/harness.ts";
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
const psQuoted = (arg: string) => `'${arg.replaceAll("'", "''")}'`;

/** PATH with `dir` first, under the one spelling: Windows would read either of two keys, and a spread would leave both. */
function pathFirst(dir: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^path$/i.test(name)) delete env[name];
  env.PATH = `${dir}${delimiter}${process.env.PATH ?? ""}`;
  return env;
}

/**
 * The shells a seat's own tools run a command line in, each with a word that puts a command second: cmd on Windows,
 * beside the Git Bash that reads the script where it is on PATH, sh elsewhere, and PowerShell 7 where it is installed,
 * which claude and codex run commands in on Windows. The bin directory goes first on PATH. Git for Windows leaves its
 * usr/bin off PATH unless its installer was told otherwise, so a run that reaches no sh, or no PowerShell, says which
 * shell nothing exercised: a green job that quietly proved less is worse than one that says so.
 */
function shellsAt(dir: string, t: TestContext) {
  const sh = WIN ? (executableIn(pathDirs(), "sh") ?? executableIn(pathDirs(), "bash")) : "/bin/sh";
  if (!sh)
    t.diagnostic(
      "no sh or bash on PATH: nothing ran the extensionless script Git Bash reads, only the batch file cmd finds",
    );
  const pwsh = executableIn(pathDirs(), "pwsh");
  if (!pwsh) t.diagnostic("no pwsh on PATH: nothing ran a git typed into PowerShell");
  const forms = [
    ...(WIN
      ? [{ file: COMSPEC, lead: ["/d", "/c"], line: (argv: string[]) => argv.map(cmdQuoted).join(" "), second: "call" }]
      : []),
    ...(sh ? [{ file: sh, lead: ["-c"], line: (argv: string[]) => argv.map(shQuoted).join(" "), second: "env" }] : []),
    // A command's name is a bare word, as a seat types it: quoted first, PowerShell reads a string, not a command.
    ...(pwsh
      ? [
          {
            file: pwsh,
            lead: ["-NoProfile", "-NonInteractive", "-Command"],
            line: ([name, ...args]: string[]) => [name, ...args.map(psQuoted)].join(" "),
            second: "&",
          },
        ]
      : []),
  ];
  return forms.map(({ file, lead, line, second }) => ({
    how: file,
    second,
    run: (argv: string[]) => spawnSync(file, [...lead, line(argv)], { encoding: "utf-8", env: pathFirst(dir) }),
  }));
}

/** The env a seat's git runs in, the desk naming `copy` as the seat's own copy of the project. */
const seatIn = (copy: string): NodeJS.ProcessEnv => ({ ...process.env, SEATWORKS_WORKTREE: copy });

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

  const git = (...args: string[]) => shimGit(dir, args, { env: seatIn(root) });
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

test("a seat settles what conflicts on its task's branch through its git: picking a commit from the base, merging it in, rebasing and backing out, resetting its own history", () => {
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
  writeFileSync(join(root, "b.txt"), "fix\n");
  real("add", "b.txt");
  real("commit", "-qm", "fix");
  const dir = seatBin(loadKit(PLUGIN), tempDir("sw2-shim-own-state-"))!;
  const git = (...args: string[]) =>
    shimGit(dir, ["-C", root, "-c", "user.name=t", "-c", "user.email=t@x", ...args], { env: seatIn(root) });
  const refused = (...args: string[]) => /^git: refused: /.test(git(...args).stderr);

  real("switch", "-q", "task/l1-t1-cart");
  const picked = git("cherry-pick", "main");
  assert.equal(picked.status, 0, `a fix from the base picked onto its own branch: ${picked.stderr}`);
  assert.equal(real("log", "-1", "--format=%s"), "fix\n");
  assert.equal(git("rebase", "main").status === 0, false, "a rebase that stops on a conflict stops as git's own");
  assert.equal(
    git("-c", "rebase.updateRefs=true", "rebase", "--show-current-patch").status,
    0,
    "it reads where it stopped whatever rebase.updateRefs says",
  );
  assert.ok(!refused("rebase", "--abort"), "and the seat may back out of it");
  const merged = git("merge", "main");
  assert.ok(!/^git: refused/.test(merged.stderr), "the base merged into its own branch, to settle what conflicts");
  writeFileSync(join(root, "a.txt"), "task and base\n");
  real("add", "a.txt");
  assert.equal(git("commit", "-qm", "settle").status, 0);
  assert.equal(git("reset", "--soft", "HEAD~1").status, 0, "its own history is its own");
});

test("a seat's git works only in its own copy of the project: the Human's checkout and other seats' copies are refused, any other repository is not", () => {
  const h = harness();
  const root = h.root;
  const copies = tempDir("sw2-shim-copies-");
  const [mine, theirs] = [join(copies, "S0"), join(copies, "S1")];
  h.git(root, "worktree", "add", "-q", "-b", "task/l1-t1", mine);
  h.git(root, "worktree", "add", "-q", "-b", "task/l1-t2", theirs);
  const scratch = tempDir("sw2-shim-scratch-");
  execFileSync("git", ["-C", scratch, "init", "-q"]);
  // The env Paseo opens a Peer's session with in its copy: the desk names that copy, and puts the shim first on PATH.
  const { env } = h.runtime.sessionOpen({
    agentId: "peer",
    reason: "create",
    purpose: "interactive",
    provider: "sw2-peer-claude",
    cwd: mine,
    env: {},
  });
  const dir = env.PATH!.split(delimiter)[0]!;
  const git = (cwd: string, ...args: string[]) => shimGit(dir, args, { cwd, env: { ...pathFirst(dir), ...env } });
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

const REF_MOVES: [string, string[]][] = [
  ["fetch into a local branch", ["fetch", "origin", "main:other"]],
  ["fetch forced into one", ["fetch", "origin", "+main:other"]],
  ["fetch by a glob of branches", ["fetch", "origin", "+refs/heads/*:refs/heads/*"]],
  ["fetch naming where a remote-tracking ref lands", ["fetch", "origin", "main:refs/remotes/origin/main"]],
  ["fetch from this repository itself", ["fetch", ".", "main:other"]],
  ["fetch whose refspecs come from stdin", ["fetch", "--stdin", "origin"]],
  ["fetch mapped into local branches", ["fetch", "--refmap=+refs/heads/*:refs/heads/*", "origin", "main"]],
  ["fetch forced, which clobbers tags", ["fetch", "--force", "origin"]],
  ["fetch forced in a cluster", ["fetch", "-pf", "origin"]],
  ["fetch pruning local tags", ["fetch", "--prune-tags", "origin"]],
  ["fetch pruning tags, short", ["fetch", "-P", "origin"]],
  ["tag -f", ["tag", "-f", "v1"]],
  ["tag --force, cut short", ["tag", "--forc", "v1", "HEAD"]],
  ["tag forced in a cluster", ["tag", "-fam", "note", "v1"]],
  ["tag -d", ["tag", "-d", "v1"]],
  ["tag --delete", ["tag", "--delete", "v1"]],
  ["symbolic-ref pointing HEAD elsewhere", ["symbolic-ref", "HEAD", "refs/heads/other"]],
  ["symbolic-ref with a reason", ["symbolic-ref", "-m", "why", "HEAD", "refs/heads/other"]],
  ["symbolic-ref -d", ["symbolic-ref", "-d", "refs/heads/alias"]],
  ["symbolic-ref --delete", ["symbolic-ref", "--delete", "refs/heads/alias"]],
  ["replace one object by another", ["replace", "HEAD", "HEAD~1"]],
  ["replace --graft", ["replace", "--graft", "HEAD"]],
  ["replace -d", ["replace", "-d", "HEAD"]],
  ["reflog delete that moves the ref back", ["reflog", "delete", "--updateref", "other@{0}"]],
  ["reflog expire that moves refs back", ["reflog", "expire", "--updateref", "--all"]],
  ["replay, which updates the refs it replays", ["replay", "--onto", "main", "main..other"]],
  ["rebase naming another branch, which checks it out", ["rebase", "main", "other"]],
  ["rebase --root naming another branch", ["rebase", "--root", "other"]],
  ["rebase naming a commit, which detaches HEAD", ["rebase", "main", "HEAD~1"]],
  ["rebase --update-refs", ["rebase", "--update-refs", "main"]],
  ["rebase with rebase.updateRefs set", ["-c", "rebase.updateRefs=true", "rebase", "main"]],
  ["remote rename", ["remote", "rename", "origin", "upstream"]],
  ["remote remove", ["remote", "remove", "origin"]],
  ["remote rm", ["remote", "rm", "origin"]],
  ["subtree split into a branch", ["subtree", "split", "-P", "dir", "-b", "other"]],
  ["filter-branch", ["filter-branch", "--", "--all"]],
  ["filter-repo", ["filter-repo", "--force"]],
  ["fast-import", ["fast-import"]],
  ["rebase --root cut short, naming another branch", ["rebase", "--roo", "other"]],
  [
    "fetch through a refspec given as config",
    ["-c", "remote.origin.fetch=+refs/heads/main:refs/heads/other", "fetch", "origin"],
  ],
  [
    "fetch of one branch, which a refspec given as config also lands",
    ["-c", "remote.origin.fetch=+refs/heads/main:refs/heads/other", "fetch", "origin", "main"],
  ],
  ["remote add as a mirror", ["remote", "add", "--mirror=fetch", "copy", "elsewhere"]],
  ["history reword, which rewrites every branch holding the commit", ["history", "reword", "HEAD~1"]],
  ["history split", ["history", "split", "HEAD"]],
  ["bisect reset to another commit", ["bisect", "reset", "main"]],
  ["checkout of another branch", ["checkout", "other"]],
  ["switch to a new branch", ["switch", "-c", "aside"]],
  ["update-ref", ["update-ref", "refs/heads/other", "HEAD"]],
  ["stash", ["stash", "list"]],
  ["worktree add", ["worktree", "add", "-q", "../aside"]],
  ["branch -D", ["branch", "-D", "other"]],
];

/** What reaches a remote: refused in any repository, since the remote is the Human's whatever repository it is run from. */
const REACHES: [string, string[]][] = [
  ["push", ["push", "origin", "main"]],
  ["pull", ["pull", "--no-rebase", "origin", "main"]],
  ["push through an alias", ["-c", "alias.p=push", "p"]],
  ["pull through an alias kept in config", ["-c", "alias.up=pull --ff-only", "up"]],
  ["a shell alias, whose git this check cannot read", ["-c", "alias.s=!git push", "s"]],
  ["subtree push", ["subtree", "push", "-P", "dir", "origin", "main"]],
  ["send-pack", ["send-pack", ".", "main:other"]],
  ["http-push", ["http-push", "http://example.invalid/", "main"]],
  ["receive-pack", ["receive-pack", "."]],
];

/**
 * A repository with a remote, a branch `other`, a tag `v1`, and a task branch checked out one commit past main, for
 * git run as the test suite that `real` stands for runs it.
 */
function refsRepo(prefix: string) {
  const root = tempDir(`${prefix}-`);
  const origin = tempDir(`${prefix}-origin-`);
  const real = (...args: string[]) =>
    execFileSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@x", ...args], { encoding: "utf-8" });
  execFileSync("git", ["-C", origin, "init", "-q", "-b", "main"]);
  execFileSync("git", [
    "-C",
    origin,
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
  real("init", "-q", "-b", "main");
  real("remote", "add", "origin", origin);
  real("fetch", "-q", "origin");
  real("reset", "-q", "--hard", "origin/main");
  real("branch", "other");
  real("tag", "v1");
  real("switch", "-qc", "task/l1-t1-cart");
  writeFileSync(join(root, "a.txt"), "task\n");
  real("add", "a.txt");
  real("commit", "-q", "-m", "task");
  return { root, origin, real };
}

/** Whether the installed git offers `option` on the command `path` names; a row that needs it is left out, and the run says so. */
function offers(t: TestContext, cwd: string, option: string, ...path: string[]) {
  const listed = spawnSync("git", ["-C", cwd, ...path, "--git-completion-helper-all"], { encoding: "utf-8" });
  const has = listed.status === 0 && listed.stdout.split(/\s+/).includes(option);
  if (!has) t.diagnostic(`this git's ${path.join(" ")} has no ${option}: nothing ran the rows that need it`);
  return has;
}

/** `history fixup`, where the installed git has it: git 2.55 added it, rewriting every branch holding the commit. */
const fixupRows = (t: TestContext, cwd: string): [string, string[]][] =>
  offers(t, cwd, "--update-refs=", "history", "fixup")
    ? [["history fixup, which rewrites every branch holding the commit", ["history", "fixup", "HEAD~1"]]]
    : [];

test("a seat's git refuses every spelling that moves a ref other than its own branch, and runs what moves nothing else", (t) => {
  const { root, origin, real } = refsRepo("sw2-shim-refs");
  const dir = seatBin(loadKit(PLUGIN), tempDir("sw2-shim-refs-state-"))!;
  const git = (...args: string[]) =>
    shimGit(dir, ["-C", root, "-c", "user.name=t", "-c", "user.email=t@x", ...args], { env: seatIn(root) });

  const passed = [...REF_MOVES, ...fixupRows(t, root), ...REACHES]
    .filter(([, args]) => !/^git: refused: /.test(git(...args).stderr))
    .map(([why]) => why);
  assert.deepEqual(passed, [], "each spelling that moves a ref other than the seat's own branch");
  const refs = real("for-each-ref", "--format=%(refname) %(objectname)");
  // A row that needs an option this git lacks is left out, and the run says so: the shim still takes git 2.18.
  const printsReplay = offers(t, root, "--ref-action=", "replay");
  const rewordsHead = offers(t, root, "--update-refs=", "history", "reword");
  const allowed = [
    ["fetch", "origin"],
    ["fetch", "--prune", "origin"],
    ["fetch", "origin", "main"],
    ["fetch", "--depth", "1", pathToFileURL(origin).href, "main"],
    ["fetch", "--all"],
    ["tag", "v2"],
    ["tag", "-a", "-m", "note", "v3"],
    ["tag", "--sort", "-creatordate"],
    ["symbolic-ref", "HEAD"],
    ["symbolic-ref", "--short", "-q", "HEAD"],
    ["replace", "-l"],
    ...(printsReplay ? [["replay", "--ref-action=print", "--onto", "main", "main..other"]] : []),
    ["rebase", "main", "task/l1-t1-cart"],
    ["-c", "rebase.updateRefs=true", "rebase", "--no-update-refs", "main"],
    ["reflog"],
    ["notes", "add", "-m", "seen"],
    ["remote", "-v"],
    ["remote", "add", "copy", origin],
    ["rebase", "--empty", "drop", "main"],
    ["rebase", "--whitespace", "fix", "main"],
    ["rebase", "--ont", "main", "main"],
    ["rebase", "--exe", "true", "main"],
    ["rebase", "--strategy-opt", "theirs", "main"],
    ["-c", "sequence.editor=true", "rebase", "-ix", "true", "main"],
    ["tag", "-a", "-m", "-df", "v9"],
    ["replace", "--format", "short"],
    ...(printsReplay ? [["replay", "--ref-action", "print", "--onto", "main", "main..other"]] : []),
    ...(rewordsHead ? [["-c", "core.editor=true", "history", "reword", "--update-refs=head", "HEAD"]] : []),
    ["bisect", "start", "HEAD", "main"],
    ["bisect", "run", "false"],
    ["bisect", "reset"],
  ];
  const failed = allowed.flatMap((args) => {
    const ran = git(...args);
    return ran.status === 0 ? [] : [`${args.join(" ")}: ${ran.stderr}`];
  });
  assert.deepEqual(failed, [], "each spelling that moves nothing past the seat's own branch runs");
  const stopped = ["--continue", "--abort", "--skip", "--quit", "--edit-todo", "--show-current-patch"].filter(
    (action) => /^git: refused: /.test(git("-c", "rebase.updateRefs=true", "rebase", action).stderr),
  );
  assert.deepEqual(stopped, [], "a rebase under way goes on or backs out whatever rebase.updateRefs says");
  const moved = new Set(real("for-each-ref", "--format=%(refname) %(objectname)").split("\n"));
  assert.deepEqual(
    refs
      .split("\n")
      .filter((line) => line.startsWith("refs/heads/") && !line.startsWith("refs/heads/task/") && !moved.has(line)),
    [],
    "and no branch but the seat's own moved",
  );

  real("remote", "add", "up", origin);
  real("config", "--add", "remote.up.fetch", "+refs/notes/*:refs/notes/*");
  const bare = git("fetch");
  assert.equal(bare.status, 0, `a bare fetch reads only the remote it fetches, here origin: ${bare.stderr}`);
  real("remote", "add", "--mirror=fetch", "mirror", origin);
  real("config", "--add", "remote.origin.fetch", "+refs/heads/main:refs/heads/other");
  const unseen = [
    ["fetch", "mirror"],
    ["fetch", "--all"],
    ["-c", "branch.task/l1-t1-cart.remote=up", "fetch"],
    ["fetch"],
    ["fetch", "origin"],
    ["remote", "update"],
  ].filter((args) => !/^git: refused: /.test(git(...args).stderr));
  assert.deepEqual(unseen, [], "nor does a refspec the repository's config holds move a local branch unseen");
});

test("a seat's git leaves a repository of another making, as the project's own test suite builds, to git, but for what reaches a remote", (t) => {
  const project = refsRepo("sw2-shim-project");
  const copies = tempDir("sw2-shim-project-copies-");
  const [copy, theirs] = [join(copies, "S0"), join(copies, "S1")];
  project.real("worktree", "add", "-q", "-b", "task/l1-t2", copy);
  project.real("worktree", "add", "-q", "-b", "task/l1-t4", theirs);
  const fixture = refsRepo("sw2-shim-fixture");
  const dir = seatBin(loadKit(PLUGIN), tempDir("sw2-shim-fixture-state-"))!;
  // Git itself, unrefused, may open an editor or pause to warn: neither waits on a test.
  const env = { ...seatIn(copy), GIT_EDITOR: "true", FILTER_BRANCH_SQUELCH_WARNING: "1" };
  const refused = (where: string, args: string[], seat: NodeJS.ProcessEnv = env) =>
    /^git: refused: /.test(
      shimGit(dir, ["-C", where, "-c", "user.name=t", "-c", "user.email=t@x", ...args], { env: seat }).stderr,
    );
  const rows = [...REF_MOVES, ...fixupRows(t, fixture.root)];

  const guarded = rows.filter(([, args]) => !refused(copy, args)).map(([why]) => why);
  assert.deepEqual(guarded, [], "in the seat's own copy, a worktree of the project, each is refused");
  assert.ok(
    refused(fixture.root, ["tag", "-d", "v1"], { ...process.env, SEATWORKS_WORKTREE: undefined }),
    "and with no copy named there is no telling a repository from the project's, so none is left unguarded",
  );
  const gitDirOf = (at: string) =>
    execFileSync("git", ["-C", at, "rev-parse", "--absolute-git-dir"], { encoding: "utf-8" }).trim();
  const tips = () => project.real("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/");
  const tipsBefore = tips();
  assert.ok(
    refused(copy, [`--git-dir=${gitDirOf(project.root)}`, `--work-tree=${copy}`, "reset", "--soft", "HEAD~1"]),
    "the Human's git directory over the seat's own work tree would move the Human's branch",
  );
  assert.ok(
    refused(copy, ["reset", "--soft", "HEAD~1"], { ...env, GIT_DIR: gitDirOf(theirs), GIT_WORK_TREE: copy }),
    "as would another seat's, named by GIT_DIR",
  );
  assert.ok(
    refused(copy, [`--git-dir=${gitDirOf(project.root)}`, "--bare", "reset", "--soft", "HEAD~1"]),
    "and with no work tree at all",
  );
  assert.ok(
    refused(gitDirOf(theirs), ["reset", "--soft", "HEAD~1"]),
    "or run from inside another seat's git directory",
  );
  assert.equal(tips(), tipsBefore, "and no branch moved");
  const own = shimGit(dir, ["-C", copy, "status", "--short"], { env: { ...env, GIT_DIR: gitDirOf(copy) } });
  assert.equal(own.status, 0, `the seat's own git directory named by GIT_DIR is its own: ${own.stderr}`);
  const inside = shimGit(dir, ["-C", gitDirOf(copy), "log", "-1", "--oneline"], { env });
  assert.equal(inside.status, 0, `as is git run from inside it: ${inside.stderr}`);
  const fixtureDir = join(fixture.root, ".git");
  assert.ok(
    !refused(copy, ["tag", "-d", "v1"], { ...env, GIT_DIR: fixtureDir }),
    "a fixture named by GIT_DIR is no more the project's, though git runs from the seat's own copy",
  );
  assert.equal(fixture.real("tag", "-l", "v1"), "", "and git deleted its tag");
  const overwrite = shimGit(dir, [`--git-dir=${fixtureDir}`, `--work-tree=${project.root}`, "checkout", "-f", "main"], {
    cwd: copy,
    env,
  });
  assert.match(
    overwrite.stderr,
    /^git: refused: this git works in [^\n]*, not in your own copy/,
    "a fixture's history checked out over the Human's checkout is refused, whatever git directory it is read from",
  );
  assert.equal(readFileSync(join(project.root, "a.txt"), "utf-8"), "task\n", "and their files are as they were");
  // A repository of its own inside a copy, as a vendored dependency or a suite's fixture sits there.
  const nestedIn = (parent: string) => {
    const at = join(parent, "vendor", "dep");
    mkdirSync(at, { recursive: true });
    const real = (...args: string[]) =>
      execFileSync("git", ["-C", at, "-c", "user.name=t", "-c", "user.email=t@x", ...args], { encoding: "utf-8" });
    real("init", "-q", "-b", "main");
    real("commit", "-q", "--allow-empty", "-m", "seed");
    real("branch", "other");
    return { at, branch: () => real("symbolic-ref", "--short", "HEAD").trim() };
  };
  const inHumans = nestedIn(project.root);
  assert.ok(
    refused(inHumans.at, ["checkout", "-q", "other"]),
    "a repository nested in the Human's checkout writes their files, so it is theirs as the checkout is",
  );
  assert.equal(inHumans.branch(), "main");
  const inMine = nestedIn(copy);
  assert.ok(!refused(inMine.at, ["checkout", "-q", "other"]), "one nested in the seat's own copy is the seat's");
  assert.equal(inMine.branch(), "other");
  const inner = join(project.root, ".copies", "S2");
  project.real("worktree", "add", "-q", "-b", "task/l1-t3", inner);
  const inInner = nestedIn(inner);
  assert.ok(
    !refused(inInner.at, ["checkout", "-q", "other"], { ...env, SEATWORKS_WORKTREE: inner }),
    "and a seat's own copy inside the Human's checkout is still its own: the nearest copy decides",
  );
  const besideTheirs = nestedIn(`${theirs}-fixture`);
  assert.ok(
    !refused(besideTheirs.at, ["checkout", "-q", "other"]),
    "a repository whose path only begins with another copy's lies outside it",
  );
  assert.equal(besideTheirs.branch(), "other");
  const before = fixture.real("for-each-ref", "--format=%(refname) %(objectname)");
  const passed = rows.filter(([, args]) => refused(fixture.root, args)).map(([why]) => why);
  assert.deepEqual(passed, [], "in the fixture, each runs as git would outside Seatworks");
  assert.notEqual(
    fixture.real("for-each-ref", "--format=%(refname) %(objectname)"),
    before,
    "and moves the fixture's refs as git moves them",
  );
  const bare = tempDir("sw2-shim-fixture-bare-");
  execFileSync("git", ["clone", "-q", "--bare", fixture.origin, bare]);
  assert.ok(!refused(bare, ["update-ref", "-d", "refs/heads/main"]), "a bare repository with no work tree too");
  const reached = REACHES.filter(([, args]) => !refused(fixture.root, args)).map(([why]) => why);
  assert.deepEqual(reached, [], "what reaches a remote is refused wherever it is run");
});

test("a seat's git that cannot list a command's options refuses that command in a repository, saying which git it needs", () => {
  const dir = seatBin(loadKit(PLUGIN), tempDir("sw2-shim-old-git-state-"))!;
  const root = tempDir("sw2-shim-old-git-repo-");
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
  execFileSync("git", ["-C", root, "branch", "other"]);
  // A value its command dies on stops the real git listing that command's options, as a git before 2.18 does, and on
  // Windows too, where the shim starts only a git.exe and no git of the test's own making.
  const unlisted = ["-c", "fetch.parallel=x", "-c", "rebase.autoSquash=maybe"];
  const git = (where: string, ...args: string[]) =>
    shimGit(dir, ["-C", where, ...unlisted, ...args], { env: seatIn(root) });

  for (const args of [
    ["fetch", "--forc", "origin"],
    ["rebase", "--roo", "other"],
  ])
    assert.match(
      git(root, ...args).stderr,
      /^git: refused: git could not list the options of git (fetch|rebase)[^\n]*git 2\.18 or newer/,
      args.join(" "),
    );
  assert.doesNotMatch(
    git(root, "fetch", "origin").stderr,
    /^git: refused/,
    "a command given no long option has none to read, and is left to git",
  );
  assert.doesNotMatch(
    git(tempDir("sw2-shim-old-git-bare-"), "fetch", "--forc", "origin").stderr,
    /^git: refused/,
    "outside a repository there is no ref to move",
  );
  const fixture = tempDir("sw2-shim-old-git-fixture-");
  execFileSync("git", ["-C", fixture, "init", "-q", "-b", "main"]);
  assert.doesNotMatch(
    git(fixture, "fetch", "--forc", "origin").stderr,
    /^git: refused/,
    "nor in a repository of another making, where no ref the project names can move",
  );
});
