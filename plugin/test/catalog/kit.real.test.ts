// First, so this file has a HOME of its own even run alone: what it writes under HOME would otherwise land in the owner's.
import "../setup.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";
import { renderPrompt, renderText, skillProblems, skillSources } from "../../server/catalog/kit/content.ts";
import { loadKit } from "../../server/catalog/kit/kit.ts";
import { providerId, toolsOf } from "../../server/catalog/kit/roles.ts";
import { applyRole, seatEnv } from "../../server/catalog/seat/launch.ts";
import { desiredProvider, seatPairs } from "../../server/catalog/paseo/providers.ts";
import { seedRecords } from "../../server/catalog/seat/seat-files.ts";
import { materialize, seatDir } from "../../server/catalog/seat/seats.ts";
import { placeGuides } from "../../server/catalog/seat/snapshots.ts";
import { choicesFor, serversFor } from "../../server/catalog/seat/servers.ts";
import { resolveTeam, rulesFor, withHarness } from "../../server/catalog/team/team.ts";
import { describeTeam } from "../../server/runtime/panel/team-view.ts";
import { readConfig, readConfigStrict } from "../../server/core/config-file.ts";
import { type Json, layered } from "../../server/core/json.ts";
import { git } from "../../server/core/git.ts";
import { guidesDir } from "../../server/core/paths.ts";
import type { AgentConfig } from "../../server/core/ports.ts";
import { tempDir } from "../tempdir.ts";

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const project = { root: "/work/demo", slug: "demo-000000", state: "/state/demo" };
const context = { node: "/bin/node", socket: "/desk.sock" };
const allOn = (kit: ReturnType<typeof loadKit>) => ({
  mcp: Object.fromEntries(Object.keys(kit.mcp).map((id) => [id, { enabled: true }])),
});
test("the shipped kit resolves to a complete team, and every role's seat builds with no hidden word or placeholder in it", () => {
  const kit = loadKit(PLUGIN);
  const off = resolveTeam(kit);
  assert.deepEqual(off.errors, []);
  assert.deepEqual(
    Object.values(off.mcp).filter((state) => state.enabled),
    [],
    "the kit ships no server switched on",
  );
  const team = resolveTeam(kit, allOn(kit));
  assert.deepEqual(team.errors, []);
  const names = (pairs: { role: { role: string }; harness: { id: string } }[]) =>
    pairs.map((pair) => `${pair.role.role}-${pair.harness.id}`).sort();
  assert.deepEqual(
    names(seatPairs(kit)),
    names(kit.roles.flatMap((role) => Object.values(kit.harnesses).map((harness) => ({ role, harness })))),
    "every role can sit on every agent the kit ships",
  );
  const deltas = Object.keys(kit.harnesses).flatMap((id) => {
    const dir = join(PLUGIN, "harness", id, "delta");
    return existsSync(dir) ? readdirSync(dir).map((file) => `${id}/${file}`) : [];
  });
  assert.deepEqual(
    deltas.filter((entry) => !kit.roles.some((role) => entry.endsWith(`/${role.role}.md`))),
    [],
    "every harness delta speaks to a role the kit has",
  );
  const home = tempDir("sw2-real-home-");
  for (const [name, seat] of Object.entries(team.roles)) {
    const { role, harness } = seat;
    materialize(kit, team, name, home, project, serversFor(kit, team, name, context));
    const dir = seatDir(kit, role, harness, home, project);
    assert.ok(existsSync(join(dir, harness.skillsDir)), `${name} skills dir`);
    for (const on of Object.keys(kit.harnesses))
      assert.doesNotMatch(
        renderPrompt(kit, role, on, { guides: "/guides", state: "/state" }),
        /\{\{/,
        `${name} on ${on}`,
      );
    const told = renderText(role, rulesFor(team, name), { guides: "/guides", state: "/state" });
    assert.doesNotMatch(told, /\{\{/, `${name} seat has no placeholder left`);
    for (const [id, entry] of Object.entries(kit.mcp)) {
      const served = seat.mcp.includes(id);
      if (entry.rule)
        assert.equal(
          told.includes(readFileSync(join(entry.dir, entry.rule), "utf-8").trim()),
          served,
          `${name}: ${id}'s rule`,
        );
      for (const skill of entry.skills ?? [])
        assert.equal(
          existsSync(join(dir, harness.skillsDir, skill, "SKILL.md")),
          served,
          `${name}: ${id}'s skill ${skill}`,
        );
    }
  }
});

const REAL_PLATFORM = process.platform;

/** The daemon's platform taken as `platform` for the rest of the test; after it, the host's own, however many it took. */
function onPlatform(t: TestContext, platform: NodeJS.Platform): void {
  t.after(() => Object.defineProperty(process, "platform", { value: REAL_PLATFORM, configurable: true }));
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

type Sandbox = { enabled?: boolean; failIfUnavailable?: boolean; allowUnsandboxedCommands?: boolean };
type SeatSettings = {
  sandbox?: Sandbox;
  sandbox_mode?: string;
  default_permissions?: string;
  permissions?: Record<string, unknown>;
  windows?: { sandbox?: string };
};

/** Every role built on Claude and on Codex as a seat starts: its folder, its launch config and env, and its settings as they reach it. */
function seatsOnEveryRole(home: string): { name: string; harness: string; settings: SeatSettings }[] {
  const kit = loadKit(PLUGIN);
  return kit.roles.flatMap((role) =>
    ["claude", "codex"].map((id) => {
      const harness = kit.harnesses[id]!;
      const team = withHarness(resolveTeam(kit), role.role, harness);
      const servers = serversFor(kit, team, role.role, context);
      materialize(kit, team, role.role, home, project, servers);
      const dir = seatDir(kit, role, harness, home, project);
      const provider = providerId(kit, role.role, id);
      const config = applyRole(kit, team, { provider, cwd: project.root }, () => "PROMPT", project.state, servers);
      const request = {
        agentId: "a",
        reason: "create" as const,
        purpose: "interactive" as const,
        provider,
        cwd: project.root,
        env: {},
      };
      const env = seatEnv(kit, request, dir, project).env;
      const name = `the ${role.role} on ${id}`;
      assert.ok(config.systemPrompt, `${name} starts with its prompt`);
      assert.equal(env[harness.configDirEnv], dir, `${name} reads its settings from the folder built for it`);
      const file = readConfigStrict<Json>(join(dir, harness.settings.file));
      const launched = (config.providerOptions as { settings?: Json } | undefined)?.settings;
      return { name, harness: id, settings: layered(file, launched) as SeatSettings };
    }),
  );
}

test("on Windows every role seats on Claude and on Codex: Codex in the sandbox it has there, Claude, which has none, unsandboxed rather than stopped", (t) => {
  onPlatform(t, "win32");
  const kit = loadKit(PLUGIN);
  assert.equal(kit.harnesses.claude!.sandboxedOn?.includes("win32"), false, "Claude has no sandbox on native Windows");
  assert.equal(kit.harnesses.codex!.sandboxedOn?.includes("win32"), true, "Codex has one of its own there");
  for (const { name, harness, settings } of seatsOnEveryRole(tempDir("sw2-win-seats-")))
    if (harness === "claude") {
      assert.equal(settings.sandbox?.enabled, false, `${name} runs its commands unsandboxed`);
      assert.equal(settings.sandbox.failIfUnavailable, false, `${name} starts where no sandbox can`);
    } else {
      assert.equal(settings.windows?.sandbox, "unelevated", `${name} asks for the sandbox no administrator sets up`);
      const profile = settings.default_permissions;
      assert.ok(
        ["workspace-write", "read-only"].includes(settings.sandbox_mode ?? "") ||
          (profile !== undefined && settings.permissions?.[profile] !== undefined),
        `${name} keeps its sandbox`,
      );
    }
});

test(
  "on macOS and Linux a Claude seat still refuses to start without its sandbox, and a Codex seat takes nothing meant for Windows",
  // Taken as macOS, a real Windows host would be asked for symlinks its ordinary account may not make.
  { skip: process.platform === "win32" && "a POSIX seat build needs POSIX links" },
  (t) => {
    for (const platform of ["darwin", "linux"] as const) {
      onPlatform(t, platform);
      for (const { name, harness, settings } of seatsOnEveryRole(tempDir(`sw2-${platform}-seats-`)))
        if (harness === "claude") {
          const { enabled, failIfUnavailable, allowUnsandboxedCommands } = settings.sandbox ?? {};
          assert.deepEqual(
            { enabled, failIfUnavailable, allowUnsandboxedCommands },
            { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false },
            `${name} on ${platform}`,
          );
        } else assert.equal(settings.windows, undefined, `${name} on ${platform}`);
    }
  },
);

test(
  "on Windows a seat of every role keeps every rule its role has on macOS, so only its sandbox differs",
  // Taken as macOS, a real Windows host would be asked for symlinks its ordinary account may not make.
  { skip: process.platform === "win32" && "a POSIX seat build needs POSIX links" },
  (t) => {
    const home = tempDir("sw2-win-rules-");
    const sandboxKey = { claude: "sandbox", codex: "windows" } as Record<string, keyof SeatSettings>;
    const built = (platform: NodeJS.Platform) => {
      onPlatform(t, platform);
      return new Map(
        seatsOnEveryRole(home).map(({ name, harness, settings }) => {
          if (harness === "claude")
            assert.ok(settings.permissions?.deny, `${name} on ${platform} carries its role's rules`);
          return [name, { ...settings, [sandboxKey[harness]!]: undefined }];
        }),
      );
    };
    const onMac = built("darwin");
    const onWindows = built("win32");
    assert.deepEqual([...onWindows.keys()], [...onMac.keys()]);
    for (const [name, settings] of onWindows) assert.deepEqual(settings, onMac.get(name), `${name} on Windows`);
  },
);

test("nothing a seat or its guides lead it to read resolves into a git repository", async () => {
  const kit = loadKit(PLUGIN);
  const home = tempDir("sw2-outside-home-");
  const roots = [guidesDir(home)];
  placeGuides(kit, home);
  for (const { role, harness } of seatPairs(kit)) {
    const team = withHarness(resolveTeam(kit), role.role, harness);
    materialize(kit, team, role.role, home, project);
    roots.push(join(seatDir(kit, role, harness, home, project), harness.skillsDir));
  }
  const inside: string[] = [];
  for (const root of roots) {
    for (const name of readdirSync(root, { recursive: true }).map(String)) {
      const real = realpathSync(join(root, name));
      const dir = statSync(real).isDirectory() ? real : dirname(real);
      if ((await git(dir, ["rev-parse", "--show-toplevel"])).code === 0) inside.push(`${join(root, name)} -> ${real}`);
    }
  }
  assert.deepEqual(
    inside.slice(0, 5),
    [],
    `${inside.length} paths resolve into a repository: an agent loads the AGENTS.md above what it reads, so seats took the plugin's own rules`,
  );
});

test("a Codex seat runs on the model provider the owner's own Codex names, and on Codex's own when it names none", () => {
  const kit = loadKit(PLUGIN);
  const pair = seatPairs(kit).find((entry) => entry.harness.id === "codex" && entry.role.role === "lead")!;
  const team = withHarness(resolveTeam(kit), "lead", pair.harness);
  const home = tempDir("sw2-codex-home-");
  materialize(kit, team, "lead", home, project);
  const file = join(seatDir(kit, pair.role, pair.harness, home, project), "config.toml");
  type Seat = {
    model_provider?: string;
    model_providers?: Record<string, { base_url?: string }>;
    model?: string;
    approval_policy?: string;
  };
  assert.equal(readConfig<Seat>(file, {}).model_provider, undefined);
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(
    join(home, ".codex", "config.toml"),
    'model_provider = "ZAI"\nmodel = "glm-5.3"\n\n[model_providers.ZAI]\nname = "Z"\nbase_url = "https://example.invalid"\nexperimental_bearer_token = "fake"\n',
  );
  materialize(kit, team, "lead", home, project);
  const seat = readConfig<Seat>(file, {});
  assert.equal(seat.model_provider, "ZAI");
  assert.equal(seat.model_providers?.ZAI?.base_url, "https://example.invalid");
  assert.equal(seat.model, undefined, "the model is the role's, set at launch, not the owner's default");
  assert.equal(seat.approval_policy, "never", "and the kit's own settings still hold");
});

test("a Codex seat has every desk and proxy tool it is given approved ahead, and other agents get no such list", () => {
  const kit = loadKit(PLUGIN);
  const all = resolveTeam(kit, allOn(kit));
  const codex = withHarness(all, "lead", kit.harnesses.codex!);
  const servers = serversFor(kit, codex, "lead", context) as Record<string, { args?: string[] } | undefined>;
  const config: AgentConfig = { provider: providerId(kit, "lead", "codex"), cwd: "/work/repo" };
  const next = applyRole(kit, codex, config, () => "PROMPT", "/state/demo", servers);
  const approved = new Set(next.toolPolicy?.preapproved.map((ref) => `${ref.server}.${ref.tool}`));
  const lead = kit.roles.find((role) => role.role === "lead")!;
  for (const tool of toolsOf(kit, lead))
    assert.ok(approved.has(`team.${tool}`), `team.${tool}: Codex refuses an MCP call not approved ahead`);
  const proxies = Object.keys(servers).filter(
    (id) => id !== "team" && String(servers[id]?.args?.[0]).endsWith("code.mjs"),
  );
  assert.ok(proxies.length > 0, "the shipped kit gives the Lead at least one proxied server");
  for (const id of proxies)
    assert.ok(
      [...approved].some((name) => name.startsWith(`${id}.`)),
      id,
    );
  assert.deepEqual(
    [...approved].filter((name) => name.startsWith("paseo.")),
    [],
    "the Lead is allowed none of Paseo's tools",
  );
  const own = {
    ...kit,
    roles: kit.roles.map((role) =>
      role.role === "supervisor" ? { ...role, paseoTools: { allow: ["list_schedules"] } } : role,
    ),
  };
  const supervisor = withHarness(resolveTeam(own), "supervisor", kit.harnesses.codex!);
  const asked: AgentConfig = { provider: providerId(own, "supervisor", "codex"), cwd: "/work/repo" };
  const supervising = applyRole(
    own,
    supervisor,
    asked,
    () => "PROMPT",
    "/state/demo",
    serversFor(own, supervisor, "supervisor", context),
  );
  assert.deepEqual(
    supervising.toolPolicy?.preapproved.filter((ref) => ref.server === "paseo").map((ref) => ref.tool),
    ["list_schedules"],
    "a roles file of one's own may give a seat some of Paseo's tools, which Paseo adds at launch",
  );
  const claude = applyRole(
    kit,
    all,
    { provider: providerId(kit, "lead", "claude"), cwd: "/work/repo" },
    () => "PROMPT",
    "/state/demo",
    serversFor(kit, all, "lead", context),
  );
  assert.equal(claude.toolPolicy, undefined);
});

test("each shipped role writes under the project's state only what its prompt, deltas or skills name, or its note pages", () => {
  const kit = loadKit(PLUGIN);
  const paths = { guides: "/guides", state: "/state/demo" };
  for (const role of kit.roles) {
    const pages = toolsOf(kit, role).includes("note");
    for (const entry of (role.writes ?? []).filter((path) => !(pages && path.endsWith("/")))) {
      const without = { ...role, writes: role.writes!.filter((path) => path !== entry) };
      const prompts = Object.keys(kit.harnesses).some((harness) => {
        try {
          renderPrompt(kit, without, harness, paths);
          return false;
        } catch {
          return true;
        }
      });
      const skills = [...skillSources(kit, without)].some(
        ([name, dir]) => skillProblems(without, name, dir).length > 0,
      );
      assert.ok(prompts || skills, `${role.role} writes ${entry}, which nothing it reads names`);
    }
  }
});

test("a Claude seat reads the project's own CLAUDE.md and takes in its AGENTS.md, and logs in as the Human, though its settings come from its seat alone", () => {
  const kit = loadKit(PLUGIN);
  const team = resolveTeam(kit);
  const pairs = seatPairs(kit).filter((pair) => pair.harness.id === "claude");
  assert.equal(pairs.length, kit.roles.length);
  for (const { role, harness } of pairs) {
    const id = providerId(kit, role.role, "claude");
    const provider = desiredProvider(kit, withHarness(team, role.role, harness).roles[role.role]!);
    assert.equal(
      (provider.env as Record<string, string>).CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD,
      "1",
      `${role.role}: Claude reads CLAUDE.md from an added directory only with this set`,
    );
    assert.equal(
      (provider.env as Record<string, string>).CLAUDE_SECURESTORAGE_CONFIG_DIR,
      "",
      `${role.role}: the seat runs on the Human's own Claude login, which Claude otherwise keeps per settings folder`,
    );
    const next = applyRole(kit, team, { provider: id, cwd: "/work/repo" }, () => "PROMPT", "/state/demo");
    assert.deepEqual(
      next.providerOptions?.additionalDirectories,
      ["/work/repo"],
      `${role.role}: the seat's own directory is the one added`,
    );
  }
  const root = tempDir("sw2-agents-only-");
  writeFileSync(join(root, "AGENTS.md"), "Use pnpm.\n");
  const home = tempDir("sw2-agents-home-");
  const own = { root, slug: "demo-000000", state: join(root, ".state") };
  const peer = pairs.find((pair) => pair.role.role === "peer")!;
  materialize(kit, team, "peer", home, own);
  assert.match(
    readFileSync(join(seatDir(kit, peer.role, peer.harness, home, own), "CLAUDE.md"), "utf-8"),
    new RegExp(`^@${join(root, "AGENTS.md").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"),
    "Claude never reads AGENTS.md from an added directory, so the seat's own rules take it in",
  );
});

test("project records are seeded once and never overwritten", () => {
  const kit = loadKit(PLUGIN);
  const state = tempDir("sw2-state-");
  assert.ok(seedRecords(kit, state).includes("notebook.md"));
  writeFileSync(join(state, "notebook.md"), "The owner's own notes.\n");
  assert.deepEqual(seedRecords(kit, state), []);
  assert.equal(
    readFileSync(join(state, "notebook.md"), "utf-8"),
    "The owner's own notes.\n",
    "what the owner wrote there stays",
  );
});

test("a pasted server that names no roles is given to every role that works with tools but a judge, which has one only where it is named", () => {
  const kit = loadKit(PLUGIN);
  const pasted = { enabled: true, label: "Pasted", connect: { type: "http" as const, url: "https://mcp.example.com" } };
  const given = (team: ReturnType<typeof resolveTeam>) =>
    Object.entries(team.roles)
      .filter(([, seat]) => seat.mcp.includes("pasted"))
      .map(([name]) => name)
      .sort();
  const team = resolveTeam(kit, { mcp: { pasted } });
  assert.deepEqual(team.errors, []);
  assert.deepEqual(given(team), ["architect", "auditor", "lead", "peer", "reviewer", "second-reviewer", "supervisor"]);
  assert.deepEqual(given(resolveTeam(kit, { mcp: { pasted: { ...pasted, roles: ["watcher"] } } })), ["watcher"]);
});

test("the desk names each seat's fixed choices from the kit: who writes and with which skills, who reviews, who leads, where its pages go", () => {
  const kit = loadKit(PLUGIN);
  const team = resolveTeam(kit);
  const choices = (role: string) => choicesFor(kit, team, role);
  const skills = readdirSync(join(PLUGIN, "content", "skills", "peer")).sort();
  assert.deepEqual(choices("lead"), {
    add_tasks: { role: ["peer"], skills },
    start_review: { role: ["reviewer", "second-reviewer", "architect", "auditor"] },
    note: { kind: ["plans", "council", "ultra-review", "repo-refresh"] },
  });
  assert.deepEqual(choices("supervisor"), {
    open_lane: { role: ["lead"] },
    note: { kind: ["pre-mortem", "architecture-premise-audit"] },
  });
  assert.deepEqual(choices("peer"), {}, "a seat is named choices only for tools it has");
});

test("each role on the claude agent defaults to the model the Human named: Opus 5.5 as Paseo names it, no [1m], and Sonnet 5.5 for the rest", () => {
  const { roles } = resolveTeam(loadKit(PLUGIN));
  const opus = "claude-opus-5-5";
  const sonnet = "claude-sonnet-5-5";
  assert.deepEqual(
    Object.fromEntries(Object.entries(roles).map(([name, seat]) => [name, [seat.harness.id, seat.model?.id]])),
    Object.fromEntries(
      Object.entries({
        supervisor: opus,
        lead: opus,
        reviewer: opus,
        architect: opus,
        peer: sonnet,
        auditor: sonnet,
        watcher: sonnet,
        "second-reviewer": sonnet,
      }).map(([name, model]) => [name, ["claude", model]]),
    ),
  );
});

test("a second reviewer seats as the Reviewer on the same agent, with another model, so two lenses are not one model twice", () => {
  const kit = loadKit(PLUGIN);
  const team = resolveTeam(kit);
  const [first, second] = ["reviewer", "second-reviewer"].map((name) => team.roles[name]!);
  assert.deepEqual(
    [second!.role.prompt, second!.role.tools, second!.role.can, second!.harness.id],
    [first!.role.prompt, first!.role.tools, first!.role.can, first!.harness.id],
  );
  const shown = describeTeam(kit, resolveTeam(kit, { mcp: { "code-search": { enabled: true } } })).roles;
  assert.deepEqual(
    shown["second-reviewer"]!.tools,
    shown.reviewer!.tools,
    "the panel shows the code tools it is given",
  );
});

test("an Architect and an Auditor read as a Reviewer does, on its agent, each with a prompt of its own for its question", () => {
  const kit = loadKit(PLUGIN);
  const team = resolveTeam(kit);
  const reviewer = team.roles.reviewer!;
  for (const [name, prompt] of [
    ["architect", "prompts/ARCHITECT.md"],
    ["auditor", "prompts/AUDITOR.md"],
  ] as const) {
    const seat = team.roles[name]!;
    assert.deepEqual(
      [seat.role.prompt, seat.role.tools, seat.role.can, seat.harness.id],
      [prompt, reviewer.role.tools, reviewer.role.can, reviewer.harness.id],
    );
  }
});

test("the Lead, who accepts a task on reading its code, is given every code tool a Reviewer of that task is", () => {
  const kit = loadKit(PLUGIN);
  const shown = describeTeam(kit, resolveTeam(kit, allOn(kit))).roles;
  for (const [server, tools] of Object.entries(shown.reviewer!.tools))
    assert.deepEqual(
      tools.filter((tool) => !shown.lead!.tools[server]?.includes(tool)),
      [],
      `${server}: what the Reviewer reads the change with, the Lead weighing its verdict reads with too`,
    );
});

test("the preset reads what the watch sees with both brains: the kit's sensor sifts, and its Watcher seat judges", () => {
  const { brains } = resolveTeam(loadKit(PLUGIN));
  assert.deepEqual([brains.mode, brains.sensor?.id, brains.seat], ["both", "jev", "watcher"]);
  assert.equal(brains.sensor?.key, undefined, "a sensor with no key asks nothing until the owner gives one");
  assert.equal(new URL(brains.sensor!.sensor.url).host, "openrouter.ai", "Jev is asked over OpenRouter");
});

test("every role can be pointed at one agent alone, and what a fresh machine's agent still waits for is a model", () => {
  const kit = loadKit(PLUGIN);
  for (const [id, harness] of Object.entries(kit.harnesses)) {
    const all = (model?: string) =>
      Object.fromEntries(kit.roles.map((role) => [role.role, { harness: id, ...(model ? { model } : {}) }]));
    const named = resolveTeam(kit, { ...allOn(kit), roles: all(`${id}-1`) });
    assert.deepEqual(named.errors, [], `a team all on ${id}, with a model named outright`);
    assert.deepEqual(
      Object.values(named.roles).map((seat) => seat.harness.id),
      kit.roles.map(() => id),
      `every role seated on ${id}: its settings, its tools and its servers are all there on that agent alone`,
    );
    // With no model named, a role has its own preset for its own agent; on any other, it waits for Paseo's list of that
    // agent's models, and nothing else stands in its way.
    const waiting =
      (harness.models ?? []).length > 0
        ? []
        : kit.roles.filter((role) => !(role.defaults.harness === id && role.defaults.model));
    const bare = resolveTeam(kit, { ...allOn(kit), roles: all() });
    assert.equal(
      bare.errors.length,
      waiting.length,
      `a team all on ${id}, with no model named: ${bare.errors[0] ?? ""}`,
    );
    for (const role of waiting)
      assert.equal(
        bare.errors.filter((error) => error.includes(harness.label) && error.includes(role.label)).length,
        1,
        `${role.label} on ${id} waits for a model, and is told which agent's`,
      );
  }
});
