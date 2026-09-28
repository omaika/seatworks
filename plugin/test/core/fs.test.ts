import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  readdirSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { test } from "node:test";
import { writeConfigAtomic } from "../../server/core/config-file.ts";
import { LeftAlone, ensureLink, isLink, makeLink, present, writeIfChanged } from "../../server/core/fs.ts";
import { stateRoot } from "../../server/core/paths.ts";
import { tempDir } from "../tempdir.ts";

/** What Windows lets reach `path`, read through PowerShell because Node can neither read an access list nor write one. */
function accessList(path: string): { own: boolean; added: string[] } {
  const sddl = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", `(Get-Acl -LiteralPath '${path}').Sddl`],
    { encoding: "utf-8" },
  ).trim();
  // O:...G:...D:<flags><entries>S:..., each entry a bracketed row whose second field holds its flags, ID marking one inherited.
  const dacl = /D:([A-Z]*)((?:\([^)]*\))*)/.exec(sddl);
  assert.ok(dacl, `${path} has no access list of its own to read: ${sddl}`);
  const rows = [...dacl[2]!.matchAll(/\(([^)]*)\)/g)].map((row) => row[1]!);
  return { own: dacl[1]!.includes("P"), added: rows.filter((row) => !(row.split(";")[1] ?? "").includes("ID")) };
}

test("a link is retargeted once, to a directory and to a file alike, and the same target however spelled is left as it is", () => {
  const root = tempDir("sw2-link-");
  const [one, two] = [join(root, "one"), join(root, "two")];
  for (const [dir, text] of [
    [one, "one"],
    [two, "two"],
  ] as const) {
    mkdirSync(dir);
    writeFileSync(join(dir, "in"), text);
  }
  // A second way to name everything under root, so a target can be spelled unlike the text the link stores.
  const alias = join(root, "alias");
  symlinkSync(root, alias);
  const toDir = join(root, "where", "dir");
  assert.equal(ensureLink(toDir, one), true, "a folder that is not there yet is made for the link");
  assert.equal(readFileSync(join(toDir, "in"), "utf-8"), "one");
  assert.equal(ensureLink(toDir, one), false, "the same target again is no retarget");
  assert.equal(ensureLink(toDir, `${one}${sep}`), false, "nor is the same target spelled with a separator on the end");
  assert.equal(ensureLink(toDir, join(alias, "one")), false, "nor the same folder reached through another link");
  assert.equal(ensureLink(toDir, two), true);
  assert.equal(readFileSync(join(toDir, "in"), "utf-8"), "two", "a directory link retargeted");

  const [a, b] = [join(root, "a.json"), join(root, "b.json")];
  writeFileSync(a, "a");
  writeFileSync(b, "b");
  const toFile = join(root, "where", "file");
  assert.equal(ensureLink(toFile, a), true);
  assert.equal(readFileSync(toFile, "utf-8"), "a");
  assert.equal(ensureLink(toFile, a), false, "the same target again is no retarget");
  assert.equal(ensureLink(toFile, join(alias, "a.json")), false, "nor is the same file reached through another link");
  assert.equal(ensureLink(toFile, b), true);
  assert.equal(readFileSync(toFile, "utf-8"), "b", "a file link retargeted");
  assert.equal(readFileSync(a, "utf-8"), "a", "and what it led to before is still whole");
});

