#!/usr/bin/env node
// OpenLint conformance runner.
//
// Two suites:
//   spec     the conformance tests published with the specification
//            (openlint/spec, v1/conformance/**/test.json), each tied to the
//            requirements it checks
//   interop  extra cases in cases/ that compare tools on common rules,
//            including tools that need a native translation (Redocly)
//
// Every test runs through every tool adapter. Results are written to
// results/matrix.json and results/matrix.md.
//
// Usage: node run.mjs [--bin <dir with tool binaries>] [--spec <path to v1/conformance>]
import { execFileSync, execFile } from "node:child_process";
import { cpus } from "node:os";
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, mkdtempSync, existsSync } from "node:fs";
import { join, dirname, basename, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const bin = arg("--bin", join(root, "node_modules/.bin"));
const specDir = arg("--spec", join(root, "spec/v1/conformance"));

function run(cmd, args, cwd) {
  try {
    return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000 });
  } catch (e) {
    // linters exit non-zero when they find results; stdout still holds them
    if (e.stdout) return e.stdout;
    throw e;
  }
}
const exe = (name) => (existsSync(join(bin, name)) ? join(bin, name) : name);

// A tool that cannot run a ruleset at all (it rejected it) throws Rejected.
// A tool whose rule format cannot express the test throws Unsupported.
class Rejected extends Error {}
class Unsupported extends Error {}

