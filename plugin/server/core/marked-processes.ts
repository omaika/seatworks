import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { daemonLog } from "./logger.ts";

const LISTING_BYTES = 256 * 1024 * 1024;
const LISTING_MS = 20_000;

export type Marked = { pid: number; command: string };

function run(file: string, args: string[], env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { env, signal, timeout: LISTING_MS, maxBuffer: LISTING_BYTES, windowsHide: true },
      (error, stdout) => {
        if (error) reject(new Error(`${file} could not list processes`, { cause: error }));
        else resolve(stdout);
      },
    );
  });
}

async function onLinux(entry: string, spare: number[], signal: AbortSignal): Promise<Marked[]> {
  const found: Marked[] = [];
  for (const name of await readdir("/proc")) {
    signal.throwIfAborted();
    if (!/^\d+$/.test(name) || spare.includes(Number(name))) continue;
    // A process of another user, or one gone since the listing, has no environment to read.
    const environ = await readFile(`/proc/${name}/environ`, "latin1").catch(() => "");
    if (!environ.split("\0").includes(entry)) continue;
    const cmdline = await readFile(`/proc/${name}/cmdline`, "utf8").catch(() => "");
    found.push({ pid: Number(name), command: cmdline.split("\0").join(" ").trim() });
  }
  return found;
}

/** macOS pids never pass this. */
const MAC_PID_MAX = 99_999;

/**
 * Finds the marked processes by reading each one's environment NUL-separated from the kernel (`sysctl` KERN_PROCARGS2,
 * called through perl, which ships with macOS), because `ps -E` joins entries with spaces and a value holding
 * ` NAME=value ` cannot be told from the entry itself. The kernel shows the environment of no restricted process
 * (/bin/sleep, the shells, tail, perl), to any reader, root included, so such a process is found by descent from a
 * marked one. A process the kernel does show an environment of is judged by its own entries alone, one with no entries
 * included (its buffer goes on past the arguments, where a restricted one's ends). A command line is its arguments where
 * the kernel shows them, else the 16 characters of its name at byte 243 of kinfo_proc.
 * Never listed or walked through are the spared pids and the processes above them (the finder's own chain up to launchd),
 * since a marked one above the daemon would otherwise name the daemon's own tree.
 * A restricted process left alone by a parent that is gone still escapes.
 * The buffer is `kern.argmax` long, as a longer one is refused. 202 is `__sysctl`; KERN_PROC_PID's kinfo_proc holds the
 * parent pid at byte 560. A process of another user, or one gone, refuses and is skipped.
 */
const MAC_SCRIPT = String.raw`
my $entry = $ENV{FIND_ENTRY};
my %spare = map { $_ => 1 } split /,/, $ENV{FIND_SPARE};
$spare{$$} = 1;
my $max = pack("l", 0);
my $maxSize = pack("Q", 4);
my $argmax = pack("i2", 1, 8);
syscall(202, $argmax, 2, $max, $maxSize, 0, 0) == 0 or die "no argmax\n";
my $buffer = "\0" x unpack("l", $max);
my $info = "\0" x 1024;
my (%parent, %marked, %readable, %command);
for my $pid (1 .. ${MAC_PID_MAX}) {
  my $infoSize = pack("Q", length $info);
  next if syscall(202, pack("i4", 1, 14, 1, $pid), 4, $info, $infoSize, 0, 0) != 0 || unpack("Q", $infoSize) < 564;
  $parent{$pid} = unpack("l", substr($info, 560, 4));
  $command{$pid} = unpack("Z17", substr($info, 243, 17));
  next if $spare{$pid};
  my $size = pack("Q", length $buffer);
  next if syscall(202, pack("i3", 1, 49, $pid), 3, $buffer, $size, 0, 0) != 0;
  my $end = unpack("Q", $size);
  my $at = index($buffer, "\0", 4);
  next if $at < 0 || $at >= $end;
  $at++ while $at < $end && substr($buffer, $at, 1) eq "\0";
  my @argv;
  for (1 .. unpack("l", substr($buffer, 0, 4))) {
    last if $at >= $end;
    my $stop = index($buffer, "\0", $at);
    push @argv, substr($buffer, $at, $stop - $at);
    $at = $stop + 1;
  }
  next if $at >= $end;
  $command{$pid} = join(" ", @argv) if @argv;
  $readable{$pid} = 1;
  while ($at < $end) {
    my $stop = index($buffer, "\0", $at);
    last if $stop < 0 || $stop == $at;
    if (substr($buffer, $at, $stop - $at) eq $entry) { $marked{$pid} = 1; last; }
    $at = $stop + 1;
  }
}
my %safe = (1 => 1);
for my $start (keys %spare) {
  for (my $up = $start; $up > 1 && !$safe{$up}; $up = $parent{$up} // 0) { $safe{$up} = 1; }
}
delete $marked{$_} for keys %safe;
my %unmarked = map { $_ => 1 } grep { $readable{$_} && !$marked{$_} } keys %parent;
my %children;
push @{ $children{$parent{$_}} }, $_ for keys %parent;
my %found = %marked;
my @queue = keys %marked;
while (defined(my $pid = shift @queue)) {
  for my $child (@{ $children{$pid} || [] }) {
    next if $found{$child} || $safe{$child} || $unmarked{$child};
    $found{$child} = 1;
    push @queue, $child;
  }
}
print "$_\t$command{$_}\n" for sort { $a <=> $b } keys %found;
`;

async function onMac(entry: string, spare: number[], signal: AbortSignal): Promise<Marked[]> {
  const env = { ...process.env, FIND_ENTRY: entry, FIND_SPARE: spare.join(",") };
  return (await run("perl", ["-e", MAC_SCRIPT], env, signal)).split("\n").flatMap((line) => {
    const [pid, command] = line.split("\t");
    return pid ? [{ pid: Number(pid), command: command ?? "" }] : [];
  });
}

/**
 * Lists the processes, whatever started or orphaned them, whose environment carries the entry `name=value`, never this
 * one nor its parent, the daemon; on macOS also what descends from them. Nothing is stopped. Windows lists none: it
 * shows no simple, documented way to read another process's environment.
 * A value the plugin's own environment carries is skipped: everything the daemon started inherited it.
 */
export async function findMarked(name: string, value: string, signal: AbortSignal): Promise<Marked[]> {
  if (value === process.env[name]) {
    daemonLog.info(`left alone what carries ${name}=${value}: the daemon's own`);
    return [];
  }
  const spare = [process.pid, process.ppid];
  const entry = `${name}=${value}`;
  if (process.platform === "win32") return [];
  const found = process.platform === "darwin" ? await onMac(entry, spare, signal) : await onLinux(entry, spare, signal);
  return found.filter(({ pid }) => !spare.includes(pid));
}
