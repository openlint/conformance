#!/usr/bin/env node
// OpenLint conformance runner (prototype).
// Runs every case in cases/ through each tool adapter, normalizes the results
// to {code, path}, compares with expected.json and writes results/matrix.json
// and results/matrix.md.
//
// Usage: node run.mjs [--bin <dir with openlint, spectral, vacuum binaries>]
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, mkdtempSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const binArg = process.argv.indexOf("--bin");
const bin = binArg > -1 ? process.argv[binArg + 1] : join(root, "node_modules/.bin");

// Each adapter returns Spectral-model results: [{code, path: [..], severity}]
function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    // linters exit non-zero when they find results; stdout still holds them
    if (e.stdout) return e.stdout;
    throw e;
  }
}
function parseJson(out) {
  const start = out.indexOf("[");
  return start === -1 ? [] : JSON.parse(out.slice(start));
}
// Tools that cannot read the case's ruleset.yaml use a native equivalent
// next to it. A case without one is reported as unsupported for that tool.
class Unsupported extends Error {}
const native = (rs, file) => {
  const p = join(dirname(rs), file);
  if (!existsSync(p)) throw new Unsupported(`no ${file}`);
  return p;
};
const fromPointer = (ptr) =>
  ptr.replace(/^#\//, "").split("/").map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~")).filter(Boolean);
const adapters = {
  openlint: (rs, doc) => parseJson(run(join(bin, "openlint"), ["lint", doc, "-r", rs, "-f", "json", "--quiet"])),
  spectral: (rs, doc) => parseJson(run(join(bin, "spectral"), ["lint", doc, "-r", rs, "-f", "json", "--quiet"])),
  vacuum: (rs, doc) => {
    const out = join(mkdtempSync(join(tmpdir(), "vac-")), "r.json");
    run(join(bin, "vacuum"), ["spectral-report", "-r", rs, doc, out]);
    return JSON.parse(readFileSync(out, "utf8"));
  },
  ibm: (rs, doc) => {
    const out = JSON.parse(run(join(bin, "lint-openapi"), ["-r", rs, "-j", doc]));
    return ["error", "warning", "info", "hint"].flatMap((s) => out[s]?.results ?? []).map((r) => ({ code: r.rule, path: r.path }));
  },
  insomnia: (rs, doc) => {
    // inso has no JSON output: "15:10 - Error - <code> - <message> - <dot.path>"
    const inso = existsSync(join(bin, "inso")) ? join(bin, "inso") : "inso";
    return run(inso, ["lint", "spec", doc, "-r", rs]).split("\n")
      .map((l) => l.match(/^\s*\d+:\d+ - \w+ - (\S+) - .* - (\S+)\s*$/))
      .filter(Boolean)
      .map(([, code, path]) => ({ code, path: [path] }));
  },
  redocly: (rs, doc) => {
    const out = JSON.parse(run(join(bin, "redocly"), ["lint", doc, "--config", native(rs, "redocly.yaml"), "--format", "json"]));
    return out.problems.map((p) => ({ code: p.ruleId.replace(/^rule\//, ""), path: fromPointer(p.location[0].pointer) }));
  },
};

const key = (r) => `${r.code} @ ${r.path}`;
function normalize(results) {
  return [...new Set(results.map((r) => key({ code: r.code, path: (r.path || []).join(".") })))].sort();
}

function listCases(dir, prefix = "") {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (!statSync(p).isDirectory()) return [];
    return readdirSync(p).includes("expected.json") ? [prefix + n] : listCases(p, prefix + n + "/");
  });
}

function version(tool) {
  const cmd = { ibm: "lint-openapi", insomnia: "inso" }[tool] ?? tool;
  const exe = existsSync(join(bin, cmd)) ? join(bin, cmd) : cmd;
  const args = tool === "vacuum" ? ["version"] : ["--version"];
  try {
    const v = run(exe, args).trim().split("\n").find((l) => /\d+\.\d+/.test(l)) ?? "unknown";
    return v.replace(/^validator: ([^;]+);.*/, "$1");
  } catch { return "unknown"; }
}

const cases = listCases(join(root, "cases"));
const tools = Object.keys(adapters);
const matrix = { generated: new Date().toISOString(), tools, versions: Object.fromEntries(tools.map((t) => [t, version(t)])), cases: [] };
for (const name of cases) {
  const dir = join(root, "cases", name);
  const spec = JSON.parse(readFileSync(join(dir, "expected.json"), "utf8"));
  const expected = spec.expected.map(key).sort();
  const row = { case: name, description: spec.description, results: {} };
  for (const [tool, adapter] of Object.entries(adapters)) {
    let got, error;
    try {
      got = normalize(adapter(join(dir, "ruleset.yaml"), join(dir, "document.yaml")));
    } catch (e) {
      if (e instanceof Unsupported) {
        row.results[tool] = { status: "unsupported", error: e.message };
        continue;
      }
      const lines = String(e.stderr || e.message).split("\n");
      error = lines.find((l) => /error/i.test(l) && !/DeprecationWarning/.test(l)) || lines.find(Boolean);
    }
    // exact: same rule codes at the same paths. detected: same number of
    // results per rule code, wherever the tool chose to report them.
    const codes = (keys) => keys.map((k) => k.split(" @ ")[0]).sort().join(",");
    const status = error ? "error"
      : JSON.stringify(got) === JSON.stringify(expected) ? "exact"
      : codes(got) === codes(expected) ? "detected" : "fail";
    row.results[tool] = error
      ? { status, error }
      : { status, missing: expected.filter((k) => !got.includes(k)), extra: got.filter((k) => !expected.includes(k)) };
  }
  matrix.cases.push(row);
}

mkdirSync(join(root, "results"), { recursive: true });
writeFileSync(join(root, "results/matrix.json"), JSON.stringify(matrix, null, 2));
const icon = { exact: "✅", detected: "🟡", fail: "❌", error: "⚠️", unsupported: "➖" };
const lines = [`| Case | ${matrix.tools.join(" | ")} |`, `|---|${matrix.tools.map(() => "---").join("|")}|`];
for (const r of matrix.cases) lines.push(`| ${r.case} | ${matrix.tools.map((t) => icon[r.results[t].status]).join(" | ")} |`);
const count = (t, ...s) => matrix.cases.filter((r) => s.includes(r.results[t].status)).length;
const totals = matrix.tools.map((t) => `${t} ${count(t, "exact")} exact, ${count(t, "exact", "detected")} detected / ${matrix.cases.length}`);
writeFileSync(join(root, "results/matrix.md"), lines.join("\n") + `\n\n✅ exact (same rule, same path) · 🟡 detected (same rule and count, different path) · ❌ fail · ⚠️ error · ➖ unsupported\n\n${totals.join(" · ")}\n`);
console.log(readFileSync(join(root, "results/matrix.md"), "utf8"));