// Spectral-model JSON on stdout: an array of results. Anything else means the
// ruleset or document was rejected before linting.
function spectralJson(out, err) {
  const start = out.indexOf("[");
  if (start === -1) throw new Rejected(firstLine(err) || "no results output");
  return JSON.parse(out.slice(start));
}
function firstLine(s) {
  return String(s || "").split("\n").map((l) => l.trim()).find((l) => l && !/DeprecationWarning|trace-deprecation/.test(l));
}
function capture(cmd, args, cwd) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, encoding: "utf8", timeout: 60000, maxBuffer: 64 * 1024 * 1024 }, (e, out, err) =>
      resolve({ out: out || "", err: err || (e && !out ? e.message : "") }));
  });
}
const native = (dir, file) => {
  const p = join(dir, file);
  if (!existsSync(p)) throw new Unsupported(`needs a native ${file}`);
  return p;
};
const fromPointer = (ptr) =>
  ptr.replace(/^#\//, "").split("/").map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~")).filter(Boolean);
const severityNumber = { error: 0, warn: 1, warning: 1, info: 2, information: 2, hint: 3 };

// Each adapter returns Spectral-model results:
// [{code, path: [..], severity: 0-3, message, range, source}]
const adapters = {
  openlint: async ({ ruleset, document, dir }) => {
    const { out, err } = await capture(exe("openlint"), ["lint", document, "-r", ruleset, "-f", "json", "--quiet"], dir);
    return spectralJson(out, err);
  },
  spectral: async ({ ruleset, document, dir }) => {
    const { out, err } = await capture(exe("spectral"), ["lint", document, "-r", ruleset, "-f", "json", "--quiet"], dir);
    return spectralJson(out, err);
  },
  vacuum: async ({ ruleset, document, dir }) => {
    const file = join(mkdtempSync(join(tmpdir(), "vac-")), "r.json");
    const { err } = await capture(exe("vacuum"), ["spectral-report", "-r", ruleset, document, file], dir);
    if (/failed to parse specification/.test(err)) throw new Unsupported("only lints OpenAPI documents");
    if (!existsSync(file)) throw new Rejected(firstLine(err) || "no report written");
    return JSON.parse(readFileSync(file, "utf8"));
  },
  ibm: async ({ ruleset, document, dir }) => {
    const { out, err } = await capture(exe("lint-openapi"), ["-r", ruleset, "-j", document], dir);
    if (/Invalid input file/.test(out + err)) throw new Unsupported("only lints OpenAPI documents");
    // IBM reports an unreadable ruleset, then lints with its own default
    // ruleset and exits 0. Count the report as a rejection.
    if (/Problems reading Spectral ruleset/.test(out + err)) throw new Rejected("reported the ruleset as invalid, then fell back to IBM's default ruleset");
    const start = out.indexOf("{");
    if (start === -1) throw new Rejected(firstLine(err) || "no results output");
    const json = JSON.parse(out.slice(start));
    return ["error", "warning", "info", "hint"].flatMap((s) =>
      (json[s]?.results ?? []).map((r) => ({ code: r.rule, path: r.path, severity: severityNumber[s], message: r.message })));
  },
  insomnia: async ({ ruleset, document, dir }) => {
    // inso has no JSON output: "15:10 - Error - <code> - <message> - <dot.path>"
    const { out, err } = await capture(exe("inso"), ["lint", "spec", document, "-r", ruleset], dir);
    if (/FATAL/.test(out + err) && !/lint errors found/.test(out + err)) throw new Rejected(firstLine((out + err).match(/FATAL.*/)?.[0]));
    return out.split("\n")
      .map((l) => l.match(/^\s*(\d+):(\d+) - (\w+) - (\S+) - (.*) - (\S+)\s*$/))
      .filter(Boolean)
      .map(([, , , sev, code, message, path]) => ({ code, message, severity: severityNumber[sev.toLowerCase()], path: [path] }));
  },
  redocly: async ({ document, dir }) => {
    const config = native(dir, "redocly.yaml");
    const { out, err } = await capture(exe("redocly"), ["lint", document, "--config", config, "--format", "json"], dir);
    const start = out.indexOf("{");
    if (start === -1) throw new Rejected(firstLine(err) || "no results output");
    return JSON.parse(out.slice(start)).problems.map((p) => ({
      code: p.ruleId.replace(/^rule\//, ""),
      path: fromPointer(p.location[0].pointer),
      severity: severityNumber[p.severity],
      message: p.message,
    }));
  },
};
const tools = Object.keys(adapters);

// Tools that report a path as a single dotted string (inso) compare on the
// joined form.
const joinPath = (p) => (Array.isArray(p) ? p.join(".") : String(p ?? ""));

function matches(exp, act, ctx) {
  for (const [k, v] of Object.entries(exp)) {
    if (k === "has") {
      if (!v.every((f) => act[f] !== undefined)) return false;
    } else if (k === "path") {
      if (joinPath(v) !== joinPath(act.path)) return false;
    } else if (k === "source") {
      const want = v === "${document}" ? ctx.document : v;
      if (!act.source || basename(String(act.source)) !== basename(want)) return false;
    } else if (JSON.stringify(v) !== JSON.stringify(act[k])) {
      return false;
    }
  }
  return true;
}

// exact: every expected result matched by a distinct actual result, with no
// extras (and in order, when the test says so). detected: the same rule codes
// with the same counts, whatever the paths, messages or ranges.
function compare(expect, got, ctx) {
  const exp = expect.results;
  let exact;
  if (got.length !== exp.length) exact = false;
  else if (expect.ordered) exact = exp.every((e, i) => matches(e, got[i], ctx));
  else {
    const used = new Set();
    const assign = (i) => {
      if (i === exp.length) return true;
      for (let j = 0; j < got.length; j++) {
        if (used.has(j) || !matches(exp[i], got[j], ctx)) continue;
        used.add(j);
        if (assign(i + 1)) return true;
        used.delete(j);
      }
      return false;
    };
    exact = assign(0);
  }
  if (exact) return { status: "exact" };
  const codes = (rs) => rs.map((r) => r.code ?? "*").sort();
  const wantCodes = codes(exp);
  const gotCodes = codes(got);
  const detected = exp.every((e) => e.code !== undefined)
    ? JSON.stringify(wantCodes) === JSON.stringify(gotCodes)
    : got.length === exp.length;
  const summary = (rs) => rs.map((r) => `${r.code ?? "*"} @ ${joinPath(r.path)}`);
  return { status: detected ? "detected" : "fail", expected: summary(exp), got: summary(got) };
}

// A ruleset-only test still needs a document to lint.
const stubDir = mkdtempSync(join(tmpdir(), "stub-"));
const stubDoc = join(stubDir, "document.yaml");
writeFileSync(stubDoc, "openapi: 3.1.0\ninfo:\n  title: Stub\n  version: 1.0.0\npaths: {}\n");

async function runTest(test, tool) {
  const ctx = { document: test.document ?? stubDoc };
  let got, rejectedWhy;
  try {
    got = await adapters[tool]({ ruleset: test.ruleset, document: ctx.document, dir: test.dir });
  } catch (e) {
    if (e instanceof Unsupported) return { status: "unsupported", note: e.message };
    if (e instanceof Rejected) { got = null; rejectedWhy = e.message; }
    else return { status: "error", note: firstLine(e.stderr || e.message) };
  }
  const { expect } = test;
  if (expect.ruleset === "valid" || expect.ruleset === "invalid" || expect.rejected) {
    const wantRejected = expect.ruleset === "invalid" || expect.rejected === true;
    return got === null === wantRejected
      ? { status: "exact" }
      : { status: "fail", note: wantRejected ? "accepted a ruleset the spec says to reject" : "rejected a valid ruleset" };
  }
  if (got === null) return { status: "error", note: rejectedWhy || "rejected the ruleset or document" };
  return compare(expect, got, ctx);
}

function walk(dir, file) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (!statSync(p).isDirectory()) return [];
    return existsSync(join(p, file)) ? [p] : walk(p, file);
  });
}

