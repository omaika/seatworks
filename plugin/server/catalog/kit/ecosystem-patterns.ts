import type { Attention } from "../../../shared/views.ts";
import type { FileKinds } from "../../core/git-diff.ts";
import { home } from "../../core/paths.ts";
import { globToRegex } from "../../core/scope.ts";
import { unreadablePaths } from "../seat/refusals.ts";
import type { Kit } from "./kit.ts";

/** What a test file's change is read for: a skip marker it adds, or assertions it loses; global, since they are counted. */
type TestMarkers = { skipped: RegExp; assertion: RegExp };

export function testMarkers(kit: Kit): TestMarkers {
  return {
    skipped: new RegExp(kit.ecosystem.watch.skipped, "gi"),
    assertion: new RegExp(kit.ecosystem.watch.assertion, "gi"),
  };
}

/** A line with its literals blanked: two assertions of one shape check the same thing against different values. */
const shapeOf = (line: string) => line.replace(/(["'`])(?:\\.|(?!\1).)*\1|\b\d+(?:\.\d+)?\b/g, "_");

export function weakened(before: string, after: string, markers: TestMarkers): string | undefined {
  const count = (text: string, pattern: RegExp): number => (text.match(pattern) ?? []).length;
  if (count(after, markers.skipped) > count(before, markers.skipped)) return "adds a skip marker";
  const [was, now] = [count(before, markers.assertion), count(after, markers.assertion)];
  if (now < was) return `${was} assertions become ${now}`;
  // From the assertion on: a test's own title may change, what it expects may not quietly.
  const asserted = (text: string) =>
    text.split("\n").flatMap((line) => {
      const at = line.search(new RegExp(markers.assertion.source, "i"));
      return at < 0 ? [] : [{ line: line.trim(), checks: line.slice(at).trim() }];
    });
  const old = asserted(before);
  const moved = asserted(after).find(
    ({ checks }) =>
      !old.some((kept) => kept.checks === checks) && old.some((kept) => shapeOf(kept.checks) === shapeOf(checks)),
  );
  return moved ? `an expected value changed in \`${moved.line.slice(0, 100)}\`` : undefined;
}

/** The patterns the watch reads calls with: the ecosystem's, and attention's where a settings layer set its own. */
export function watchPatterns(kit: Kit, attention: Attention) {
  return {
    destructive: new RegExp(attention.destructive, "i"),
    scratch: new RegExp(attention.scratch),
    secretPath: new RegExp(attention.secretPath, "i"),
    secretExample: new RegExp(attention.secretExample, "i"),
    unreadable: { home: home(), paths: unreadablePaths(kit, home()).map(globToRegex) },
    secretCommand: new RegExp(attention.secretCommand, "i"),
    secretString: new RegExp(attention.secretString),
    boundary: new RegExp(attention.boundary, "i"),
    localHost: new RegExp(attention.localHost, "i"),
    interpreter: new RegExp(attention.interpreter, "i"),
    dependencyInstall: new RegExp(attention.dependencyInstall, "i"),
    dependencyManifest: new RegExp(attention.dependencyManifest),
    dependencyEntry: new RegExp(attention.dependencyEntry),
    guardPath: new RegExp(attention.guardPath, "i"),
    guardCommand: new RegExp(attention.guardCommand, "i"),
    testPath: new RegExp(attention.testPath, "i"),
    suppressed: new RegExp(attention.suppressed, "i"),
    productBail: new RegExp(attention.productBail),
    checkerPath: new RegExp(attention.checkerPath, "i"),
    refused: new RegExp(kit.ecosystem.watch.refused, "i"),
    ...testMarkers(kit),
    runners: new Set(kit.ecosystem.watch.runners),
  };
}

/** What a lane's record is read for beside its counts: a review asked for certainty only, a brief that writes the work out. */
export function recordPatterns(kit: Kit) {
  const { certainty, prewritten } = kit.ecosystem.watch;
  return {
    certainty: new RegExp(certainty, "i"),
    prewritten: {
      code: new RegExp(prewritten.code),
      step: new RegExp(prewritten.step, "im"),
      then: new RegExp(prewritten.then, "i"),
      fileMember: new RegExp(prewritten.fileMember, "i"),
    },
  };
}

export function fileKinds(kit: Kit): FileKinds {
  return { test: new RegExp(kit.ecosystem.files.test, "i"), docs: new RegExp(kit.ecosystem.files.docs, "i") };
}

/** A failed turn's kind, read from its agent's error by the catalog's forms; none when no form takes it. */
export function turnFailure(kit: Kit, error: string): { kind: string; passes?: string } | undefined {
  return kit.ecosystem.turnFailures.find((form) => new RegExp(form.match, "i").test(error));
}
