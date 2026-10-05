import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const PLUGIN = join(dirname(fileURLToPath(import.meta.url)), "..");

const MAY_IMPORT: Record<string, string[]> = {
  "index.server.ts": ["server/core", "server/catalog", "server/runtime", "server/adapters", "@getpaseo/plugin/server"],
  "index.client.tsx": ["client", "@getpaseo/plugin/client"],
  "eslint.config.js": [],
  shared: ["@getpaseo/plugin"],
  client: ["shared", "@getpaseo/plugin", "@getpaseo/plugin/client"],
  "server/core": [],
  "server/domain": [],
  "server/catalog": ["server/core", "shared"],
  "server/desk": ["server/core", "server/domain", "server/catalog", "shared"],
  "server/desk/tools": ["server/core", "server/domain", "server/catalog", "server/desk"],
  "server/runtime/watch": ["server/core", "server/domain", "server/catalog", "server/desk"],
  "server/upkeep": ["server/core", "server/catalog", "server/desk", "shared"],
  "server/runtime": [
    "server/core",
    "server/domain",
    "server/catalog",
    "server/desk",
    "server/desk/tools",
    "server/runtime/watch",
    "server/upkeep",
    "shared",
  ],
  "server/adapters": ["server/core", "@getpaseo/plugin/server"],
  mcp: [],
  bin: [],
};

const PACKAGES = ["@getpaseo/plugin/server", "@getpaseo/plugin/client", "@getpaseo/plugin"];

const NAMED: string[] = [];

const ENTRIES = ["index.server.ts", "index.client.tsx", "eslint.config.js"];

type Import = { to: string; names: Set<string> | "all" };
type Source = {
  imports: Import[];
  exports: Map<string, number>;
  words: string[];
};

/** The code files under `dir`, leaving out what the plugin does not run: `content/` is for the seats to read, and a fixture is data. */
function codeIn(dir: string): string[] {
  if (!statSync(join(PLUGIN, dir)).isDirectory()) return /\.(ts|tsx|mjs|js)$/.test(dir) ? [dir] : [];
  return readdirSync(join(PLUGIN, dir))
    .filter((name) => !["node_modules", "content", "fixtures"].includes(name))
    .flatMap((name) => codeIn(posix.join(dir, name)));
}

function bound(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) => (ts.isOmittedExpression(element) ? [] : bound(element.name)));
}

function exported(statement: ts.Statement): string[] {
  const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : [];
  if (!modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return [];
  if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) return ["default"];
  if (ts.isVariableStatement(statement))
    return statement.declarationList.declarations.flatMap((declaration) => bound(declaration.name));
  return [ts.getNameOfDeclaration(statement as ts.DeclarationStatement)!.getText()];
}

/** What a file imports and exports, read from its syntax: a namespace import counts the members it reads, unless the namespace itself is passed on. */
function read(path: string): Source {
  const text = readFileSync(join(PLUGIN, path), "utf-8");
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : path.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const line = (node: ts.Node) => file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
  const target = (spec: ts.Expression) => {
    const named = (spec as ts.StringLiteral).text;
    return named.startsWith(".") ? posix.join(posix.dirname(path), named) : named;
  };
  const source: Source = {
    imports: [],
    exports: new Map(),
    words: [],
  };
  const namespaces = new Map<string, Import>();
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      const names = new Set<string>();
      const entry: Import = { to: target(statement.moduleSpecifier), names };
      const clause = statement.importClause;
      if (clause?.name) names.add("default");
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings))
        for (const element of bindings.elements) names.add((element.propertyName ?? element.name).text);
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.set(bindings.name.text, entry);
      source.imports.push(entry);
    } else if (ts.isExportDeclaration(statement)) {
      const clause = statement.exportClause;
      const named = clause && ts.isNamedExports(clause) ? clause.elements : undefined;
      if (statement.moduleSpecifier)
        source.imports.push({
          to: target(statement.moduleSpecifier),
          names: named ? new Set(named.map((element) => (element.propertyName ?? element.name).text)) : "all",
        });
      for (const element of named ?? []) source.exports.set(element.name.text, line(element));
      if (clause && ts.isNamespaceExport(clause)) source.exports.set(clause.name.text, line(statement));
    } else if (ts.isExportAssignment(statement)) {
      source.exports.set("default", line(statement));
    }
    for (const name of exported(statement)) source.exports.set(name, line(statement));
  }
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      source.imports.push({ to: target(node.arguments[0]), names: "all" });
    }
    if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node) || ts.isJsxText(node))
      source.words.push(node.text);
    const parent = node.parent;
    const entry = ts.isIdentifier(node) ? namespaces.get(node.text) : undefined;
    if (
      entry &&
      entry.names !== "all" &&
      !ts.isNamespaceImport(parent) &&
      !((ts.isPropertyAssignment(parent) || ts.isPropertyAccessExpression(parent)) && parent.name === node)
    ) {
      if (ts.isPropertyAccessExpression(parent) && parent.expression === node) entry.names.add(parent.name.text);
      else entry.names = "all";
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return source;
}

