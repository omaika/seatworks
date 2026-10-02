import { posix, win32 } from "node:path";
import { oneLine, within } from "../../core/text.ts";
import { type Fact, fact } from "../../domain/incident.ts";
import { type Rules, secretFile, str } from "./facts.ts";
import { commandDigest } from "./command-digest.ts";
import { globsSecret } from "./globs-secret.ts";
import type { Call } from "./window.ts";

const MKTEMP = /\b([A-Za-z_]\w*)=["']?(?:\$\(\s*mktemp\b[^)]*\)|`\s*mktemp\b[^`]*`)/g;
const VARIABLE = /^\$\{?([A-Za-z_]\w*)\}?(?:\/|$)/;
const DIRNAME = /^\$\(\s*dirname\s+([^)]*)\)$/;
const CLIMBS = /(?:^|[/\\])\.\.(?:[/\\]|$)/;

/** The end of the `$(…)` that opens at `start`, counting the parentheses nested in it. */
function closing(line: string, start: number): number {
  let depth = 0;
  for (let at = start; at < line.length; at++) {
    if (line[at] === "(") depth += 1;
    else if (line[at] === ")" && --depth === 0) return at;
  }
  return line.length - 1;
}

/** A word so far that only a Windows path starts: nothing yet, `.` or `..`, a drive, or a backslash of its own. */
const WINDOWS_START = /^(?:\.{0,2}|[A-Za-z]:.*|.*\\.*)$/s;

/** Whether a backslash escapes `next`: before whitespace it ends a Windows path such as `..\ ` instead, where one began. */
const escapes = (word: string | undefined, next: string): boolean =>
  /["'$`\\]/.test(next) || (/\s/.test(next) && !WINDOWS_START.test(word ?? ""));

/** A word as the shell passes it, and the same with each character it got quoted or escaped as `\0`, which it neither globs nor expands. */
type Word = { word: string; bare: string };

/**
 * A command's words as the shell passes them: quotes and escapes gone, `"$TMPDIR"/x` one word, and a `$(…)` kept whole
 * with its own quotes. A backslash escapes only what the shell would read otherwise, so a Windows path keeps its own.
 */
function shellTokens(line: string): Word[] {
  const words: Word[] = [];
  let word: string | undefined;
  let bare = "";
  let quote: string | undefined;
  const add = (text: string, held: boolean) => {
    word = (word ?? "") + text;
    bare += held ? "\0".repeat(text.length) : text;
  };
  for (let at = 0; at < line.length; at++) {
    const char = line[at]!;
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else add(char, true);
    } else if (char === "$" && line[at + 1] === "(") {
      const end = closing(line, at + 1);
      add(line.slice(at, end + 1), true);
      at = end;
    } else if (char === "\\" && escapes(word, line[at + 1] ?? "")) {
      add(line[++at] ?? "", true);
    } else if (char === '"' || (char === "'" && !quote)) {
      quote = quote === char ? undefined : char;
      word ??= "";
    } else if (!quote && /\s/.test(char)) {
      if (word !== undefined) words.push({ word, bare });
      word = undefined;
      bare = "";
    } else add(char, quote !== undefined);
  }
  if (word !== undefined) words.push({ word, bare });
  return words;
}

const shellWords = (line: string): string[] => shellTokens(line).map(({ word }) => word);

/** What removes files, as each shell names it; cmd's flags start with a slash. */
const REMOVES = new Set(["rm", "remove-item", "ri", "rmdir", "rd", "del", "erase"]);

/** What changes the directory the next command runs in, as each shell names it. */
const MOVES = new Set(["cd", "chdir", "pushd", "popd", "set-location", "sl", "push-location", "pop-location"]);

/** A move's own words: its name, its flags and its first target; what follows them in the part is a command of its own. */
const MOVE = /^\s*\S+(?:\s+(?:-\S*|\/[a-z](?=\s|$)))*(?:\s+(?:"[^"]*"|'[^']*'|[^\s|&;<>]+))?/i;

/**
 * One command as the shell runs it: its text, the same with what its quotes hold blanked so only what runs is read, the
 * separator after it, the commands its `$(…)` and backticks hold, and its heredocs.
 */
type Command = { text: string; unquoted: string; then: string | undefined; holds: Command[]; heredocs: Heredoc[] };

/** A heredoc, `at` where it opens in its command; the shell expands `$(…)` and backticks in its body unless its delimiter is quoted. */
type Heredoc = { delimiter: string; tabs: boolean; expands: boolean; at: number; body: string };

/** How deep commands may sit in one another before the reader stops and reads the raw text instead. */
const DEEPEST = 32;

/** How many times its own length a command's code handed on may add up to before the reader reads the raw text instead. */
const REREAD = 4;

/** Thrown when commands nest deeper, or hand on more code, than the reader follows. */
class OutOfReach extends Error {}

/** Quoted text keeps its words for what reads them, as SQL handed to a client, and loses what a shell acts on. */
const blank = (text: string) => text.replace(/[^\w ]/g, " ");

/** One quoted word with nothing a shell acts on, as `"--force"`: the program gets it as if it were unquoted. */
const PLAIN = /^[\w.,/:@=+%~-]+$/;

const quoted = (inner: string) => (PLAIN.test(inner) ? inner : blank(inner));

const HEREDOC = /<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|(\\?)([^\s;&|<>()]+))/y;

