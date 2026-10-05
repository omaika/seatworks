import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { UpdateView } from "../../shared/upkeep-views.ts";
import { currentBranch, git } from "../core/git.ts";
import { readJson } from "../core/store.ts";
import { PLUGIN_ID, commandIn, nodeBin, pathDirs } from "../core/paths.ts";
import { daemonLog } from "../core/logger.ts";
import { firstUnder } from "../core/fs.ts";
import { isRecord, sortKeys } from "../core/json.ts";
import { plural } from "../core/text.ts";

export type UpdateContext = {
  dir: string;
  managedRoot: string;
  busy: string[];
  install(dir: string): Promise<string | undefined>;
  reload(): void;
};

type Manifest = {
  version?: string;
  requirements?: { paseo?: string };
  dependencies?: unknown;
  devDependencies?: unknown;
  optionalDependencies?: unknown;
};

/** A package or plugin manifest as git shows it; one that is missing or does not parse is none. */
function manifest(text: string | undefined): Manifest | undefined {
  try {
    const value = JSON.parse(text ?? "") as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** What npm installs from: a package that cannot be read is taken to ask for something new. */
const needs = (text: string | undefined): string => {
  const read = manifest(text);
  return read ? JSON.stringify(sortKeys([read.dependencies, read.devDependencies, read.optionalDependencies])) : "?";
};

/** The version the plugin at `dir` is, as its package names it: what a seat reads raises it. */
export function versionOf(dir: string): string {
  return readJson<{ version?: string }>(join(dir, "package.json"), {}).version ?? "";
}

async function out(dir: string, args: string[]): Promise<string | undefined> {
  const run = await git(dir, args);
  return run.code === 0 ? run.stdout.trim() : undefined;
}

/** Where this checkout stands; `fetch` asks its remote first, and without it the answer is as of the last fetch. */
export async function checkUpdate(ctx: UpdateContext, fetch = true): Promise<UpdateView> {
  const { dir } = ctx;
  const view: UpdateView = {
    dir,
    version: versionOf(dir),
    next: null,
    head: "",
    date: null,
    fetched: fetch,
    branch: null,
    upstream: null,
    behind: 0,
    ahead: 0,
    commits: [],
    installs: false,
    paseo: null,
    blocked: null,
    updated: null,
  };
  const blocked = (why: string) => ({ ...view, blocked: why });
  if (firstUnder(ctx.managedRoot, dir))
    return blocked(
      `Paseo installed this copy from Git: run \`paseo plugin update ${PLUGIN_ID} --ref <branch>\`, naming the branch it came from, since without --ref Paseo takes the remote's default branch.`,
    );
  const checkout = await readCheckout(dir, view);
  if ("blocked" in checkout) return blocked(checkout.blocked);
  const fetched = fetch ? await git(dir, ["fetch", "--quiet", checkout.remote]) : undefined;
  if (fetched && fetched.code !== 0) return blocked(`Could not fetch ${checkout.remote}: ${fetched.stderr.trim()}`);
  await readIncoming(dir, view);
  if (await out(dir, ["status", "--porcelain", "--untracked-files=no"]))
    return blocked("It has local changes, so it does not update itself.");
  if (view.ahead > 0)
    return blocked(
      `It has ${view.ahead} ${plural(view.ahead, "commit", "commits")} ${view.upstream} does not, so it does not update itself.`,
    );
  // A seat keeps the version it started with, so updating under a running lane would run it on two versions.
  if (view.behind > 0 && ctx.busy.length > 0) return blocked(`Stop every seat first: ${ctx.busy.join(", ")}.`);
  return view;
}

/** The checkout's commit, branch and the remote branch it follows, set on `view`; or why there is nothing to update it from. */
async function readCheckout(dir: string, view: UpdateView): Promise<{ remote: string } | { blocked: string }> {
  view.head = (await out(dir, ["rev-parse", "--short", "HEAD"])) ?? "";
  if (!view.head) return { blocked: `${dir} is not a Git checkout, so there is nothing to update it from.` };
  view.date = (await out(dir, ["log", "-1", "--format=%cs"])) ?? null;
  view.branch = (await currentBranch(dir)) ?? null;
  if (!view.branch) return { blocked: "The checkout is on no branch." };
  view.upstream = (await out(dir, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])) ?? null;
  const remote = await out(dir, ["config", `branch.${view.branch}.remote`]);
  if (!view.upstream || !remote) return { blocked: `${view.branch} follows no remote branch.` };
  return { remote };
}

async function readIncoming(dir: string, view: UpdateView): Promise<void> {
  const [ahead, behind] = ((await out(dir, ["rev-list", "--left-right", "--count", "HEAD...@{u}"])) ?? "0\t0")
    .split(/\s+/)
    .map(Number);
  view.ahead = ahead ?? 0;
  view.behind = behind ?? 0;
  const log = (await out(dir, ["log", "--format=%h%x09%s", "-n", "30", "HEAD..@{u}"])) ?? "";
  view.commits = log
    ? log.split("\n").map((line) => ({ sha: line.split("\t")[0]!, subject: line.split("\t").slice(1).join("\t") }))
    : [];
  const incoming = await out(dir, ["show", "@{u}:./package.json"]);
  view.installs =
    Boolean(await out(dir, ["diff", "--name-only", "HEAD", "@{u}", "--", "package-lock.json"])) ||
    needs(incoming) !== needs(await out(dir, ["show", "HEAD:./package.json"]));
  if (view.behind > 0) view.next = manifest(incoming)?.version ?? null;
  const next = manifest(await out(dir, ["show", "@{u}:./paseo-plugin.json"]))?.requirements?.paseo ?? null;
  const now = manifest(readFileSync(join(dir, "paseo-plugin.json"), "utf-8"))?.requirements?.paseo ?? null;
  view.paseo = next !== now ? next : null;
}

export async function applyUpdate(ctx: UpdateContext): Promise<UpdateView> {
  const view = await checkUpdate(ctx);
  if (view.blocked || view.behind === 0) return view;
  const from = view.head;
  const moved = await git(ctx.dir, ["merge", "--ff-only", "--quiet", "@{u}"]);
  if (moved.code !== 0) return { ...view, blocked: `Could not move forward: ${moved.stderr.trim()}` };
  if (view.installs) {
    const failed = await ctx.install(ctx.dir);
    if (failed) {
      await git(ctx.dir, ["reset", "--keep", from]);
      return { ...view, blocked: `npm install failed, so the checkout is back on ${from}: ${failed}` };
    }
  }
  const to = (await out(ctx.dir, ["rev-parse", "--short", "HEAD"])) ?? "";
  ctx.reload();
  return { ...view, head: to, behind: 0, commits: [], updated: { from, to } };
}

export function npmInstall(dir: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const npm = commandIn([dirname(nodeBin()), ...pathDirs()], "npm", ["install", "--no-audit", "--no-fund"]);
    execFile(
      npm.file,
      npm.args,
      { cwd: dir, timeout: 300_000, windowsVerbatimArguments: npm.windowsVerbatimArguments },
      (error, _stdout, stderr) =>
        resolve(error ? String(stderr).trim().split("\n").slice(-3).join("\n") || error.message : undefined),
    );
  });
}

/** After the answer is on its way: the reload stops the runtime that is sending it. */
export function reloadSoon(): void {
  setTimeout(() => {
    const paseo = commandIn(pathDirs(), "paseo", ["plugin", "reload", PLUGIN_ID]);
    execFile(
      paseo.file,
      paseo.args,
      { timeout: 60_000, windowsVerbatimArguments: paseo.windowsVerbatimArguments },
      (error, _stdout, stderr) => {
        if (error) daemonLog.error("plugin reload after the update failed:", String(stderr) || error.message);
      },
    );
  }, 1000);
}
