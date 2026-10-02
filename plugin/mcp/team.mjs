import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { ticker, unchecked } from "./progress.mjs";

const [role = "", toolSet = "", socket = ""] = process.argv.slice(2);
const here = dirname(fileURLToPath(import.meta.url));
const read = (file) => JSON.parse(readFileSync(join(here, file), "utf-8"));
const tools = read("tools.json")[toolSet] ?? [];
const instructions = read("instructions.json")[toolSet];
const { version } = read("../package.json");
// Retry a dropped line after that; a first list waits that long for the desk's choices, well within a harness's start.
const RETRY_MS = 2_000;
const WELCOME_MS = 300;

/** A copy of `schema` where each field the desk named a fixed set for takes it as its enum, however deep the field sits. */
function offered(schema, fields) {
  if (!schema?.properties) return schema;
  const shown = (field, values) => {
    const fixed = (target) => (values?.length > 0 && target?.type === "string" ? { ...target, enum: values } : target);
    return field.type === "array" ? { ...field, items: offered(fixed(field.items), fields) } : offered(fixed(field), fields);
  };
  return { ...schema, properties: Object.fromEntries(Object.entries(schema.properties).map(([name, field]) => [name, shown(field, fields[name])])) };
}

/** The line to the desk: opened at start and again when it drops, since the plugin reloads under running seats. */
class Desk {
  #line;
  #opening;
  #retry;
  #seq = 0;
  #waiting = new Map();
  refused;
  choices = {};
  changed = () => {};

  open() {
    if (this.#line) return Promise.resolve();
    clearTimeout(this.#retry);
    this.#opening ??= new Promise((settle) => {
      const line = createConnection(socket);
      const done = () => {
        this.#opening = undefined;
        settle();
      };
      line.on("connect", () => {
        // The harness's pipe keeps this server alive; the line to the desk never does on its own.
        line.unref();
        this.#line = line;
        this.#write({ type: "hello", key: process.env.SEATWORKS_DESK_KEY ?? "", role, cwd: process.cwd() });
      });
      // readline passes on the line's errors: a line that fails is closed, which is handled below.
      createInterface({ input: line }).on("line", (text) => this.#heard(text, done)).on("error", () => {});
      line.on("error", () => {});
      line.on("close", () => {
        if (this.#line === line) this.#line = undefined;
        for (const answer of this.#waiting.values()) answer(undefined);
        this.#waiting.clear();
        done();
        this.#retry = setTimeout(() => void this.open(), RETRY_MS).unref();
      });
    });
    return this.#opening;
  }

  /** The desk's answer to one call; the harness stopping it tells the desk, which mails the answer instead. */
  async call(tool, args, ctx) {
    await this.open();
    // Stopped before this could listen for it, as a stop read with its call is: the desk never takes the call.
    if (ctx.mcpReq.signal.aborted) return { ok: false, text: `${tool} was stopped before it reached the desk.` };
    if (this.refused) return { ok: false, text: this.refused };
    if (!this.#line) return { ok: false, text: `The team desk is not running, so ${tool} was not carried out. Do not call it again; end your turn saying which call went unanswered.` };
    const id = String(++this.#seq);
    let settle;
    const answered = new Promise((resolve) => (settle = resolve));
    this.#waiting.set(id, settle);
    this.#write({ type: "call", id, tool, args });
    const stop = () => {
      if (this.#waiting.delete(id)) this.#write({ type: "cancel", id });
      settle(undefined);
    };
    const { signal } = ctx.mcpReq;
    signal.addEventListener("abort", stop, { once: true });
    const progress = ticker(ctx, `The desk is still working on ${tool}.`);
    const reply = await answered;
    progress?.stop();
    signal.removeEventListener("abort", stop);
    if (reply) this.#write({ type: "taken", id });
    return reply ?? { ok: false, text: `The line to the team desk dropped while ${tool} ran, so its answer did not come back here. If the desk took the call, its answer comes as mail: look before calling ${tool} again, since a second call may do it twice.` };
  }

  #heard(text, done) {
    let said;
    try {
      said = JSON.parse(text);
    } catch {
      return;
    }
    if (said.type === "welcome" || said.type === "choices") {
      this.refused = undefined;
      const before = JSON.stringify(this.choices);
      this.choices = said.choices ?? {};
      if (JSON.stringify(this.choices) !== before) this.changed();
      done();
    } else if (said.type === "refused") {
      this.refused = said.why;
      done();
    } else if (said.type === "result") {
      const answer = this.#waiting.get(said.id);
      this.#waiting.delete(said.id);
      answer?.(said);
    }
  }

  #write(message) {
    this.#line?.write(`${JSON.stringify(message)}\n`);
  }
}

const desk = new Desk();
void desk.open();

serveStdio(async () => {
  await Promise.race([desk.open(), new Promise((resolve) => setTimeout(resolve, WELCOME_MS).unref())]);
  const server = new McpServer({ name: "team", version }, { capabilities: { tools: { listChanged: true } }, instructions });
  const schemaOf = (tool) => JSON.stringify(offered(tool.inputSchema, desk.choices[tool.name] ?? {}));
  const held = new Map();
  for (const tool of tools) {
    const schema = schemaOf(tool);
    const entry = server.registerTool(tool.name, { title: tool.title, description: tool.description, annotations: tool.annotations, inputSchema: fromJsonSchema(JSON.parse(schema), unchecked) }, async (args, ctx) => {
      const reply = await desk.call(tool.name, args ?? {}, ctx);
      return { content: [{ type: "text", text: String(reply.text ?? "") }], isError: !reply.ok };
    });
    held.set(tool, { schema, entry });
  }
  // Only a tool whose choices changed is updated: each update tells the harness to list the tools again.
  desk.changed = () => {
    for (const [tool, shown] of held) {
      const schema = schemaOf(tool);
      if (schema === shown.schema) continue;
      shown.schema = schema;
      shown.entry.update({ paramsSchema: fromJsonSchema(JSON.parse(schema), unchecked) });
    }
  };
  return server;
});