const matchAt = (pattern: RegExp, text: string, at: number) => {
  pattern.lastIndex = at;
  return pattern.exec(text);
};

/** Where a `$(…)` or backticks opening at `at` end, the commands in them added to `into`; undefined when none opens there. */
function substitution(source: string, at: number, depth: number, into: Command[]): number | undefined {
  if (source.startsWith("$(", at)) {
    const inner = commandsIn(source, depth + 1, at + 2, true);
    into.push(...inner.commands);
    return Math.min(inner.end + 1, source.length);
  }
  if (source[at] !== "`") return undefined;
  let close = at + 1;
  while (close < source.length && source[close] !== "`") close += source[close] === "\\" ? 2 : 1;
  into.push(...commandsIn(source.slice(at + 1, close), depth + 1).commands);
  return Math.min(close + 1, source.length);
}

/** The commands a heredoc's body runs as it is expanded: those in its `$(…)` and backticks. */
function expanded(body: string, depth: number): Command[] {
  const commands: Command[] = [];
  for (let at = 0; at < body.length;) at = substitution(body, at, depth, commands) ?? at + (body[at] === "\\" ? 2 : 1);
  return commands;
}

/** Where the double quotes opening at `at` close, or the end. */
function closingQuote(source: string, at: number): number {
  let close = at + 1;
  while (close < source.length && source[close] !== '"') close += source[close] === "\\" ? 2 : 1;
  return Math.min(close, source.length);
}

/**
 * The commands in `source` as a shell splits them: by `&&`, `||`, `;`, a newline or a single `&` outside quotes, a heredoc's
 * body never one of them. With `closes`, `source` from `from` is a `$(…)`'s inside, and `end` is where its `)` is.
 */
function commandsIn(source: string, depth: number, from = 0, closes = false): { commands: Command[]; end: number } {
  if (depth > DEEPEST) throw new OutOfReach(`commands nest deeper than ${DEEPEST}`);
  const commands: Command[] = [];
  let waiting: Heredoc[] = [];
  let begin = from;
  let unquoted = "";
  let holds: Command[] = [];
  let heredocs: Heredoc[] = [];
  let parens = 0;
  // A `case`'s arms: `fresh` at a command's first word, `opened` from `case` until its `in`, `arm` where a pattern comes.
  let fresh = true;
  let opened = false;
  let cases = 0;
  let arm = false;
  const finish = (end: number, then: string | undefined) => {
    const text = source.slice(begin, end);
    if (text.trim()) commands.push({ text, unquoted, then, holds, heredocs });
    unquoted = "";
    holds = [];
    heredocs = [];
    fresh = true;
  };
  let at = from;
  while (at < source.length) {
    const char = source[at]!;
    const two = source.slice(at, at + 2);
    if (fresh && !/\s/.test(char)) {
      fresh = false;
      const word = matchAt(CASE_WORD, source, at)?.[1];
      const pattern = arm && word !== "esac" ? patternEnd(source, at) : undefined;
      arm = false;
      if (pattern !== undefined) {
        // An arm's pattern is no command: what follows its `)` is.
        at = pattern + 1;
        begin = at;
        unquoted = "";
        fresh = true;
        continue;
      }
      if (word === "case") opened = true;
      else if (word === "esac") cases = Math.max(0, cases - 1);
    }
    if (opened && /\s/.test(source[at - 1] ?? "") && matchAt(IN, source, at)) {
      finish(at + 2, undefined);
      at += 2;
      begin = at;
      opened = false;
      cases += 1;
      arm = true;
      continue;
    }
    const held = substitution(source, at, depth, holds);
    const heredoc = two === "<<" && source[at + 2] !== "<" ? matchAt(HEREDOC, source, at) : null;
    if (held !== undefined) {
      unquoted += " ".repeat(held - at);
      at = held;
    } else if (char === "\\") {
      unquoted += two === "\\\n" ? "  " : two;
      at += 2;
    } else if (char === "'") {
      const close = source.indexOf("'", at + 1);
      const end = close < 0 ? source.length : close + 1;
      unquoted += `'${quoted(source.slice(at + 1, close < 0 ? end : close))}${close < 0 ? "" : "'"}`;
      at = end;
    } else if (char === '"') {
      const close = closingQuote(source, at);
      const inner = source.slice(at + 1, close);
      if (PLAIN.test(inner)) {
        unquoted += `"${inner}`;
        at = close;
      } else {
        unquoted += '"';
        at += 1;
        while (at < close) {
          const next = substitution(source, at, depth, holds) ?? (source[at] === "\\" ? at + 2 : at + 1);
          unquoted += source[at] === "\\" || next - at > 1 ? " ".repeat(next - at) : blank(source[at]!);
          at = next;
        }
      }
      if (at < source.length) unquoted += '"';
      at += 1;
    } else if (char === "#" && (at === begin || /[\s;&|(]/.test(source[at - 1]!))) {
      const end = source.indexOf("\n", at);
      unquoted += " ".repeat((end < 0 ? source.length : end) - at);
      at = end < 0 ? source.length : end;
    } else if (heredoc) {
      const [opening, tabs, single, double, escaped, bare] = heredoc;
      const delimiter = single ?? double ?? bare!;
      const expands = single === undefined && double === undefined && !escaped;
      const one = { delimiter, tabs: tabs === "-", expands, at: unquoted.length, body: "" };
      waiting.push(one);
      heredocs.push(one);
      unquoted += `<<${blank(opening.slice(2))}`;
      at += opening.length;
    } else if (char === ")" && closes && parens === 0) {
      finish(at, undefined);
      return { commands, end: at };
    } else if (two === "&&" || two === "||" || char === ";" || char === "\n" || (char === "&" && single(source, at))) {
      const then = two === "&&" || two === "||" ? two : char;
      if (cases > 0 && (two === ";;" || two === ";&")) arm = true;
      finish(at, then);
      at += then.length;
      if (char === "\n") {
        at = bodies(source, at, waiting);
        waiting = [];
      }
      begin = at;
    } else {
      if (char === "(") parens += 1;
      else if (char === ")") parens = Math.max(0, parens - 1);
      unquoted += char;
      at += 1;
    }
  }
  finish(source.length, undefined);
  return { commands, end: source.length };
}

const CASE_WORD = /(case|esac)(?=[\s;&|)]|$)/y;