test("a link to a file is what the platform allows an account with no privilege: a symlink, or on Windows a second name for the file", () => {
  const root = tempDir("sw2-link-");
  const dir = join(root, "dir");
  mkdirSync(dir);
  const file = join(root, "file");
  writeFileSync(file, "what the owner's own agent wrote");
  const [toDir, toFile] = [join(root, "to-dir"), join(root, "to-file")];
  ensureLink(toDir, dir);
  ensureLink(toFile, file);
  assert.equal(isLink(toDir), true, "both are links to remove and remake");
  assert.equal(isLink(toFile), true);
  assert.equal(
    lstatSync(toDir).isSymbolicLink(),
    true,
    "a directory link is a reparse point on Windows, a symlink here",
  );
  if (process.platform === "win32") {
    assert.equal(lstatSync(toFile).isSymbolicLink(), false, "no file symlink is made, since that needs a privilege");
    assert.equal(statSync(toFile).nlink, 3, "the file carries the seat's name and the one the desk keeps beside it");
    assert.equal(statSync(toFile, { bigint: true }).ino, statSync(file, { bigint: true }).ino, "of the same file");
    writeFileSync(toFile, "what the seat's agent wrote");
    assert.equal(
      readFileSync(file, "utf-8"),
      "what the seat's agent wrote",
      "so a write through one name reaches both",
    );
  } else {
    assert.equal(readlinkSync(toFile), file);
  }
});

test("a file nobody linked is left where it stands, rather than a link put in its place", () => {
  const root = tempDir("sw2-link-");
  const target = join(root, "target");
  writeFileSync(target, "shared");
  const path = join(root, "own");
  writeFileSync(path, "the harness's own");
  assert.throws(() => ensureLink(path, target), LeftAlone);
  assert.equal(readFileSync(path, "utf-8"), "the harness's own");
});

test("a file that holds a key is kept by a mode on POSIX, and on Windows by the list it inherits from the user's own profile", () => {
  const path = join(stateRoot(), "settings.json");
  mkdirSync(dirname(path), { recursive: true });
  writeConfigAtomic(path, '{"provider":{}}\n');
  assert.ok(
    path.startsWith(`${homedir()}${sep}`),
    "what the plugin keeps lies under the user's own profile, which is what keeps it to them where no mode can",
  );
  if (process.platform !== "win32") {
    assert.equal(statSync(path).mode & 0o777, 0o600, "no other account may read or write it");
    return;
  }
  // libuv's chmod is the CRT's _wchmod, which moves the read-only attribute alone, and Node offers no access list of its
  // own, so what keeps these files to one account is the list they inherit. Whom that list lets in is the machine's to say.
  const list = accessList(path);
  assert.equal(list.own, false, "and the file takes that list: it does not hold one of its own against it");
  assert.deepEqual(list.added, [], "to which the plugin added nothing, so it can have widened nothing");
});

/**
 * What Windows' own mechanisms do, as far as this machine can stand in for them: a junction reads back as a symlink here,
 * and a second name for a file is the same hard link on both. Windows' privilege for a file symlink is what it cannot show.
 */
test("the Windows way of linking: a junction retargeted, a file shared by a second name, and that name made again where the target's rewrite tore it off", (t) => {
  const real = process.platform;
  t.after(() => Object.defineProperty(process, "platform", { value: real, configurable: true }));
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });

  const root = tempDir("sw2-win-");
  const [one, two] = [join(root, "one"), join(root, "two")];
  mkdirSync(one);
  mkdirSync(two);
  const toDir = join(root, "to-dir");
  assert.equal(ensureLink(toDir, one), true);
  assert.equal(ensureLink(toDir, one), false, "a junction already there is read back and left alone");
  assert.equal(ensureLink(toDir, two), true, "and retargeted when it leads elsewhere");
  assert.equal(isLink(toDir), true);

  assert.equal(
    ensureLink(toDir, join(root, "TWO")),
    false,
    "and left alone when that same folder is spelled in another case, as Windows spells one back",
  );

  const [a, b] = [join(root, "a.json"), join(root, "b.json")];
  writeFileSync(a, "a");
  writeFileSync(b, "b");
  const toFile = join(root, "to-file");
  assert.equal(ensureLink(toFile, a), true);
  assert.equal(lstatSync(toFile).isSymbolicLink(), false, "a file is shared by a second name, not by a symlink");
  assert.equal(statSync(toFile).nlink, 3, "the target, the seat's name for it, and the name the desk keeps beside it");
  assert.equal(isLink(toFile), true, "which the seat build may still remove and make again");
  assert.equal(ensureLink(toFile, a), false, "the same file again is no retarget");
  assert.equal(ensureLink(toFile, b), true, "another file is");
  assert.equal(readFileSync(a, "utf-8"), "a", "and the file it left keeps its content");

  writeFileSync(`${b}.tmp`, "refreshed");
  renameSync(`${b}.tmp`, b);
  assert.equal(readFileSync(toFile, "utf-8"), "b", "a rewrite by rename leaves the seat's name on the file as it was");
  assert.equal(
    ensureLink(toFile, b),
    true,
    "so the next build makes the link again, by the name the desk kept beside it",
  );
  assert.equal(readFileSync(toFile, "utf-8"), "refreshed", "and the seat is given what the owner's own agent wrote");
  assert.equal(statSync(toFile, { bigint: true }).ino, statSync(b, { bigint: true }).ino, "the one file once again");

  const own = join(root, "own.json");
  writeFileSync(own, "what the harness wrote for itself");
  assert.throws(() => ensureLink(own, b), LeftAlone, "while a file the desk never placed is left where it stands");
  assert.equal(readFileSync(own, "utf-8"), "what the harness wrote for itself");
});

