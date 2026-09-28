import { randomUUID } from "node:crypto";
import { chmodSync, rmSync } from "node:fs";
import { type Server, type Socket, createServer } from "node:net";
import { createInterface } from "node:readline";
import { z } from "zod";
import type { ToolReply, ToolRequest } from "../../desk/context.ts";
import { daemonLog } from "../../core/logger.ts";

const Heard = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), key: z.string(), role: z.string(), cwd: z.string() }),
  z.object({ type: z.literal("call"), id: z.string(), tool: z.string(), args: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal("cancel"), id: z.string() }),
  z.object({ type: z.literal("taken"), id: z.string() }),
]);

type Choices = Record<string, Record<string, string[]>>;

type LineDesk = {
  whose(key: string): { agent: string } | { refused: string };
  choices(role: string, cwd: string): Choices;
  answer(request: ToolRequest, cancelled: AbortSignal): Promise<ToolReply>;
  mailLost(request: ToolRequest, reply: ToolReply): Promise<unknown>;
};

type Call = { request: ToolRequest; stop: AbortController; reply?: ToolReply };
type Line = {
  socket: Socket;
  agent?: string;
  refused?: string;
  role: string;
  cwd: string;
  shown?: string;
  calls: Map<string, Call>;
  window?: ReturnType<typeof setTimeout>;
};

const UNHEARD = "The desk does not know which agent this is: its team server has not said. Say so, and end your turn.";

// A seat's server says hello the instant it connects and gives the desk 300 ms to answer, so a line silent this long is nobody's.
const HELLO_MS = 5_000;
// Only this many lines may wait to say who they are; past it the oldest go. In a wave of reconnects wider than this, after a
// plugin reload, the line dropped may be a real seat's: its server opens the line again, and the desk knows it then.
const UNKNOWN_LINES = 32;

/** Where seats' team servers reach the desk: one line each, a call answered on the line it came by. */
export class TeamSocket {
  private readonly path: string;
  private readonly pipe: boolean;
  private readonly desk: LineDesk;
  private readonly lines = new Set<Line>();
  private server: Server | undefined;

  constructor(path: string, desk: LineDesk) {
    this.path = path;
    this.pipe = path.startsWith("\\\\.\\pipe\\");
    this.desk = desk;
  }

  /** A socket file left by a plugin that stopped without closing it is taken over. */
  listen(): void {
    if (!this.pipe) rmSync(this.path, { force: true });
    const server = createServer((socket) => this.serve(socket));
    server.on("error", (error) => daemonLog.error("the desk's socket failed:", error));
    server.listen(this.path, () => {
      if (!this.pipe) chmodSync(this.path, 0o600);
    });
    this.server = server;
  }

  close(): void {
    this.server?.close();
    this.server = undefined;
    for (const line of this.lines) {
      clearTimeout(line.window);
      line.socket.destroy();
    }
    if (!this.pipe) rmSync(this.path, { force: true });
  }

  /** Whether the agent waits on a call: answered or not, until its server says the harness took the answer. */
  calling(agent: string): boolean {
    return [...this.lines].some((line) => line.agent === agent && line.calls.size > 0);
  }

  /** The sets seats' fields take may have changed: a line whose set did is sent the new one. */
  refresh(): void {
    for (const line of this.lines) if (line.agent) this.offer(line, "choices");
  }

  private serve(socket: Socket): void {
    const line: Line = { socket, role: "", cwd: "", calls: new Map() };
    this.lines.add(line);
    line.window = setTimeout(() => this.drop(line), HELLO_MS);
    this.crowd();
    // readline passes on the socket's errors: a line that fails is closed, and `dropped` sees to its calls.
    createInterface({ input: socket })
      .on("line", (text) => this.heard(line, text))
      .on("error", () => {});
    socket.on("error", () => {});
    socket.on("close", () => this.dropped(line));
  }

  /** Whoever reaches the desk costs it one line until it says who it is: the oldest of those past the cap go now. */
  private crowd(): void {
    const waiting = [...this.lines].filter((line) => !line.agent && !line.socket.destroyed);
    for (const line of waiting.slice(0, Math.max(0, waiting.length - UNKNOWN_LINES))) this.drop(line);
  }

  private drop(line: Line): void {
    line.socket.destroy();
    this.dropped(line);
  }

  private heard(line: Line, text: string): void {
    let said: z.infer<typeof Heard>;
    try {
      said = Heard.parse(JSON.parse(text));
    } catch {
      return;
    }
    if (said.type === "hello") return this.hello(line, said);
    if (said.type === "call") return this.call(line, said);
    const call = line.calls.get(said.id);
    line.calls.delete(said.id);
    if (call && said.type === "cancel") this.lose(call);
  }

  private hello(line: Line, said: { key: string; role: string; cwd: string }): void {
    if (line.agent) return;
    // Cleared before the refusal too: a refused line dropped here is reopened by the seat's server, refused and dropped for ever.
    clearTimeout(line.window);
    const whose = this.desk.whose(said.key);
    if ("refused" in whose) {
      line.refused = whose.refused;
      return this.send(line, { type: "refused", why: whose.refused });
    }
    Object.assign(line, { agent: whose.agent, role: said.role, cwd: said.cwd });
    this.offer(line, "welcome");
  }

  private offer(line: Line, type: "welcome" | "choices"): void {
    const choices = this.desk.choices(line.role, line.cwd);
    const shown = JSON.stringify(choices);
    if (type === "choices" && shown === line.shown) return;
    line.shown = shown;
    this.send(line, { type, choices });
  }

  private call(line: Line, said: { id: string; tool: string; args: Record<string, unknown> }): void {
    if (!line.agent) return this.send(line, { type: "result", id: said.id, ok: false, text: line.refused ?? UNHEARD });
    const call: Call = {
      request: {
        id: randomUUID(),
        agent: line.agent,
        role: line.role,
        tool: said.tool,
        args: said.args,
        cwd: line.cwd,
        at: Date.now(),
      },
      stop: new AbortController(),
    };
    line.calls.set(said.id, call);
    void this.desk.answer(call.request, call.stop.signal).then((reply) => {
      // Stopped, or its line gone: that answer goes as a letter instead.
      if (line.calls.get(said.id) !== call) return;
      call.reply = reply;
      this.send(line, { type: "result", id: said.id, ...reply });
    });
  }

  /** A call whose seat will not take its answer here: stopped before it came, the desk mails it when it does; after, it is mailed now. */
  private lose(call: Call): void {
    if (call.reply)
      void this.desk
        .mailLost(call.request, call.reply)
        .catch((error: unknown) => daemonLog.error("a reply that did not reach its seat could not be mailed:", error));
    else call.stop.abort();
  }

  private dropped(line: Line): void {
    clearTimeout(line.window);
    this.lines.delete(line);
    for (const call of line.calls.values()) this.lose(call);
    line.calls.clear();
  }

  private send(line: Line, message: object): void {
    if (!line.socket.destroyed) line.socket.write(`${JSON.stringify(message)}\n`);
  }
}
