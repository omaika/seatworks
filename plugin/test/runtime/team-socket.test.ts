import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { statSync, writeFileSync } from "node:fs";
import { type Socket, createServer } from "node:net";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { deskSocket } from "../../server/core/paths.ts";
import type { ToolReply } from "../../server/desk/context.ts";
import { TeamSocket } from "../../server/runtime/seat/team-socket.ts";
import { tempDir } from "../tempdir.ts";

const TEAM = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "mcp", "team.mjs");

/**
 * A desk socket built as the plugin builds it, on a state root of its own: a named pipe on Windows, a socket file elsewhere.
 * The root is the temp directory itself, since a path under a real macOS TMPDIR runs out of sun_path's 104 bytes.
 */
const deskPath = (prefix: string) => deskSocket(tempDir(prefix));

/** Resolves once `check` holds, polling while the other end does its part; fails after five seconds. */
async function until(check: () => boolean, what: string): Promise<void> {
  for (let tries = 0; !check(); tries++) {
    assert.ok(tries < 250, `never: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("the line's ends: no desk to reach, and a pipe closed under a server whose line is open", async (t) => {
  const client = new Client({ name: "probe", version: "0" });
  const nowhere = deskPath("sw2-desk-none-");
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [TEAM, "lead", "lead", nowhere],
      env: { PATH: process.env.PATH ?? "", SEATWORKS_DESK_KEY: "k1" },
      stderr: "inherit",
    }),
  );
  t.after(() => client.close());
  const called = (await client.callTool({ name: "status", arguments: {} })) as {
    isError?: boolean;
    content: { text: string }[];
  };
  assert.equal(called.isError, true);
  assert.match(
    called.content[0]!.text,
    /^The team desk is not running, so status was not carried out\. Do not call it again/,
  );

  const lines: Socket[] = [];
  const open = createServer((line) => lines.push(line));
  const held = deskPath("sw2-desk-held-");
  await new Promise<void>((resolve) => open.listen(held, resolve));
  t.after(() => {
    for (const line of lines) line.destroy();
    open.close();
  });
  const server = spawn(process.execPath, [TEAM, "peer", "peer", held], {
    env: { PATH: process.env.PATH ?? "", SEATWORKS_DESK_KEY: "k1" },
    stdio: ["pipe", "ignore", "inherit"],
  });
  t.after(() => server.kill());
  const exited = new Promise<boolean>((resolve) => server.on("exit", () => resolve(true)));
  await until(() => lines.length === 1, "its line to the desk is open");
  server.stdin.end();
  const late = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000).unref());
  assert.ok(
    await Promise.race([exited, late]),
    "a server whose harness closes its pipe exits, though its line is open",
  );
});

test(
  "a socket file a stopped plugin left behind is taken over, and the socket it opens is its user's alone",
  {
    skip:
      process.platform === "win32" &&
      "the desk's socket on Windows is a named pipe: no file is left behind to take over, and a pipe carries no mode",
  },
  async (t) => {
    const path = deskPath("sw2-sock-");
    writeFileSync(path, "left behind");
    const socket = new TeamSocket(path, {
      whose: () => ({ agent: "agent-1" }),
      choices: () => ({}),
      answer: () => new Promise<ToolReply>(() => {}),
      mailLost: async () => undefined,
    });
    socket.listen();
    t.after(() => socket.close());
    const mode = () => {
      try {
        return statSync(path).isSocket() ? statSync(path).mode & 0o777 : 0;
      } catch {
        return 0;
      }
    };
    await until(() => mode() === 0o600, "the file is gone and the socket stands in its place, open to this user alone");
  },
);

test("a line that fails is dropped and the call it carried goes to the mail", async (t) => {
  const cancelled: AbortSignal[] = [];
  const socket = new TeamSocket(deskPath("sw2-failing-"), {
    whose: (key) => (key === "k1" ? { agent: "agent-1" } : { refused: "unknown" }),
    choices: () => ({}),
    answer: (_request, stop) => (cancelled.push(stop), new Promise<ToolReply>(() => {})),
    mailLost: async () => undefined,
  });
  t.after(() => socket.close());
  const failing = Object.assign(new PassThrough(), { destroyed: false, destroy() {} }) as unknown as Socket;
  (socket as unknown as { serve(line: Socket): void }).serve(failing);
  failing.write(`${JSON.stringify({ type: "hello", key: "k1", role: "lead", cwd: "/work" })}\n`);
  failing.write(`${JSON.stringify({ type: "call", id: "1", tool: "status", args: {} })}\n`);
  await until(() => cancelled.length === 1 && socket.calling("agent-1"), "the call is on the line");
  assert.doesNotThrow(() => {
    failing.emit("error", new Error("reset by the seat's end"));
    failing.emit("close");
  }, "a line that fails is dropped, and the desk goes on");
  assert.equal(cancelled[0]!.aborted, true, "and its call goes to the mail");
  assert.equal(socket.calling("agent-1"), false);
});

/** A line's other end, wherever it came from: what the desk writes comes back as what it reads, and destroying it closes it. */
const otherEnd = () => new PassThrough() as unknown as Socket;

type Reach = { serve(socket: Socket): void; lines: Set<{ agent?: string; refused?: string }> };
const reach = (socket: TeamSocket) => socket as unknown as Reach;

/** The window team-socket.ts gives a line to say who it is, and the cap on the lines still waiting to. */
const WINDOW_MS = 5_000;
const UNKNOWN_LINES = 32;

const deskOf = (heard: () => void): ConstructorParameters<typeof TeamSocket>[1] => ({
  whose: (key) => (heard(), key === "k1" ? { agent: "agent-1" } : { refused: "unknown" }),
  choices: () => ({}),
  answer: () => new Promise<ToolReply>(() => {}),
  mailLost: async () => undefined,
});

test("a line that says no hello in its window is dropped and tracked no longer, while a seat's line stays whatever the clock does", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let heard = () => {};
  const socket = new TeamSocket(
    deskPath("sw2-window-"),
    deskOf(() => heard()),
  );
  t.after(() => socket.close());

  const silent = otherEnd();
  reach(socket).serve(silent);
  assert.equal(reach(socket).lines.size, 1, "whoever connects costs the desk a line");
  t.mock.timers.tick(WINDOW_MS - 1);
  assert.equal(silent.destroyed, false, "a line that has only just connected is still served");
  t.mock.timers.tick(1);
  assert.equal(silent.destroyed, true, "its window ran out with no hello");
  assert.equal(reach(socket).lines.size, 0, "and nothing tracks it any more");

  const seat = otherEnd();
  reach(socket).serve(seat);
  // The desk reading the hello is the gate: `whose` is called with the key, and only then is the line a seat's.
  const said = new Promise<void>((resolve) => (heard = resolve));
  seat.write(`${JSON.stringify({ type: "hello", key: "k1", role: "lead", cwd: "/work" })}\n`);
  await said;
  t.mock.timers.tick(WINDOW_MS * 10);
  assert.equal(seat.destroyed, false, "a seat that said who it is keeps its line however long it holds it");
  assert.equal(reach(socket).lines.size, 1);
});

test("lines that have not said who they are are capped, so a caller opening them in a loop cannot grow what tracks them", (t) => {
  const socket = new TeamSocket(
    deskPath("sw2-flood-"),
    deskOf(() => {}),
  );
  t.after(() => socket.close());
  const opened = Array.from({ length: UNKNOWN_LINES * 4 }, () => otherEnd());
  for (const line of opened) reach(socket).serve(line);
  assert.equal(reach(socket).lines.size, UNKNOWN_LINES, "the tracked set stopped at the cap");
  assert.deepEqual(
    opened.map((line) => line.destroyed).lastIndexOf(true),
    UNKNOWN_LINES * 3 - 1,
    "the oldest waiting lines went and the newest stayed, whosever they were",
  );
});

test("a line the desk refuses is left open and quiet, rather than dropped into a reconnect it is refused again", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const socket = new TeamSocket(
    deskPath("sw2-refused-"),
    deskOf(() => {}),
  );
  t.after(() => socket.close());

  const archived = otherEnd();
  reach(socket).serve(archived);
  archived.write(`${JSON.stringify({ type: "hello", key: "k-gone", role: "peer", cwd: "/work" })}\n`);
  assert.equal([...reach(socket).lines][0]?.refused, "unknown", "the desk read the hello and would serve nobody by it");
  t.mock.timers.tick(WINDOW_MS * 10);
  assert.equal(
    archived.destroyed,
    false,
    "the window that drops a line nobody claimed does not drop one the desk refused",
  );
  assert.equal(
    reach(socket).lines.size,
    1,
    "so its server has nothing to reopen, and is not refused again every few seconds",
  );
});
