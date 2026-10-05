import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadKit } from "../../server/catalog/kit/kit.ts";
import { seatBin } from "../../server/catalog/seat/seat-bin.ts";
import { tempDir } from "../tempdir.ts";

const PLUGIN = fileURLToPath(new URL("../..", import.meta.url));

test("probe: which git each Git Bash finds", { skip: process.platform !== "win32" }, (t) => {
  const dir = seatBin(loadKit(PLUGIN), tempDir("sw2-probe-"))!;
  const where = execFileSync("where", ["git", "bash", "sh"], { encoding: "utf-8" });
  t.diagnostic(`where: ${where}`);
  const gitExe = where.split(/\r?\n/).find((line) => /\\cmd\\git\.exe$/i.test(line))!;
  const top = dirname(dirname(gitExe));
  t.diagnostic(`top ${top}; usr/bin git? ${existsSync(join(top, "usr", "bin", "git.exe"))}`);
  t.diagnostic(`bin: ${readdirSync(join(top, "bin")).join(" ")}`);
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^path$/i.test(name)) delete env[name];
  env.PATH = `${dir}${delimiter}${process.env.PATH ?? ""}`;
  t.diagnostic(`MSYSTEM in env: ${process.env.MSYSTEM ?? "(unset)"}`);
  const noMsys = { ...env };
  delete noMsys.MSYSTEM;
  const script = 'command -v git; type -a git | head -3; echo "MSYSTEM=$MSYSTEM"; echo "PATH=$PATH" | cut -c1-400';
  for (const shell of [join(top, "bin", "bash.exe"), join(top, "bin", "sh.exe"), join(top, "usr", "bin", "bash.exe")])
    for (const flags of [["-c"], ["-l", "-c"], ["-c", "-l"]])
      for (const [label, e] of [
        ["env", env],
        ["noMSYSTEM", noMsys],
      ] as const) {
        const ran = spawnSync(shell, [...flags, script], { env: e, encoding: "utf-8" });
        t.diagnostic(
          `== ${shell} ${flags.join(" ")} ${label}: status ${ran.status}\n${ran.stdout}\n${ran.stderr.slice(0, 300)}`,
        );
      }
  const bashEnv = join(tempDir("sw2-probe-env-"), "env.sh");
  writeFileSync(bashEnv, `PATH="$(cygpath -u '${dir}'):$PATH"\n`);
  const ran = spawnSync(join(top, "bin", "bash.exe"), ["-c", "command -v git"], {
    env: { ...env, BASH_ENV: bashEnv },
    encoding: "utf-8",
  });
  t.diagnostic(`== BASH_ENV: ${ran.status} ${ran.stdout} ${ran.stderr}`);
});
