// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { matches, compare } from "../run.mjs";

const ctx = { document: "/fixtures/document.yaml" };
const range = { start: { line: 0, character: 0 }, end: { line: 2, character: 4 } };
const result = { code: "root-falsy", range };

test("range fixtures can assert either endpoint or both", () => {
  for (const expected of [{ start: range.start }, { end: range.end }, range]) {
    assert.equal(matches({ range: expected }, result, ctx), true);
  }
  assert.equal(compare({ results: [{ code: "root-falsy", range: { start: range.start } }] }, [result], ctx).status, "exact");
});

test("an asserted endpoint must match each coordinate", () => {
  for (const endpoint of ["start", "end"]) {
    for (const coordinate of ["line", "character"]) {
      const expected = { ...range[endpoint], [coordinate]: range[endpoint][coordinate] + 1 };
      assert.equal(matches({ range: { [endpoint]: expected } }, result, ctx), false);
    }
  }
});

test("actual ranges require both endpoints, even when a fixture checks only one", () => {
  for (const actual of [undefined, null, {}, { start: range.start }, { end: range.end }]) {
    assert.equal(matches({ range: { start: range.start } }, { range: actual }, ctx), false);
  }
});

test("actual positions require non-negative integer coordinates", () => {
  for (const endpoint of ["start", "end"]) {
    for (const coordinate of ["line", "character"]) {
      for (const value of [-1, 0.5, "0", null, undefined, NaN, Infinity]) {
        const actual = structuredClone(range);
        actual[endpoint][coordinate] = value;
        assert.equal(matches({ range: { start: range.start } }, { range: actual }, ctx), false);
      }
    }
  }
});

test("a range cannot end before it starts", () => {
  const start = { line: 2, character: 4 };
  for (const end of [{ line: 1, character: 20 }, { line: 2, character: 3 }]) {
    assert.equal(matches({ range: { start } }, { range: { start, end } }, ctx), false);
  }
  for (const end of [start, { line: 2, character: 5 }, { line: 3, character: 0 }]) {
    assert.equal(matches({ range: { start } }, { range: { start, end } }, ctx), true);
  }
});

test("partial range matching still checks the other result fields", () => {
  const actual = { ...result, path: ["info", "title"], severity: 1, message: "Missing title", source: ctx.document };
  const expected = { ...actual, range: { start: range.start }, source: "${document}", has: ["range", "source"] };
  assert.equal(matches(expected, actual, ctx), true);
  for (const [field, value] of Object.entries({ code: "other", path: ["paths"], severity: 0, message: "other", source: "/other.yaml", has: ["missing"] })) {
    assert.equal(matches({ ...expected, [field]: value }, actual, ctx), false);
  }
});

test("comparison still checks result counts, distinct matches and ordering", () => {
  const expected = { results: [{ code: "a" }, { code: "b", range: { start: range.start } }] };
  const actual = [{ code: "b", range }, { code: "a" }];
  assert.equal(compare(expected, actual, ctx).status, "exact");
  assert.equal(compare({ ...expected, ordered: true }, actual, ctx).status, "detected");
  assert.equal(compare(expected, [...actual, result], ctx).status, "fail");
  assert.equal(compare({ results: [{ code: "a" }, { code: "a" }] }, actual, ctx).status, "fail");
});

// Run the real adapter against a tiny CLI. This tests argv, report parsing and
// rejection handling without installing vacuum or any other linter.
function invokeVacuum(t, behavior) {
  const dir = mkdtempSync(join(tmpdir(), "conformance adapter "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const executable = join(dir, "vacuum");
  const argsFile = join(dir, "args.json");
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(process.env.ADAPTER_TEST_ARGS, JSON.stringify({ args, cwd: process.cwd() }));
switch (process.env.ADAPTER_TEST_BEHAVIOR) {
  case "parse-error": console.error("failed to parse specification"); process.exit(2);
  case "ruleset-error": console.error("invalid ruleset"); process.exit(2);
  case "missing-report": process.exit(0);
  case "malformed-report": fs.writeFileSync(args.at(-1), "not JSON"); break;
  default: fs.writeFileSync(args.at(-1), process.env.ADAPTER_TEST_BEHAVIOR); process.exit(1);
}
`);
  chmodSync(executable, 0o755);
  const ruleset = join(dir, "custom rules.yaml");
  const document = join(dir, "plain data.yaml");
  const script = `
    const { adapters } = await import(${JSON.stringify(new URL("../run.mjs", import.meta.url).href)});
    try {
      console.log(JSON.stringify({ results: await adapters.vacuum(${JSON.stringify({ ruleset, document, dir })}) }));
    } catch (error) {
      console.log(JSON.stringify({ error: error.constructor.name, message: error.message }));
    }
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script, "--", "--bin", dir], {
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env, ADAPTER_TEST_ARGS: argsFile, ADAPTER_TEST_BEHAVIOR: behavior },
  });
  const { args, cwd } = JSON.parse(readFileSync(argsFile, "utf8"));
  t.after(() => rmSync(dirname(args.at(-1)), { recursive: true, force: true }));
  assert.deepEqual(args.slice(0, -1), ["spectral-report", "--openlint", "-r", ruleset, document]);
  assert.equal(basename(args.at(-1)), "r.json");
  assert.equal(realpathSync(cwd), realpathSync(dir));
  return JSON.parse(output);
}

test("vacuum runs in OpenLint mode and reads a report despite a non-zero lint exit", (t) => {
  assert.deepEqual(invokeVacuum(t, JSON.stringify([result])), { results: [result] });
});

test("vacuum accepts an empty results report", (t) => {
  assert.deepEqual(invokeVacuum(t, "[]"), { results: [] });
});

test("vacuum parse failures are rejected inputs, not unsupported document formats", (t) => {
  assert.deepEqual(invokeVacuum(t, "parse-error"), { error: "Rejected", message: "failed to parse specification" });
});

test("vacuum ruleset failures remain rejections", (t) => {
  assert.deepEqual(invokeVacuum(t, "ruleset-error"), { error: "Rejected", message: "invalid ruleset" });
});

test("vacuum requires a report even when the process succeeds", (t) => {
  assert.deepEqual(invokeVacuum(t, "missing-report"), { error: "Rejected", message: "no report written" });
});

test("vacuum malformed reports remain errors", (t) => {
  assert.equal(invokeVacuum(t, "malformed-report").error, "SyntaxError");
});

test("the CLI runs through absolute paths and symlinks", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "conformance entry "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runner = join(dir, "run.mjs");
  const link = join(dir, "linked-runner.mjs");
  copyFileSync(new URL("../run.mjs", import.meta.url), runner);
  symlinkSync(runner, link);
  mkdirSync(join(dir, "cases"));
  mkdirSync(join(dir, "spec"));
  const tools = ["openlint", "spectral", "vacuum", "lint-openapi", "inso", "redocly"];
  for (const tool of tools) {
    const executable = join(dir, tool);
    writeFileSync(executable, '#!/usr/bin/env node\nconsole.log("1.0.0");\n');
    chmodSync(executable, 0o755);
  }
  for (const entry of [runner, link]) {
    execFileSync(process.execPath, [entry, "--bin", dir, "--spec", join(dir, "spec")], {
      encoding: "utf8", timeout: 10000,
    });
    const matrix = JSON.parse(readFileSync(join(dir, "results/matrix.json"), "utf8"));
    assert.deepEqual(matrix.suites, { spec: [], interop: [] });
    assert.equal(matrix.tools.length, tools.length);
    rmSync(join(dir, "results"), { recursive: true });
  }
});
