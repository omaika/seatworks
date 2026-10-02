import { type Rules, secretFile } from "./facts.ts";

/** One step of a glob: `*`, or one character it accepts, `literal` when that is one character it spells. */
type Step = { star: true } | { star: false; literal: boolean; accepts: (char: string) => boolean };

/** A name a secret pattern spells, and which of its characters are the pattern's own (`+`) rather than a free part's (`-`). */
type Name = { text: string; fixed: string };

/** How many names a secret pattern is sampled to, and how many paths one word is tried as. */
const MOST_NAMES = 256;

/** How many times one word's glob parts are matched against a name before the rest are read as they are written. */
const MOST_MATCHES = 4096;

const names = new WeakMap<RegExp, Name[]>();

/**
 * Whether a glob in `word` makes it a path the secret pattern takes: each part whose glob matches a name the pattern
 * spells, its own characters spelling at least half of that name's fixed text, is tried as that name. `bare` is
 * `word` with what the shell does not glob as `\0`; `dotted`, that a glob matches a leading dot only by spelling it,
 * as the shell's does and git's does not.
 */
export function globsSecret(word: string, bare: string, rules: Rules, dotted: boolean): boolean {
  const fold = rules.secretPath.flags.includes("i");
  let sampled = names.get(rules.secretPath);
  if (!sampled) names.set(rules.secretPath, (sampled = sample(rules.secretPath.source)));
  const longest = Math.max(0, ...sampled.map((name) => name.text.length));
  let budget = MOST_MATCHES;
  // The word as runs it keeps as written, between the parts tried as the names they match.
  const segments: (string | string[])[] = [];
  let from = 0;
  for (let at = 0; at <= word.length; at++) {
    if (at < word.length && word[at] !== "/" && word[at] !== "\\") continue;
    const part = word.slice(from, at);
    const steps = stepsOf(part, bare.slice(from, at), fold);
    const globbed = steps.some((step) => step.star || !step.literal);
    const fits =
      globbed && steps.filter((step) => !step.star).length <= longest
        ? sampled.filter(
            (name) =>
              budget-- > 0 && (!dotted || !name.text.startsWith(".") || startsDot(steps)) && points(steps, name, fold),
          )
        : [];
    if (fits.length > 0) segments.push(fits.map((name) => name.text));
    const kept = (fits.length > 0 ? "" : part) + (word[at] ?? "");
    if (typeof segments.at(-1) === "string") segments.push(`${segments.pop() as string}${kept}`);
    else segments.push(kept);
    from = at + 1;
  }
  return pathsOf(segments).some((path) => secretFile(path, rules));
}

/** The paths the segments make, each list one choice at a time, as many as `MOST_NAMES`; none when no list is in them. */
function pathsOf(segments: (string | string[])[]): string[] {
  const lists = segments.filter((one) => typeof one !== "string");
  if (lists.length === 0) return [];
  let paths = [""];
  for (const segment of segments)
    paths = (
      typeof segment === "string"
        ? paths.map((path) => path + segment)
        : paths.flatMap((path) => segment.map((one) => path + one))
    ).slice(0, MOST_NAMES);
  return paths;
}

const startsDot = (steps: Step[]) => {
  const first = steps[0];
  return first?.star === false && first.literal && first.accepts(".");
};

/** A glob's steps, a character the shell does not glob being itself. */
function stepsOf(word: string, bare: string, fold: boolean): Step[] {
  const steps: Step[] = [];
  const text = fold ? word.toLowerCase() : word;
  // The next `]` is searched for again only past the last one found, so a run of `[` costs one pass.
  let next = -2;
  const closing = (from: number) => (next === -1 || next >= from ? next : (next = bare.indexOf("]", from)));
  for (let at = 0; at < text.length; at++) {
    const char = text[at]!;
    const opens = char === "[" && bare[at] === "[";
    const close = opens ? closing(bare[at + 1] === "!" || bare[at + 1] === "^" ? at + 3 : at + 2) : -1;
    if (bare[at] === "*" && char === "*") {
      if (!steps.at(-1)?.star) steps.push({ star: true });
    } else if (bare[at] === "?" && char === "?") steps.push({ star: false, literal: false, accepts: () => true });
    else if (close > 0) {
      steps.push({ star: false, literal: false, accepts: member(text.slice(at + 1, close)) });
      at = close;
    } else steps.push({ star: false, literal: true, accepts: (one) => one === char });
  }
  return steps;
}