const IN = /in(?=[\s;]|$)/y;

/**
 * Where the `)` closing a `case` arm's pattern opening at `at` is, quotes and all; undefined when what is there is no pattern,
 * which is words joined by `|`.
 */
function patternEnd(source: string, at: number): number | undefined {
  let joined = true;
  for (let end = at; end < source.length; end++) {
    const char = source[end]!;
    if (char === ")") return end;
    if (/[;&<>\n]/.test(char)) return undefined;
    if (/\s/.test(char)) {
      while (/[ \t]/.test(source[end + 1] ?? "")) end += 1;
      if (!joined && !/[|)]/.test(source[end + 1] ?? "")) return undefined;
      continue;
    }
    joined = char === "|" || char === "(";
    if (char === "\\") end += 1;
    else if (char === "'") end = source.indexOf("'", end + 1) < 0 ? source.length : source.indexOf("'", end + 1);
    else if (char === '"') end = closingQuote(source, end);
  }
  return undefined;
}

/** What may end a command in text too deep to read, quotes or not, as `single` reads a lone `&`. */
const RAW_SEPARATORS = /&&|\|\||;|\n|(?<![<>|&])&(?![&>])/;

/** A single `&` ends a command in cmd, PowerShell and sh alike; in `2>&1`, `&>` or `|&` it is part of a redirection. */
const single = (source: string, at: number) =>
  !/[<>|&]/.test(source[at - 1] ?? "") && !/[&>]/.test(source[at + 1] ?? "");

/** Reads the bodies of `heredocs` from `at`, a line each until its delimiter, and returns where the next command starts. */
function bodies(source: string, at: number, heredocs: Heredoc[]): number {
  for (const heredoc of heredocs) {
    const lines: string[] = [];
    while (at < source.length) {
      const newline = source.indexOf("\n", at);
      const end = newline < 0 ? source.length : newline;
      const line = source.slice(at, end).replace(/\r$/, "");
      at = end + 1;
      if ((heredoc.tabs ? line.replace(/^\t+/, "") : line) === heredoc.delimiter) break;
      lines.push(line);
    }
    heredoc.body = lines.join("\n");
  }
  return Math.min(at, source.length);
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);

const programOf = (word: string | undefined) =>
  (word ?? "")
    .replace(/^.*[/\\]/, "")
    .toLowerCase()
    .replace(/\.exe$/, "");

/** A command's pipeline: the words of each program in it, and where each starts in the command. */
type Program = { words: string[]; start: number };