const files = codeIn(".");
const product = files.filter((path) => !path.startsWith("test/"));
const sources = new Map(files.map((path) => [path, read(path)]));

const areaOf = (path: string): string | undefined =>
  Object.keys(MAY_IMPORT)
    .filter((area) => path === area || path.startsWith(`${area}/`))
    .sort((a, b) => b.length - a.length)[0];

const packageOf = (spec: string): string | undefined =>
  PACKAGES.find((name) => spec === name || spec.startsWith(`${name}/`));

test("every file of the plugin is in an area that MAY_IMPORT names, and an area imports only what MAY_IMPORT allows it", () => {
  assert.deepEqual(
    product.filter((path) => !areaOf(path)),
    [],
    "Add its area to MAY_IMPORT, with the areas it may import.",
  );
  const found = new Set<string>();
  for (const path of product) {
    const area = areaOf(path)!;
    for (const { to } of sources.get(path)!.imports) {
      const inside = sources.has(to);
      const reached = inside ? areaOf(to) : packageOf(to);
      if (!inside && !reached) continue;
      if (reached === area || (reached && MAY_IMPORT[area]!.includes(reached))) continue;
      found.add(`${path} > ${inside ? to : reached}`);
    }
  }
  assert.deepEqual([...found], [], "That area may not import this one: move the code to where both may reach it.");
});

/** Tarjan's strongly connected components over the plugin's own imports, type-only ones included. */
function cycles(): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const found: string[][] = [];
  const next = (path: string) =>
    [...new Set(sources.get(path)!.imports.map((entry) => entry.to))].filter(
      (to) => sources.has(to) && !to.startsWith("test/"),
    );
  const visit = (path: string) => {
    index.set(path, index.size);
    low.set(path, index.get(path)!);
    stack.push(path);
    for (const to of next(path)) {
      if (!index.has(to)) visit(to);
      if (stack.includes(to)) low.set(path, Math.min(low.get(path)!, low.get(to)!));
    }
    if (low.get(path) !== index.get(path)) return;
    const group = stack.splice(stack.indexOf(path));
    if (group.length > 1 || next(path).includes(path)) found.push(group.sort());
  };
  for (const path of product) if (!index.has(path)) visit(path);
  return found;
}

test("no module of the plugin imports itself back through others", () => {
  assert.deepEqual(
    cycles(),
    [],
    "Each group imports itself round a cycle: move what both sides need to a module neither imports.",
  );
});

test("only the daemon log writes to the console, so what the plugin says there is in one place with one prefix", () => {
  const writers = product.filter(
    (path) =>
      (path.startsWith("server/") || path === "index.server.ts") &&
      path !== "server/core/logger.ts" &&
      /\bconsole\./.test(readFileSync(join(PLUGIN, path), "utf-8")),
  );
  assert.deepEqual(writers, [], "Write through daemonLog in server/core/logger.ts.");
});

test("everything the plugin exports is imported by another file", () => {
  const used = new Map<string, Set<string> | "all">();
  for (const { imports } of sources.values()) {
    for (const { to, names } of imports) {
      const seen = used.get(to);
      if (seen !== "all") used.set(to, names === "all" ? "all" : new Set([...(seen ?? []), ...names]));
    }
  }
  const unused = product.flatMap((path) => {
    const seen = used.get(path);
    if (seen === "all") return [];
    return [...sources.get(path)!.exports]
      .filter(([name]) => !seen?.has(name) && !(name === "default" && ENTRIES.includes(path)))
      .map(([name, line]) => `${path}:${line} ${name}`);
  });
  assert.deepEqual(unused, [], "Drop the export of what only its own file uses, and delete what nothing uses.");
});

test("the plugin's code names no agent, MCP server or sensor its catalog describes, apart from what NAMED still lists", () => {
  const sensors = readdirSync(join(PLUGIN, "catalog", "sensor")).map((name) => name.replace(/\.json$/, ""));
  const names = [...readdirSync(join(PLUGIN, "harness")), ...readdirSync(join(PLUGIN, "catalog", "mcp")), ...sensors];
  const found = new Set<string>();
  for (const path of product) {
    for (const name of names)
      if (sources.get(path)!.words.some((word) => new RegExp(`\\b${name}\\b`, "i").test(word)))
        found.add(`${path} > ${name}`);
  }
  const problems = [
    ...[...found]
      .filter((entry) => !NAMED.includes(entry))
      .map(
        (entry) =>
          `${entry}: an agent, a server or a sensor is data; say what the code needs of it in its catalog file instead. NAMED only ever shrinks.`,
      ),
    ...NAMED.filter((entry) => !found.has(entry)).map((entry) => `${entry} is gone: take it off NAMED.`),
  ];
  assert.deepEqual(problems, []);
});
