import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { daemonLog } from "./logger.ts";

const LISTING_BYTES = 256 * 1024 * 1024;
const LISTING_MS = 20_000;

/** Reads a process's environment block out of its PEB, so a process is found by what it inherited, as on the other systems, and ends it through the handle it read, so a pid reused since is never the one ended. */
const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class EnvBlock {
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr handle, uint code);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr handle, IntPtr address, byte[] buffer, IntPtr size, out IntPtr read);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr handle, int cls, IntPtr info, int length, out int returned);
  static byte[] Read(IntPtr handle, long address, int size) {
    var buffer = new byte[size]; IntPtr read;
    return ReadProcessMemory(handle, new IntPtr(address), buffer, new IntPtr(size), out read) && read.ToInt64() == size ? buffer : null;
  }
  static string Of(IntPtr handle) {
    IntPtr info = Marshal.AllocHGlobal(48);
    try {
      int returned;
      if (NtQueryInformationProcess(handle, 0, info, 48, out returned) != 0) return null;
      long peb = Marshal.ReadIntPtr(info, 8).ToInt64();
      if (peb == 0) return null;
      byte[] parameters = Read(handle, peb + 0x20, 8);
      if (parameters == null) return null;
      long block = BitConverter.ToInt64(parameters, 0);
      byte[] at = Read(handle, block + 0x80, 8);
      byte[] size = Read(handle, block + 0x3F0, 8);
      if (at == null || size == null) return null;
      long length = Math.Min(BitConverter.ToInt64(size, 0), 4L * 1024 * 1024);
      byte[] bytes = Read(handle, BitConverter.ToInt64(at, 0), (int)length);
      return bytes == null ? null : Encoding.Unicode.GetString(bytes);
    } finally { Marshal.FreeHGlobal(info); }
  }
  public static bool Stop(int pid, string[] entries) {
    IntPtr handle = OpenProcess(0x0411, false, pid);
    if (handle == IntPtr.Zero) return false;
    try {
      string block = Of(handle);
      if (block == null) return false;
      foreach (string line in block.Split((char)0)) if (Array.IndexOf(entries, line) >= 0) return TerminateProcess(handle, 1);
      return false;
    } finally { CloseHandle(handle); }
  }
}
'@
[string[]]$entries = @($env:SWEEP_VALUES -split ',' | ForEach-Object { $env:SWEEP_NAME + '=' + $_ })
$spare = @($env:SWEEP_SPARE -split ',' | ForEach-Object { [int]$_ })
foreach ($process in Get-Process) {
  if ($process.Id -eq $PID -or $spare -contains $process.Id) { continue }
  try { if ([EnvBlock]::Stop($process.Id, $entries)) { $process.Id } } catch { }
}
`;

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

async function onLinux(entries: Set<string>, signal: AbortSignal): Promise<number[]> {
  const found: number[] = [];
  for (const name of await readdir("/proc")) {
    signal.throwIfAborted();
    if (!/^\d+$/.test(name)) continue;
    // A process of another user, or one gone since the listing, has no environment to read.
    const environ = await readFile(`/proc/${name}/environ`, "latin1").catch(() => "");
    if (environ.split("\0").some((line) => entries.has(line))) found.push(Number(name));
  }
  return found;
}

/** macOS pids never pass this. */
const MAC_PID_MAX = 99_999;

/**
 * Finds the marked processes by reading each one's environment NUL-separated from the kernel (`sysctl` KERN_PROCARGS2,
 * called through perl, which ships with macOS), because `ps -E` joins entries with spaces and a value holding
 * ` NAME=value ` cannot be told from the entry itself. The kernel shows the environment of no restricted process
 * (/bin/sleep, the shells, tail, perl), to any reader, root included, so a marked one is found by what it is to a
 * process that is read: its descendants, and what shares its session unless that is the sweeper's or the daemon's own.
 * A process the kernel does show an environment of is judged by its own entries alone, one with no entries included (its
 * buffer goes on past the arguments, where a restricted one's ends): only the unreadable are taken in, by descent, and by
 * session where the session's leader is itself marked or taken and every readable member carries a swept mark, since a
 * session an old daemon left holds live seats' and the Human's processes too.
 * Never stopped, listed or walked through are the spared pids and the processes above them (the sweeper's own chain up
 * to launchd), since a marked one above the daemon would otherwise take every sibling of the plugin with it.
 * A restricted process left alone by a parent that is gone, in a session of its own, still escapes.
 * The buffer is `kern.argmax` long, as a longer one is refused. 202 is `__sysctl` and 310 `getsid`; KERN_PROC_PID's
 * kinfo_proc holds the parent pid at byte 560. A process of another user, or one gone, refuses and is skipped.
 */
const MAC_SCRIPT = String.raw`
my $name = $ENV{SWEEP_NAME};
my %spare = map { $_ => 1 } split /,/, $ENV{SWEEP_SPARE};
my %entries = map { ("$name=$_" => 1) } split /,/, $ENV{SWEEP_VALUES};
$spare{$$} = 1;
my $max = pack("l", 0);
my $maxSize = pack("Q", 4);
my $argmax = pack("i2", 1, 8);
syscall(202, $argmax, 2, $max, $maxSize, 0, 0) == 0 or die "no argmax\n";
my $buffer = "\0" x unpack("l", $max);
my $info = "\0" x 1024;
my (%parent, %session, %marked, %readable);
for my $pid (1 .. ${MAC_PID_MAX}) {
  my $infoSize = pack("Q", length $info);
  next if syscall(202, pack("i4", 1, 14, 1, $pid), 4, $info, $infoSize, 0, 0) != 0 || unpack("Q", $infoSize) < 564;
  $parent{$pid} = unpack("l", substr($info, 560, 4));
  $session{$pid} = syscall(310, $pid);
  next if $spare{$pid};
  my $size = pack("Q", length $buffer);
  next if syscall(202, pack("i3", 1, 49, $pid), 3, $buffer, $size, 0, 0) != 0;
  my $end = unpack("Q", $size);
  my $at = index($buffer, "\0", 4);
  next if $at < 0 || $at >= $end;
  $at++ while $at < $end && substr($buffer, $at, 1) eq "\0";
  for (1 .. unpack("l", substr($buffer, 0, 4))) {
    last if $at >= $end;
    $at = index($buffer, "\0", $at) + 1;
  }
  next if $at >= $end;
  $readable{$pid} = 1;
  while ($at < $end) {
    my $stop = index($buffer, "\0", $at);
    last if $stop < 0 || $stop == $at;
    if ($entries{substr($buffer, $at, $stop - $at)}) { $marked{$pid} = 1; last; }
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
my %stop = %marked;
my @queue = keys %marked;
while (defined(my $pid = shift @queue)) {
  for my $child (@{ $children{$pid} || [] }) {
    next if $stop{$child} || $safe{$child} || $unmarked{$child};
    $stop{$child} = 1;
    push @queue, $child;
  }
}
my %own = map { $_ => 1 } grep { $_ > 1 } map { $session{$_} // 0 } keys %spare;
my %shared = map { $_ => 1 } grep { $_ > 1 && !$own{$_} && $stop{$_} } map { $session{$_} } keys %marked;
delete $shared{$session{$_}} for keys %unmarked;
for my $pid (keys %parent) {
  $stop{$pid} = 1 if $shared{$session{$pid}} && !$readable{$pid};
}
print "$_\n" for grep { !$safe{$_} } sort { $a <=> $b } keys %stop;
`;

function pids(listing: string): number[] {
  return listing.split(/\s+/).flatMap((word) => (/^\d+$/.test(word) ? [Number(word)] : []));
}

async function onMac(name: string, values: string[], spare: number[], signal: AbortSignal): Promise<number[]> {
  return pids(await run("perl", ["-e", MAC_SCRIPT], sweepEnv(name, values, spare), signal));
}

function sweepEnv(name: string, values: string[], spare: number[]): NodeJS.ProcessEnv {
  return { ...process.env, SWEEP_NAME: name, SWEEP_VALUES: values.join(","), SWEEP_SPARE: spare.join(",") };
}

async function onWindows(name: string, values: string[], spare: number[], signal: AbortSignal): Promise<number[]> {
  const encoded = Buffer.from(WINDOWS_SCRIPT, "utf16le").toString("base64");
  const listing = await run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    sweepEnv(name, values, spare),
    signal,
  );
  return pids(listing);
}

function gone(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ESRCH";
}

/**
 * Stops every process, whatever started or orphaned it, whose environment carries `name=` and one of `values` (none
 * holding a comma), never this one nor its parent, the daemon; returns the pids stopped. One listing serves them all.
 * A value the plugin's own environment carries is skipped: everything the daemon started inherited it, and not all of
 * that is a seat's.
 */
export async function stopMarked(name: string, asked: string[], signal: AbortSignal): Promise<number[]> {
  const values = asked.filter((value) => value !== process.env[name]);
  if (values.length < asked.length)
    daemonLog.info(`left alone what carries ${name}=${process.env[name]}: the daemon's own`);
  if (values.length === 0) return [];
  const spare = [process.pid, process.ppid];
  const found =
    process.platform === "win32"
      ? await onWindows(name, values, spare, signal)
      : process.platform === "darwin"
        ? await onMac(name, values, spare, signal)
        : await onLinux(new Set(values.map((value) => `${name}=${value}`)), signal);
  const stopped: number[] = [];
  for (const pid of found.filter((pid) => !spare.includes(pid))) {
    if (signal.aborted) break;
    try {
      process.kill(pid, "SIGKILL");
      stopped.push(pid);
    } catch (error) {
      // Gone between the listing and the kill is what was wanted.
      if (!gone(error)) daemonLog.error(`could not stop process ${pid} carrying ${name}:`, error);
    }
  }
  return stopped;
}
