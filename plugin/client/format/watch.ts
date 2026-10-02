import type { WatchCases, WatchCounts, WatchJudge } from "../../shared/flow-views.ts";

const counted = (lines: [number, string][]) =>
  lines.flatMap(([count, state]) => (count > 0 ? [`${count} ${state}`] : []));

/** How many incidents stand where, one line each that has any; `supervisor` is the kit's label for the role told. */
export function incidentLines(counts: WatchCounts, supervisor: string): string[] {
  return counted([
    [counts.told, `told the ${supervisor}`],
    [counts.held, "held · nobody is seated to tell"],
    [counts.recorded, "recorded"],
    [counts.closed, "told and closed since the report was read"],
  ]);
}

/** How many of the Watcher's cases went unjudged, one line each that has any; `judge` is the kit's label for the role. */
export function caseLines(cases: WatchCases, judge: string): string[] {
  return counted([
    [cases.waiting, `waiting on the ${judge}`],
    [cases.expired, "expired unjudged"],
    [cases.dropped, `dropped with no ${judge} to take them`],
    [cases.superseded, "folded into a newer case"],
  ]);
}

type JudgeWords = { title: string; hint: string; tone: "success" | "warning" | "muted" };

/** Who answers the watch's questions and how that stands, in words and a tone; `judgeRole` is the Team chip it is set on. */
export function judgeWords(judge: WatchJudge, judgeRole: string): JudgeWords {
  const words = brainWords(judge, judgeRole);
  if (judge.keyless === null) return words;
  return {
    title: `${judge.keyless.label} is asked nothing: it has no key. ${words.title}`,
    hint: `Add its ${judge.keyless.key} on Team, under Machine defaults, on the ${judgeRole}. ${words.hint}`,
    tone: words.tone === "success" ? "muted" : words.tone,
  };
}

/** How the brains that can be asked stand, in words and a tone. */
function brainWords(judge: WatchJudge, judgeRole: string): JudgeWords {
  const kept = "Its answers are kept in assessments.log; no seat is sent them.";
  if (judge.state === "off")
    return {
      title: "No brain reads what the watch sees",
      hint: `Brains is off: set it on Team, on the ${judgeRole}. The code's own facts go on.`,
      tone: "muted",
    };
  if (judge.state === "nokey")
    return {
      title: `${judge.label} is asked nothing: it has no key`,
      hint: `Add its ${judge.detail} on Team, under Machine defaults, on the ${judgeRole}. The code's own facts go on.`,
      tone: "muted",
    };
  if (judge.state === "failing")
    return {
      title: `${judge.label} is not answering`,
      hint: `${judge.detail}. The code's own facts go on; nothing waits for an answer.`,
      tone: "warning",
    };
  return {
    title: `${judge.label} answers the watch's questions`,
    hint: judge.state === "waiting" ? `Nothing has been asked of it yet. ${kept}` : kept,
    tone: "success",
  };
}
