import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Something that is not a link stands where one should go: it is left alone, since deleting it would lose what it holds. */
export class LeftAlone extends Error {}

/** The first folder under `root` that `path` lies in, however this platform separates folders; none when it lies outside. */
export function firstUnder(root: string, path: string): string | undefined {
  const rest = relative(root, path);
  return rest && rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest) ? rest.split(sep)[0] : undefined;
}

/**
 * Whether what is at `path` is a link, so removing it loses nothing: a symlink, or on Windows a file carrying another name,
 * which stands there for the symlink to a file an ordinary account cannot make and which `keptName` keeps true.
 */
export function isLink(path: string): boolean {
  try {
    const at = lstatSync(path);
    return at.isSymbolicLink() || (process.platform === "win32" && at.isFile() && at.nlink > 1);
  } catch {
    return false;
  }
}

/** Whether anything is at `path`, a dangling link included. */
export function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Windows spells a link's target back its own way — long form, backslashed, in its own case — so compare where each lands. */
function samePath(a: string, b: string): boolean {
  const lands = (path: string): string => {
    try {
      return realpathSync(path);
    } catch {
      // Nothing there to canonicalise, so what the link says stands for where it lands.
      return resolve(path);
    }
  };
  const [one, two] = [lands(a), lands(b)];
  return process.platform === "win32" ? one.toLowerCase() === two.toLowerCase() : one === two;
}

/**
 * How this platform links to `target`: an ordinary Windows account, with neither Developer Mode nor elevation, may point a
 * junction at a directory but may make no symlink to a file at all, so a file is given a second name on its own volume.
 */
function linkKind(target: string): "symlink" | "junction" | "hard" {
  if (process.platform !== "win32") return "symlink";
  return statSync(target).isDirectory() ? "junction" : "hard";
}

/**
 * A name of its own that the desk keeps for every file it links. Rewriting the target by rename takes the link's name off the
 * file, and what is left then looks exactly like a file the harness wrote itself; this name is how the two are told apart.
 */
function keptName(path: string): string {
  return join(dirname(path), ".linked", basename(path));
}

/** The link to `target` this platform lets an ordinary account make; the folder holding `path` must be there already. */
export function makeLink(path: string, target: string): void {
  const kind = linkKind(target);
  if (kind !== "hard") {
    symlinkSync(target, path, kind === "junction" ? "junction" : undefined);
    return;
  }
  const kept = keptName(path);
  try {
    mkdirSync(dirname(kept), { recursive: true });
    rmSync(kept, { force: true });
    // The desk's own name first: a failure then leaves only that, which the next build takes away in any case.
    linkSync(target, kept);
    linkSync(target, path);
  } catch (error) {
    throw new Error(
      `${path} could not be made a second name for ${target}, which is how a file is shared where no symlink to one may be made: both names must lie on one volume`,
      { cause: error },
    );
  }
}

/** Forgets the desk's name for a link at `path`: it explains that link alone, so it never outlives it. */
export function forgetLink(path: string): void {
  rmSync(keptName(path), { force: true });
}

/** Takes a link away, with the name the desk keeps beside it. */
export function removeLink(path: string): void {
  unlinkSync(path);
  forgetLink(path);
}

/** Whether the link at `path` already leads to `target`. */
function leadsTo(path: string, target: string): boolean {
  if (linkKind(target) !== "hard") return samePath(readlinkSync(path), target);
  const [at, to] = [statSync(path, { bigint: true }), statSync(target, { bigint: true })];
  return at.ino === to.ino && at.dev === to.dev;
}

/** Points `path` at `target`; false when it already did. Throws LeftAlone over anything else at `path`. */
export function ensureLink(path: string, target: string): boolean {
  if (isLink(path)) {
    if (leadsTo(path, target)) return false;
    removeLink(path);
  } else if (present(path)) {
    // Whatever stands here is its owner's, not the desk's link, so the name kept for that link would be the last one
    // holding a file both sides have since replaced.
    forgetLink(path);
    throw new LeftAlone(`${path} exists and is not a link, so it was left alone`);
  }
  mkdirSync(dirname(path), { recursive: true });
  makeLink(path, target);
  return true;
}

export function writeIfChanged(path: string, text: string): boolean {
  if (isLink(path)) unlinkSync(path);
  forgetLink(path);
  if (present(path) && readFileSync(path, "utf-8") === text) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return true;
}

/** A short hash of every file under each source, in order: the same content hashes the same wherever it lies. */
export function digest(sources: string[]): string {
  const hash = createHash("sha256");
  for (const [index, source] of sources.entries()) {
    if (!existsSync(source)) continue;
    const files = statSync(source).isDirectory()
      ? readdirSync(source, { recursive: true })
          .map(String)
          .filter((file) => statSync(join(source, file)).isFile())
          .sort()
      : [""];
    for (const file of files)
      hash
        .update(`${index}/${file}\0`)
        .update(readFileSync(join(source, file)))
        .update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}