function loadSpecTests() {
  if (!existsSync(specDir)) return [];
  return walk(specDir, "test.json").sort().map((dir) => {
    const t = JSON.parse(readFileSync(join(dir, "test.json"), "utf8"));
    return {
      id: relative(specDir, dir),
      for: t.for,
      purpose: t.purpose,
      dir,
      ruleset: join(dir, t.ruleset),
      document: t.document ? join(dir, t.document) : undefined,
      expect: t.expect,
    };
  });
}

function loadInteropTests() {
  return walk(join(root, "cases"), "expected.json").sort().map((dir) => {
    const t = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8"));
    return {
      id: relative(join(root, "cases"), dir),
      purpose: t.description,
      dir,
      ruleset: join(dir, "ruleset.yaml"),
      document: join(dir, "document.yaml"),
      expect: { results: t.expected },
    };
  });
}

function version(tool) {
  const cmd = { ibm: "lint-openapi", insomnia: "inso" }[tool] ?? tool;
  const args = tool === "vacuum" ? ["version"] : ["--version"];
  try {
    const v = run(exe(cmd), args).trim().split("\n").find((l) => /\d+\.\d+/.test(l)) ?? "unknown";
    return v.replace(/^validator: ([^;]+);.*/, "$1");
  } catch {
    return "unknown";
  }
}

function specRef() {
  try {
    const repo = join(specDir, "../..");
    return execFileSync("git", ["-C", repo, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

const suites = { spec: loadSpecTests(), interop: loadInteropTests() };
const matrix = {
  generated: new Date().toISOString(),
  tools,
  versions: Object.fromEntries(tools.map((t) => [t, version(t)])),
  spec: { repo: "https://github.com/openlint/spec", ref: specRef() },
  suites: {},
};
// Run every (test, tool) pair through a small worker pool.
async function pool(jobs, size) {
  let next = 0;
  await Promise.all(Array.from({ length: size }, async () => {
    while (next < jobs.length) await jobs[next++]();
  }));
}
const jobs = [];
for (const [name, tests] of Object.entries(suites)) {
  matrix.suites[name] = tests.map((t) => {
    const row = { id: t.id, for: t.for, purpose: t.purpose, results: {} };
    for (const tool of tools) {
      jobs.push(async () => {
        row.results[tool] = await runTest(t, tool);
        process.stderr.write(".");
      });
    }
    return row;
  });
}
await pool(jobs, Math.max(2, cpus().length));
process.stderr.write("\n");

mkdirSync(join(root, "results"), { recursive: true });
writeFileSync(join(root, "results/matrix.json"), JSON.stringify(matrix, null, 2));

const statuses = ["exact", "detected", "fail", "error", "unsupported"];
const lines = [];
for (const [name, rows] of Object.entries(matrix.suites)) {
  lines.push(`## ${name} (${rows.length} tests)`, "", `| Tool | ${statuses.join(" | ")} |`, `|---|${statuses.map(() => "---").join("|")}|`);
  for (const tool of tools) {
    const c = Object.fromEntries(statuses.map((s) => [s, rows.filter((r) => r.results[tool].status === s).length]));
    lines.push(`| ${tool} ${matrix.versions[tool]} | ${statuses.map((s) => c[s]).join(" | ")} |`);
  }
  lines.push("");
}
writeFileSync(join(root, "results/matrix.md"), lines.join("\n"));
console.log(lines.join("\n"));
