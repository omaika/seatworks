// The program a test's gate command runs, so a gate says what the test means on any platform's shell: cmd.exe parses a
// gate command on Windows and sh elsewhere, and the two share almost no vocabulary. Node is what both can start.
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";

const [op, ...rest] = process.argv.slice(2);

/** Blocks this process, which is the gate: the shell that started it has nothing else to do either. */
function sleep(seconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

const waitFor = (file: string): void => {
  while (!existsSync(file)) sleep(0.02);
};

const ops: Record<string, (args: string[]) => void> = {
  /** Exit 0 only when every file is there, as `test -f a && test -f b` does. */
  exists: (files) => process.exit(files.every((file) => existsSync(file)) ? 0 : 1),
  /** Exit 1 only when every file is there, as `test ! -f a || test ! -f b` does. */
  missing: (files) => process.exit(files.every((file) => existsSync(file)) ? 1 : 0),
  touch: ([file]) => writeFileSync(file!, ""),
  append: ([file, line]) => appendFileSync(file!, `${line}\n`),
  wait: ([file]) => waitFor(file!),
  held: ([reached, open]) => {
    writeFileSync(reached!, "");
    waitFor(open!);
  },
  sleep: ([seconds]) => sleep(Number(seconds)),
  /** This process's own id, and then a wait long enough to be killed: whoever stops the gate has to reach it. */
  pid: ([file]) => {
    writeFileSync(file!, String(process.pid));
    sleep(30);
  },
  /** One folder at a time: the second gate to run beside this one finds the folder and fails. */
  exclusive: ([dir, seconds]) => {
    mkdirSync(dir!);
    sleep(Number(seconds));
    rmSync(dir!, { recursive: true });
  },
  /** A run that ends green having left something running, which writes into the log once `open` is there, unless it was
   * stopped first; its pid goes to `pidFile`. The line it leaves is worked out here, so the gate command the log opens
   * with does not hold it already. */
  leaves: ([said, file, open, pidFile]) => {
    const line = `late ${6 * 7}\n`;
    const after = `const fs = require("node:fs"); while (!fs.existsSync(${JSON.stringify(open)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); fs.appendFileSync(${JSON.stringify(file)}, ${JSON.stringify(line)})`;
    // In this gate's own process group, not one of its own: what the gate leaves behind is what the group kill must reach.
    const left = spawn(process.execPath, ["-e", after], { stdio: "ignore" });
    left.unref();
    writeFileSync(pidFile!, String(left.pid));
    process.stdout.write(`${said}\n`);
  },
  /** More output than a whole-file read survives, with the reason on the last line. */
  noisy: ([bytes, line]) => {
    process.stdout.write("x".repeat(Number(bytes)));
    process.stdout.write(`\n${line}\n`);
    process.exit(1);
  },
  /** What a run leaves on stderr, and the code it ends with. */
  complain: ([said, code]) => {
    process.stderr.write(`${said}\n`);
    process.exit(Number(code));
  },
  /** A commit on `branch` that nothing merged, made behind the copy's back as another writer would. */
  "move-branch": ([cwd, branch]) => {
    const git = (...args: string[]) => execFileSync("git", ["-C", cwd!, ...args], { encoding: "utf-8" }).trim();
    const commit = git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@x",
      "commit-tree",
      `${branch}^{tree}`,
      "-p",
      branch!,
      "-m",
      "race",
    );
    git("update-ref", `refs/heads/${branch}`, commit);
  },
  /** No two names in `dir` open with the same `width` characters: what a rehearsal of a migration rule checks. */
  "one-per-prefix": ([dir, width]) => {
    const heads = readdirSync(dir!).map((name) => name.slice(0, Number(width)));
    process.exit(new Set(heads).size === heads.length ? 0 : 1);
  },
  /** The rest of the ops, but only the first run after the test armed it: the marker goes as it is taken. */
  armed: ([marker, ...then]) => {
    if (!existsSync(marker!)) process.exit(0);
    rmSync(marker!);
    run(then);
  },
};

function run(argv: string[]): void {
  const [name, ...args] = argv;
  const found = ops[name ?? ""];
  if (!found) {
    process.stderr.write(`gate-run: no such step: ${name}\n`);
    process.exit(2);
  }
  found(args);
}

run([op ?? "", ...rest]);