function pipeline(text: string, unquoted: string): Program[] {
  const cuts = [...unquoted.matchAll(/\|/g)].map((match) => match.index);
  return [0, ...cuts.map((cut) => cut + 1)].map((start, index) => ({
    words: shellWords(text.slice(start, cuts[index])),
    start,
  }));
}

/** An interpreter's flag that hands it code to run inline: `-c`, `-e`, `-E`, or ending a short cluster as `-pe` does. */
const INLINE = /^-[a-zA-Z0-9]{0,3}[ceE]$|^--eval$/;

/** A shell's: only `-c` is code, as `-e` is errexit; `-o` and `+o` take an option's name. */
const SHELL_INLINE = /^-[a-zA-Z]*c[a-zA-Z]*$/;

/** PHP's: `-r` is code. */
const PHP_INLINE = /^-r$/;

/** A redirection: its operator, and its target when it is spelled in the same word. */
const REDIRECT = /^\d*(<<<|<<-?|<&|<|>>?|&>>?|>&|>\|)(.*)$/s;

/** Code given inline in the word at `code`, a script at `path`, or, with neither, what comes on stdin; `read` words were read. */
type Script = { code?: number; path?: string; read: number };

const stdin = (script: Script) => script.code === undefined && script.path === undefined;

/**
 * What the interpreter at `words[from]` runs: code given inline in the word at `code`, a script at a path, or else what
 * comes on stdin.
 */
function scriptOf(words: string[], from = 0): Script {
  const name = programOf(words[from]);
  const shell = SHELLS.has(name);
  const inline = shell ? SHELL_INLINE : name === "php" ? PHP_INLINE : INLINE;
  // After `-`, what follows is the script's own arguments.
  let stdin = false;
  for (let at = from + 1; at < words.length; at++) {
    const word = words[at]!;
    const redirect = REDIRECT.exec(word);
    if (redirect) {
      const target = redirect[2] || words[++at];
      if (redirect[1] === "<" && target) return { path: target, read: at + 1 };
    } else if (word === "-") stdin = true;
    else if (stdin) continue;
    else if (inline.test(word)) return { code: at + 1, read: at + 2 };
    else if (shell && /^[-+]o$/.test(word)) at += 1;
    else if (!word.startsWith("-")) return { path: word, read: at + 1 };
  }
  return { read: words.length };
}

/** ssh's options that take a value, whose next word is no host. */
const SSH_VALUED = /^-[46AaCfGgKkMNnqsTtVvXxYy]*[BbcDEeFIiJLlmOoPpQRSWw]$/;

/**
 * The code a command hands a shell as text: `sh -c`'s argument, what follows `cmd /c`, `powershell -Command`, `eval` or
 * the host ssh runs it on. The first such word is enough, its code holding any after it; a program's own flags are read
 * once, as commands run long.
 */
function wrapped(words: string[]): string | undefined {
  for (let index = 0; index < words.length; index++) {
    const name = programOf(words[index]);
    let at = index + 1;
    if (SHELLS.has(name)) {
      const script = scriptOf(words, index);
      if (script.code !== undefined) return words[script.code];
      at = script.read;
    } else if (name === "cmd") {
      while (at < words.length && words[at]!.startsWith("/") && !/^\/[ck]$/i.test(words[at]!)) at += 1;
      if (/^\/[ck]$/i.test(words[at] ?? "")) return words.slice(at + 1).join(" ");
    } else if (name === "powershell" || name === "pwsh") {
      while (at < words.length && words[at]!.startsWith("-") && !/^-c(?:ommand)?$/i.test(words[at]!)) at += 1;
      if (/^-c(?:ommand)?$/i.test(words[at] ?? "")) return words.slice(at + 1).join(" ");
    } else if (name === "ssh") {
      while (at < words.length && words[at]!.startsWith("-")) at += SSH_VALUED.test(words[at]!) ? 2 : 1;
      if (at + 1 < words.length) return words.slice(at + 1).join(" ");
    } else if (name === "eval" && index === 0) {
      while (programOf(words[at]) === "eval") at += 1;
      return words.slice(at).join(" ");
    }
    index = Math.max(index, at - 1);
  }
  return undefined;
}

