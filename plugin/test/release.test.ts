import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertPluginCompatibility } from "@getpaseo/protocol/plugin-requirements";

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..");

const git = (...args: string[]) => {
  try {
    return execFileSync("git", ["-C", PLUGIN, ...args], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return undefined;
  }
};
const versionAt = (ref: string) =>
  (JSON.parse(git("show", `${ref}:./package.json`) ?? "{}") as { version?: string }).version;
const versionNow = () =>
  (JSON.parse(readFileSync(join(PLUGIN, "package.json"), "utf-8")) as { version?: string }).version;

/** What a seat reads or is held to: its content, harness, tools and role, the letters and briefs the desk writes it, and what its PATH refuses. */
const SEAT_FACING = [
  "content",
  "harness",
  "mcp",
  "roles.json",
  "server/desk/letters",
  "bin/git-shim.mjs",
  "catalog/refused.json",
];

/** Owners learn of a change in what seats read only through the version: Update names it, and the Plugin section the seats started before it. */
test(
  "a change to what a seat reads comes with a new version",
  { skip: git("rev-parse", "HEAD") === undefined && "not a git checkout" },
  () => {
    const dirty = git("status", "--porcelain", "--", ...SEAT_FACING)?.trim();
    if (dirty) {
      assert.notEqual(
        versionNow(),
        versionAt("HEAD"),
        `what a seat reads changed since the last commit; raise version in package.json:\n${dirty}`,
      );
      return;
    }
    const parent = git("rev-parse", "--verify", "HEAD~1")?.trim();
    const moved = parent ? git("diff", "--name-only", "HEAD~1", "HEAD", "--", ...SEAT_FACING)?.trim() : "";
    if (moved)
      assert.notEqual(
        versionAt("HEAD"),
        versionAt("HEAD~1"),
        `the last commit changed what a seat reads without raising the version:\n${moved}`,
      );
  },
);

/** Checked as Paseo's daemon and app check a plugin before loading it, with the SDK's own check. */
test("Paseo 0.10.2 and a later 0.10 load the plugin, and Paseo 0.9 refuses it", () => {
  const { id, requirements } = JSON.parse(readFileSync(join(PLUGIN, "paseo-plugin.json"), "utf-8")) as {
    id: string;
    requirements?: { paseo?: string };
  };
  const load = (version: string) => () => assertPluginCompatibility({ id, requirements, version, runtime: "daemon" });
  for (const version of ["0.10.2", "0.10.7"]) assert.doesNotThrow(load(version), `Paseo ${version} loads it`);
  for (const version of ["0.9.1", "0.9.2"])
    assert.throws(load(version), /requires Paseo/, `Paseo ${version} refuses it`);
});
