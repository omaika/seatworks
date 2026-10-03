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
  public static bool Stop(int pid, string entry) {
    IntPtr handle = OpenProcess(0x0411, false, pid);
    if (handle == IntPtr.Zero) return false;
    try {
      string block = Of(handle);
      return block != null && Array.IndexOf(block.Split((char)0), entry) >= 0 && TerminateProcess(handle, 1);
    } finally { CloseHandle(handle); }
  }
}
'@
$entry = $env:SWEEP_NAME + '=' + $env:SWEEP_VALUE
foreach ($process in Get-Process) {
  if ($process.Id -eq $PID -or $process.Id -eq [int]$env:SWEEP_DAEMON) { continue }
  try { if ([EnvBlock]::Stop($process.Id, $entry)) { $process.Id } } catch { }
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

async function onLinux(entry: string): Promise<number[]> {
  const found: number[] = [];
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    // A process of another user, or one gone since the listing, has no environment to read.
    const environ = await readFile(`/proc/${name}/environ`, "latin1").catch(() => "");
    if (environ.split("\0").includes(entry)) found.push(Number(name));
  }
  return found;
}

const PS_FIELDS = ["-o", "pid=,command="];

function byPid(listing: string): Map<string, string> {
  const rows = new Map<string, string>();
  for (const line of listing.split("\n")) {
    const [, pid, rest] = /^\s*(\d+)\s(.*)$/.exec(line) ?? [];
    if (pid && rest !== undefined) rows.set(pid, rest);
  }
  return rows;
}

/**
 * `ps -E` prints each command's arguments and then its environment, so the same listing without `-E` says where the
 * environment starts; a row whose arguments changed between the two listings is left alone.
 */
async function onMac(entry: string, signal: AbortSignal): Promise<number[]> {
  const [withEnv, commands] = await Promise.all([
    run("ps", ["-axwwE", ...PS_FIELDS], process.env, signal),
    run("ps", ["-axww", ...PS_FIELDS], process.env, signal),
  ]);
  const argv = byPid(commands);
  return [...byPid(withEnv)].flatMap(([pid, line]) => {
    const command = argv.get(pid);
    return command !== undefined && line.startsWith(command) && line.slice(command.length).split(" ").includes(entry)
      ? [Number(pid)]
      : [];
  });
}

async function onWindows(name: string, value: string, signal: AbortSignal): Promise<number[]> {
  const encoded = Buffer.from(WINDOWS_SCRIPT, "utf16le").toString("base64");
  const listing = await run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    { ...process.env, SWEEP_NAME: name, SWEEP_VALUE: value, SWEEP_DAEMON: String(process.pid) },
    signal,
  );
  return listing.split(/\s+/).flatMap((word) => (/^\d+$/.test(word) ? [Number(word)] : []));
}

function gone(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ESRCH";
}

/** Stops every process, whatever started or orphaned it, whose environment carries `name=value`, never this one; returns the pids stopped. */
export async function stopMarked(name: string, value: string, signal: AbortSignal): Promise<number[]> {
  if (process.platform === "win32") return (await onWindows(name, value, signal)).filter((pid) => pid !== process.pid);
  const entry = `${name}=${value}`;
  const found = process.platform === "darwin" ? await onMac(entry, signal) : await onLinux(entry);
  const stopped: number[] = [];
  for (const pid of found.filter((pid) => pid !== process.pid)) {
    if (signal.aborted) break;
    try {
      process.kill(pid, "SIGKILL");
      stopped.push(pid);
    } catch (error) {
      // Gone between the listing and the kill is what was wanted.
      if (!gone(error)) daemonLog.error(`could not stop process ${pid} carrying ${name}=${value}:`, error);
    }
  }
  return stopped;
}
