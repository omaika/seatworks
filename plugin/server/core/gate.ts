import { spawn, spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";

type GateResult = {
  ok: boolean;
  code: number | null;
  timedOut: boolean;
  stopped: boolean;
  seconds: number;
  tail: string;
};

const WINDOWS = process.platform === "win32";
const TAIL_LINES = 40;
const TAIL_CHARS = 3000;

function tailOf(text: string): string {
  const kept = text.trimEnd().split(/\r?\n/).slice(-TAIL_LINES).join("\n");
  return kept.length > TAIL_CHARS ? kept.slice(-TAIL_CHARS) : kept;
}

/**
 * Kills the gate's whole process group, or on Windows the root's tree: a leftover watcher, dev server or `&` job would keep
 * writing into the lane's copy and the log. On Windows only a timeout or a stop reaches one, since a tree ends with its root.
 */
function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (WINDOWS) spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
    else process.kill(-pid, "SIGKILL");
  } catch {
    // Nothing of the group was left to kill.
  }
}

/** Reads only the tail: a gate log can grow past what a whole-file read survives. Drops a partial first line. */
export function lastBytes(file: string, limit = 64 * 1024): string {
  try {
    const size = statSync(file).size;
    const from = Math.max(0, size - limit);
    const buffer = Buffer.alloc(Math.min(size, limit));
    const fd = openSync(file, "r");
    try {
      readSync(fd, buffer, 0, buffer.length, from);
    } finally {
      closeSync(fd);
    }
    const text = buffer.toString("utf-8");
    return from === 0 ? text : text.slice(text.indexOf("\n") + 1);
  } catch {
    return "";
  }
}

/**
 * Runs `command` on POSIX in a process group of its own, killed whole on timeout, on `stop`, or once the command itself
 * exits; on Windows its tree is reached only while its root lives, so a timeout or a `stop` kills it and its own end does not.
 */
export function runGate(
  command: string,
  cwd: string,
  logFile: string,
  timeoutMs: number,
  stop?: AbortSignal,
  env: Record<string, string> = {},
): Promise<GateResult> {
  mkdirSync(dirname(logFile), { recursive: true });
  const started = Date.now();
  const fd = openSync(logFile, "w");
  writeSync(fd, `$ ${command}\n`);
  return new Promise((resolve) => {
    // Straight to the log fd: a pipe would be inherited by leftover processes and hold "close" open indefinitely.
    const child = spawn(command, {
      cwd,
      env: { ...process.env, CI: "1", ...env },
      shell: true,
      detached: !WINDOWS,
      windowsHide: true,
      stdio: ["ignore", fd, fd],
    });
    const ended = { timedOut: false, stopped: false };
    const kill = (why: keyof typeof ended) => {
      ended[why] = true;
      killGroup(child.pid);
    };
    const timer = setTimeout(() => kill("timedOut"), timeoutMs);
    const onStop = () => kill("stopped");
    let answered = false;
    const finish = (code: number | null) => {
      if (answered) return;
      answered = true;
      clearTimeout(timer);
      stop?.removeEventListener("abort", onStop);
      killGroup(child.pid);
      closeLog(fd);
      resolve(verdict(code, ended, started, logFile));
    };
    if (stop?.aborted) onStop();
    else stop?.addEventListener("abort", onStop, { once: true });
    child.on("error", () => finish(127));
    // exit, not close: the command's own answer, whatever it left running behind it.
    child.on("exit", (code, signal) => finish(code ?? (signal ? null : 0)));
  });
}

function verdict(
  code: number | null,
  { timedOut, stopped }: { timedOut: boolean; stopped: boolean },
  started: number,
  logFile: string,
): GateResult {
  const seconds = Math.round((Date.now() - started) / 1000);
  return {
    ok: code === 0 && !timedOut && !stopped,
    code,
    timedOut,
    stopped,
    seconds,
    tail: tailOf(lastBytes(logFile)),
  };
}

function closeLog(fd: number): void {
  try {
    closeSync(fd);
  } catch {
    // Closed already: the log holds what was written.
  }
}