/** Calls that run a shell command from a program's own code, in the languages the interpreters speak. */
const SHELL_OUT =
  /\b(?:os\.(?:system|popen)|subprocess\.(?:run|call|check_call|check_output|Popen|getoutput|getstatusoutput)|(?:child_process\.)?(?:execSync|execFileSync|spawnSync|execFile|exec|spawn)|Bun\.spawn(?:Sync)?|system|popen|shell_exec|passthru|proc_open|IO\.popen|Open3\.\w+)\s*\(?\s*/g;

/** A string literal, with Python's prefixes; its quote and what it holds. */
const LITERAL = /(?:[rRbBuUfF]{1,2})?(["'`])((?:\\.|(?!\1)[^\\])*)\1\s*/y;

const COMMA = /,\s*/y;

/** Where a language's own syntax runs a shell command: backticks, and Perl's `qx` and Ruby's `%x` with any delimiter. */
const SHELL_SYNTAX: Record<string, RegExp> = {
  perl: /`|\bqx\s*(?=[^\w\s])/g,
  ruby: /`|%x(?=[^\w\s])/g,
  php: /`/g,
};

const PAIRED: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">" };

/** What the delimiter at `at` encloses, a paired one counting its nesting, and where it ends. */
function delimited(code: string, at: number): { body: string; end: number } {
  const open = code[at]!;
  const close = PAIRED[open] ?? open;
  let depth = 0;
  for (let end = at + 1; end < code.length; end += code[end] === "\\" ? 2 : 1) {
    if (code[end] === close && depth === 0) return { body: code.slice(at + 1, end), end: end + 1 };
    if (code[end] === close) depth -= 1;
    else if (code[end] === open && close !== open) depth += 1;
  }
  return { body: code.slice(at + 1), end: code.length };
}

/**
 * The commands a program's code in `language` runs through a shell: a shell-out call given string literals, a command or
 * its words in a list, or the language's own syntax for one.
 */
function shellOuts(code: string, language: string): string[] {
  const found: string[] = [];
  const syntax = SHELL_SYNTAX[language];
  if (syntax)
    for (let match = matchAt(syntax, code, 0); match; match = matchAt(syntax, code, syntax.lastIndex)) {
      const { body, end } = delimited(code, match.index + match[0].length - (match[0] === "`" ? 1 : 0));
      found.push(body);
      syntax.lastIndex = end;
    }
  for (const call of code.matchAll(SHELL_OUT)) {
    const words: string[] = [];
    let at = call.index + call[0].length;
    const list = code[at] === "[";
    if (list) at += 1;
    for (let literal = matchAt(LITERAL, code, at); literal; literal = matchAt(LITERAL, code, at)) {
      words.push(literal[2]!);
      at = literal.index + literal[0].length;
      if (!list || code[at] !== ",") break;
      at = matchAt(COMMA, code, at)![0].length + at;
    }
    if (words.length > 0) found.push(words.join(" "));
  }
  return found;
}

/** cmd's commands, whose flags start with a slash; to any other command `/c` is a path, in Git Bash the whole C: drive. */
const SLASHED = new Set(["rd", "rmdir", "del", "erase", "cd", "chdir", "pushd"]);

const slashFlag = (word: string) => /^\/[a-z]$/i.test(word);

const targetsOf = (words: string[]) => {
  const slashed = SLASHED.has(words[0]?.toLowerCase() ?? "");
  return words.slice(1).filter((word) => !word.startsWith("-") && !(slashed && slashFlag(word)));
};

function madeBy(parts: string[]): { variables: Set<string>; paths: string[] } {
  const variables = new Set([...parts.join("\n").matchAll(MKTEMP)].map((match) => match[1]!));
  const paths = parts.flatMap((part) => {
    const words = shellWords(part);
    // A drive's root is never taken for a folder the command made.
    return words[0] === "mkdir" || words[0] === "touch" ? targetsOf(words).filter((path) => !slashFlag(path)) : [];
  });
  return { variables, paths };
}

/** Where a relative path points: where the seat runs, in scratch space, or nowhere the watch can tell. */
type At = "start" | "scratch" | "elsewhere";

const inside = (path: string) => !/^(?:[/\\~$%`]|[A-Za-z]:)/.test(path) && !CLIMBS.test(path);

/** Whether `path` is absolute and under `root`, by Windows' rules when either is spelled as Windows spells it, whatever the host. */
function under(root: string | undefined, path: string): boolean {
  if (!root) return false;
  const paths = [root, path].some((one) => /^(?:[A-Za-z]:[/\\]|\\\\)/.test(one)) ? win32 : posix;
  if (!paths.isAbsolute(path)) return false;
  const rest = paths.relative(root, path);
  return !rest.startsWith("..") && !paths.isAbsolute(rest);
}

/** Where a move to `target` from `at` lands: an absolute path under where the seat runs lands there, as a relative one stays. */
function movedTo(target: string | undefined, at: At, scratch: (path: string) => boolean, rules: Rules): At {
  if (!target) return "elsewhere";
  if (scratch(target)) return "scratch";
  if (inside(target)) return at;
  return under(rules.cwd, target) ? "start" : "elsewhere";
}

/** Git's own folder, which a copy the desk made needs to stay one; Windows' file names ignore case. */
const GIT = /^(?:\.[/\\])?\.git(?:[/\\]|$)/i;

/** Whether a path is scratch space: what the catalog names so, the machine's temporary directory, or what the same command made. */
function scratchIn(made: ReturnType<typeof madeBy>, { scratch: named, temp }: Rules) {
  const scratch = (target: string): boolean => {
    if (CLIMBS.test(target)) return false;
    const folder = DIRNAME.exec(target)?.[1];
    if (folder !== undefined) return shellWords(folder).length === 1 && scratch(shellWords(folder)[0]!);
    return (
      named.test(target) ||
      under(temp, target) ||
      made.variables.has(VARIABLE.exec(target)?.[1] ?? "") ||
      made.paths.some((path) => target === path || target.startsWith(`${path.replace(/\/$/, "")}/`))
    );
  };
  return scratch;
}

/** A command whose every address is on this machine, as a seat trying the server it built: nothing leaves. */
function onlyLocal(words: string[], rules: Pick<Rules, "localHost">): boolean {
  const addresses = words.filter((word) => /^[a-z]+:\/\//i.test(word) || rules.localHost.test(word));
  return addresses.length > 0 && addresses.every((word) => rules.localHost.test(word));
}

export function onDetail(call: Call, rules: Rules): Fact[] {
  if (call.detail.type !== "shell") return [];
  const source = str(call.detail.command);
  // Only where a secret went is quoted, never the secret.
  const secrets = new RegExp(rules.secretString.source, `${rules.secretString.flags.replace("g", "")}g`);
  const quote = (text: string, pattern?: RegExp) => around(oneLine(text.replace(secrets, "…"), Infinity), pattern, 200);
  const found: Fact[] = [];
  // "The same command" is the whole line as run, though each command in it is read on its own.
  const whole = commandDigest(source);
  try {
    // A command at a time: removing a commit message's temp file once paged a Lead.
    readAll(commandsIn(source, 0).commands, rules, { quote, whole, found }, 0, REREAD * source.length);
  } catch (error) {
    if (!(error instanceof OutOfReach)) throw error;
    // Past what the reader follows: the raw text is read too, cut where a command may end, so what it holds still pages.
    const raw = source
      .split(RAW_SEPARATORS)
      .map((text) => ({ text, unquoted: text, then: undefined, holds: [], heredocs: [] }));
    const more: Fact[] = [];
    readAll(raw, rules, { quote, whole, found: more }, DEEPEST, 0);
    found.push(...more.filter((one) => !found.some((seen) => seen.kind === one.kind)));
  }
  if (rules.secretString.test(source) && !found.some((seen) => seen.kind === "secret"))
    found.push(fact("secret", `a string shaped like a secret in ${quote(source)}`, whole));
  return found;
}

function readAll(
  commands: Command[],
  rules: Rules,
  line: Pick<Reading, "quote" | "whole" | "found">,
  depth: number,
  budget: number,
): void {
  const scratch = scratchIn(madeBy(commands.map((command) => command.text)), rules);
  read(commands, "start", { ...line, rules, scratch, budget }, depth);
}

type Reading = {
  rules: Rules;
  scratch: (path: string) => boolean;
  quote: (text: string, pattern?: RegExp) => string;
  whole: string;
  found: Fact[];
  budget: number;
};

/**
 * Reads each command as the shell runs it, starting `at` a place, and then what it runs besides: its `$(…)`, a heredoc a
 * shell reads or expands, code it hands a shell, and commands an interpreter's code shells out to.
 */
function read(commands: Command[], at: At, reading: Reading, depth: number): void {
  const { rules, scratch, quote, whole, found } = reading;
  for (const command of commands) {
    let { text, unquoted } = command;
    let words = shellWords(text);
    let moved = 0;
    if (MOVES.has(words[0]?.toLowerCase() ?? "")) {
      const to = movedTo(targetsOf(words)[0], at, scratch, rules);
      // Only `&&` says the cd took: after any other separator the next command may run where the seat was.
      at = command.then === "&&" || to === at ? to : "elsewhere";
      moved = MOVE.exec(text)?.[0].length ?? 0;
      text = text.slice(moved);
      unquoted = unquoted.slice(moved);
      words = shellWords(text);
    }
    const programs = pipeline(text, unquoted);
    const quoted = quote(text);
    if (touchesSecret(shellTokens(text), unquoted, rules)) found.push(fact("secret", quoted, whole));
    if ((rules.boundary.test(unquoted) && !onlyLocal(words, rules)) || runsOutside(programs, rules, scratch))
      found.push(fact("boundary", quoted, whole));
    if (rules.dependencyInstall.test(unquoted)) found.push(fact("dependency", quoted));
    if (skipsHooks(words) || rules.guardCommand.test(unquoted) || writesGuard(words, rules))
      found.push(fact("guard", quoted, whole));
    const targets = targetsOf(words);
    // In a copy the desk made for this seat alone, what it removes there is its own; throwing work away with git still pages.
    const removesOwn =
      REMOVES.has(words[0]?.toLowerCase() ?? "") &&
      targets.length > 0 &&
      targets.every(
        (target) =>
          scratch(target) ||
          (inside(target) && (at === "scratch" || (at === "start" && rules.ownCopy === true && !GIT.test(target)))),
      );
    if (rules.destructive.test(unquoted) && !removesOwn && !found.some((seen) => seen.kind === "destructive"))
      found.push(fact("destructive", quote(text, rules.destructive), whole));
    if (depth >= DEEPEST) continue;
    const inner = (source: string) => {
      reading.budget -= source.length;
      if (reading.budget < 0) throw new OutOfReach(`code handed on past ${REREAD} times the command`);
      read(commandsIn(source, depth + 1).commands, at, reading, depth + 1);
    };
    read(command.holds, at, reading, depth + 1);
    const feeds = command.heredocs.length > 0 ? fedBy(programs, rules) : [];
    let program = 0;
    for (const heredoc of command.heredocs) {
      while ((programs[program + 1]?.start ?? Infinity) <= heredoc.at - moved) program += 1;
      const { shell, interpreter } = feeds[program]!;
      if (shell) inner(heredoc.body);
      else {
        if (heredoc.expands) read(expanded(heredoc.body, depth + 1), at, reading, depth + 1);
        if (interpreter !== undefined) shellOuts(heredoc.body, interpreter).forEach(inner);
      }
    }
    const handed = wrapped(words);
    if (handed !== undefined) inner(handed);
    for (const { words: program } of programs) {
      const code = rules.interpreter.test(program[0] ?? "") ? scriptOf(program).code : undefined;
      if (code !== undefined) shellOuts(program[code] ?? "", programOf(program[0])).forEach(inner);
    }
  }
}

/** For each program of a pipeline, whether what it is fed reaches a shell, or which interpreter reading stdin, there or after it. */
function fedBy(programs: Program[], rules: Rules): { shell: boolean; interpreter?: string }[] {
  const feeds = programs.map(({ words }) => {
    const reads = stdin(scriptOf(words));
    return {
      shell: reads && SHELLS.has(programOf(words[0])),
      interpreter: reads && rules.interpreter.test(words[0] ?? "") ? programOf(words[0]) : undefined,
    };
  });
  for (let index = feeds.length - 2; index >= 0; index--) {
    feeds[index]!.shell ||= feeds[index + 1]!.shell;
    feeds[index]!.interpreter ??= feeds[index + 1]!.interpreter;
  }
  return feeds;
}

/** A commit or push told to skip its hooks: `--no-verify`, or a commit's `-n` in any cluster of short flags. */
function skipsHooks(words: string[]): boolean {
  if (words[0] !== "git") return false;
  const rest = words.slice(gitVerb(words));
  const verb = rest[0];
  if (verb !== "commit" && verb !== "push") return false;
  return rest.some((word) => word === "--no-verify" || (verb === "commit" && /^-[a-zA-Z]*n[a-zA-Z]*$/.test(word)));
}

/** git's options before its subcommand that take a value in the next word. */
const GIT_VALUED = /^(?:-C|-c|--git-dir|--work-tree|--namespace|--exec-path|--config-env|--super-prefix)$/;

/** Where git's subcommand is among `words`, past git's own options. */
function gitVerb(words: string[]): number {
  let at = 1;
  while (words[at]?.startsWith("-")) at += GIT_VALUED.test(words[at]!) ? 2 : 1;
  return at;
}

/** git's subcommands whose `-m` is a message; to `log` or `show` it diffs merges, which `-p` prints. */
const MESSAGED = new Set(["commit", "tag", "merge", "notes", "stash"]);

/** A command that writes, moves or removes a file that fences a seat: by a redirect, or as a program that changes files. */
function writesGuard(words: string[], rules: Rules): boolean {
  const paths = words.slice(1).map((word) => word.replace(/^>+/, ""));
  if (!paths.some((path) => rules.guardPath.test(path))) return false;
  return words.some((word) => word.startsWith(">")) || WRITERS.has(words[0]?.toLowerCase() ?? "");
}

const WRITERS = new Set([
  "cp",
  "mv",
  "tee",
  "sed",
  "rm",
  "ln",
  "chmod",
  "truncate",
  "remove-item",
  "ri",
  "set-content",
]);

/** A script run by its interpreter from a path outside the seat's copy and outside scratch space: named, or `cat` piped in. */
function runsOutside(programs: Program[], rules: Rules, scratch: (path: string) => boolean): boolean {
  return programs.some(({ words }, index) => {
    if (!rules.interpreter.test(words[0] ?? "")) return false;
    const script = scriptOf(words);
    if (script.code !== undefined) return false;
    const fed = programs[index - 1]?.words;
    const paths = script.path === undefined ? (fed?.[0] === "cat" ? targetsOf(fed) : []) : [script.path];
    return paths.some((path) => {
      if (scratch(path) || inside(path)) return false;
      return !under(rules.cwd, path.replace(/^(?:~|\$\{?HOME\}?)(?=\/)/, "/home"));
    });
  });
}

/** Builtins that read no file, whatever their words name, and another language's declarations, which no shell runs. */
const READS_NONE = new Set([
  "const",
  "var",
  "rm",
  "remove-item",
  "ri",
  "return",
  "exit",
  "break",
  "continue",
  "local",
  "declare",
  "typeset",
  "readonly",
  "shift",
  "true",
  "false",
  ":",
]);

/** A command that reads, prints, dumps or stages a secret: a secret path among what it reads, or a command that shows secrets. */
function touchesSecret(tokens: Word[], part: string, rules: Rules): boolean {
  const words = tokens.flatMap(expansions);
  const command = words[0]?.word.toLowerCase() ?? "";
  if (rules.secretCommand.test(part.trim())) return true;
  // A `)` that closes nothing is a syntax error: the shell runs nothing of the line.
  if (READS_NONE.has(command) || /^[^(]*\)/.test(command)) return false;
  // What cp and mv write to is not read, nor is a message given to git's `-m`.
  const read = command === "cp" || command === "mv" ? words.slice(1, -1) : words.slice(1);
  const verb = command === "git" ? words[gitVerb(words.map(({ word }) => word))]?.word : undefined;
  const messaged = MESSAGED.has(verb ?? "");
  // git globs a pathspec itself, quoted or not; `git grep`'s pattern is none.
  const pathspecs = verb !== undefined && verb !== "grep";
  const message = (word: string, index: number) =>
    messaged && (/^(?:-m|--message)$/.test(read[index - 1]?.word ?? "") || /^(?:-m.|--message=)/.test(word));
  return read.some((one, index) => {
    if (message(one.word, index)) return false;
    const glob = pathspecs ? { word: one.word, bare: one.word } : one;
    return secretFile(globbed(glob), rules) || globsSecret(glob.word, glob.bare, rules, !pathspecs);
  });
}

/** A word with each `?` the shell globs as a character it may match: a quoted `?.` stays optional chaining, which no file is named. */
const globbed = ({ word, bare }: Word) => word.replace(/\?/g, (mark, at: number) => (bare[at] === "?" ? "_" : mark));

/** How many words one word's braces may expand to before it is read as it is. */
const MOST_EXPANDED = 64;

/** The words a word's unquoted braces expand to, as `id_{rsa,ed25519}` names both files; `${…}` is a variable's. */
function expansions(token: Word): Word[] {
  const done: Word[] = [];
  const waiting = [token];
  for (let one = waiting.pop(); one; one = waiting.pop()) {
    const brace = innermostBrace(one.bare);
    if (!brace || done.length + waiting.length + brace.commas.length + 1 > MOST_EXPANDED) {
      done.push(one);
      continue;
    }
    const cuts = [brace.open, ...brace.commas, brace.close];
    for (let alternative = cuts.length - 2; alternative >= 0; alternative--) {
      const [from, to] = [cuts[alternative]! + 1, cuts[alternative + 1]!];
      const join = (text: string) => text.slice(0, brace.open) + text.slice(from, to) + text.slice(brace.close + 1);
      waiting.push({ word: join(one.word), bare: join(one.bare) });
    }
  }
  return done;
}

/** The first brace with no brace inside it and a comma of its own, in one pass: where it opens, its commas, where it closes. */
function innermostBrace(bare: string): { open: number; commas: number[]; close: number } | undefined {
  let open = -1;
  let commas: number[] = [];
  for (let at = 0; at < bare.length; at++) {
    const char = bare[at];
    if (char === "{" && bare[at - 1] !== "$") [open, commas] = [at, []];
    else if (char === "," && open >= 0) commas.push(at);
    else if (char === "}" && open >= 0) {
      if (commas.length > 0) return { open, commas, close: at };
      open = -1;
    }
  }
  return undefined;
}

/** Cuts around the match, not from the front: what makes a long command irreversible is often at its end. */
function around(text: string, pattern: RegExp | undefined, limit: number): string {
  if (text.length <= limit) return text;
  const found = pattern ? new RegExp(pattern.source, pattern.flags.replace("g", "")).exec(text) : null;
  const start =
    found && found.index + found[0].length > limit
      ? Math.max(0, Math.min(found.index - Math.floor(limit / 4), text.length - limit))
      : 0;
  const body = within(text.slice(start).replace(/^[\uDC00-\uDFFF]/, ""), limit);
  return `${start > 0 ? "…" : ""}${body}${start + body.length < text.length ? "…" : ""}`;
}