/** Every file under `root`, wherever it lies, whose whole content is `text`. */
function holding(root: string, text: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && readFileSync(join(entry.parentPath, entry.name), "utf-8") === text)
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

test("the name the desk keeps for a link never outlives that link, so nothing is left holding a credential both sides have replaced", (t) => {
  const real = process.platform;
  t.after(() => Object.defineProperty(process, "platform", { value: real, configurable: true }));
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });

  const root = tempDir("sw2-kept-");
  const target = join(root, "auth.json");
  writeFileSync(target, "token-1");
  const seatPath = join(root, "seat", "auth.json");
  mkdirSync(dirname(seatPath), { recursive: true });
  assert.equal(ensureLink(seatPath, target), true);

  // The seat's own agent writes its file the way files are written, and so, later, does the owner's.
  writeFileSync(`${seatPath}.tmp`, "token-2");
  renameSync(`${seatPath}.tmp`, seatPath);
  writeFileSync(`${target}.tmp`, "token-3");
  renameSync(`${target}.tmp`, target);

  assert.throws(() => ensureLink(seatPath, target), LeftAlone, "what the seat wrote for itself is still left alone");
  assert.equal(readFileSync(seatPath, "utf-8"), "token-2");
  assert.deepEqual(holding(root, "token-1"), [], "and no name anywhere is left holding what both of them replaced");

  // And where the plugin lays its own file over a link's place, the kept name goes with the link it explained.
  const store = join(root, "models.json");
  const seatStore = join(root, "seat", "models.json");
  writeFileSync(store, "list-1");
  ensureLink(seatStore, store);
  writeFileSync(`${seatStore}.tmp`, "list-2");
  renameSync(`${seatStore}.tmp`, seatStore);
  writeIfChanged(seatStore, "list-3");
  assert.deepEqual(holding(root, "list-1"), [store], "only the file the owner still keeps under their own name");
});

test("a link half made is not left looking whole: the name the desk keeps goes down before the seat's own", (t) => {
  const real = process.platform;
  t.after(() => Object.defineProperty(process, "platform", { value: real, configurable: true }));
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });

  const root = tempDir("sw2-half-");
  const target = join(root, "auth.json");
  writeFileSync(target, "token");
  const seatPath = join(root, "seat", "auth.json");
  // A folder where the desk's own name has to go, so that name cannot be made and the link must not be made either.
  mkdirSync(join(root, "seat", ".linked", "auth.json"), { recursive: true });
  assert.throws(() => makeLink(seatPath, target), /could not be made a second name/);
  assert.equal(isLink(seatPath), false, "nothing that reads as the desk's link is left where the build stopped");
  assert.equal(present(seatPath), false);
});