/** What a bracket expression's inside accepts: its characters and ranges, all but them after `!` or `^`. */
function member(inside: string): (char: string) => boolean {
  const negated = inside[0] === "!" || inside[0] === "^";
  const set = negated ? inside.slice(1) : inside;
  return (char) => {
    let found = false;
    for (let at = 0; at < set.length && !found; at++)
      if (set[at + 1] === "-" && at + 2 < set.length) {
        found = char >= set[at]! && char <= set[at + 2]!;
        at += 2;
      } else found = char === set[at];
    return found !== negated;
  };
}

/**
 * Whether the steps match all of the name, their own characters landing on at least half of its fixed ones: `id_*`
 * points at `id_rsa`, while `*s` only fits `credentials`.
 */
function points(steps: Step[], name: Name, fold: boolean): boolean {
  const text = fold ? name.text.toLowerCase() : name.text;
  const fixed = [...name.fixed].filter((one) => one === "+").length;
  // best[at]: the most fixed characters the steps so far spell, having matched the name up to `at`; -1 where they can't.
  let best: number[] = Array.from({ length: text.length + 1 }, (_, at) => (at === 0 ? 0 : -1));
  for (const step of steps) {
    const now = new Array<number>(text.length + 1).fill(-1);
    for (let at = 0; at <= text.length; at++) {
      if (step.star) now[at] = Math.max(best[at]!, at > 0 ? now[at - 1]! : -1);
      else if (at > 0 && best[at - 1]! >= 0 && step.accepts(text[at - 1]!))
        now[at] = best[at - 1]! + (step.literal && name.fixed[at - 1] === "+" ? 1 : 0);
    }
    best = now;
  }
  return fixed > 0 && 2 * best[text.length]! >= fixed;
}

/**
 * Names a pattern's source matches, each free part at its shortest and a class as one of its characters; lookarounds
 * and anchors match nothing. A construct it does not know adds no name.
 */
function sample(source: string): Name[] {
  let at = 0;
  const product = (left: Name[], right: Name[]) =>
    left
      .flatMap((one) => right.map((two) => ({ text: one.text + two.text, fixed: one.fixed + two.fixed })))
      .slice(0, MOST_NAMES);
  const empty: Name = { text: "", fixed: "" };
  const own = (text: string): Name => ({ text, fixed: "+".repeat(text.length) });
  const free = (text: string): Name => ({ text, fixed: "-".repeat(text.length) });
  const alternatives = (): Name[] => {
    const all = [...sequence()];
    while (source[at] === "|") {
      at += 1;
      all.push(...sequence());
    }
    return all.slice(0, MOST_NAMES);
  };
  const sequence = (): Name[] => {
    let found = [empty];
    while (at < source.length && source[at] !== "|" && source[at] !== ")") found = product(found, quantified(atom()));
    return found;
  };
  const quantified = (found: Name[]): Name[] => {
    const quantifier = /^(?:[?*+]|\{(\d+)(?:,\d*)?\})\??/.exec(source.slice(at, at + 12));
    if (!quantifier) return found;
    at += quantifier[0].length;
    const least = quantifier[0][0] === "+" ? 1 : quantifier[1] === undefined ? 0 : Number(quantifier[1]);
    let repeated = [empty];
    for (let time = 0; time < Math.min(least, 4); time++) repeated = product(repeated, found);
    return least === 0 ? [empty, ...found] : repeated;
  };
  const atom = (): Name[] => {
    const char = source[at]!;
    at += 1;
    if (char === "(") {
      const look = /^\?<?[=!]/.exec(source.slice(at, at + 3));
      if (look) at += look[0].length;
      else if (source[at] === "?") at = source.indexOf(source[at + 1] === "<" ? ">" : ":", at) + 1;
      const inner = alternatives();
      at += 1;
      return look ? [empty] : inner;
    }
    if (char === "[") {
      const negated = source[at] === "^";
      let first: Name | undefined;
      for (let end = at + (negated ? 1 : 0); end < source.length; end++) {
        if (source[end] === "]" && end > at) {
          at = end + 1;
          break;
        }
        const one = source[end] === "\\" ? escaped(source[++end]!) : own(source[end]!);
        first ??= one;
      }
      return [negated ? free("x") : (first ?? empty)];
    }
    if (char === "\\") return [escaped(source[at++] ?? "")];
    if (char === "^" || char === "$") return [empty];
    return [char === "." ? free("x") : own(char)];
  };
  return alternatives().filter((name) => name.text !== "" && !/[/\\]/.test(name.text));

  /** What an escape stands for in a sample: a class as a free letter, an anchor as nothing, else the character itself. */
  function escaped(char: string): Name {
    if (char === "b" || char === "B") return empty;
    if (char === "d") return free("0");
    return /[wsSDW]/.test(char) ? free("x") : own(char);
  }
}
