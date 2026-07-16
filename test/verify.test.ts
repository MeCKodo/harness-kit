import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { syncCmd } from "../src/commands/sync";
import { loadManifest } from "../src/manifest";
import { renderClaudeMd } from "../src/render";
import { recordContextReview } from "../src/state";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

function write(repo: string, rel: string, content: string): void {
  const path = join(repo, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function runVerify(repo: string): { status: number; body: any; stdout: string; stderr: string } {
  const result = spawnSync(TSX, [CLI, "verify", "--repo", repo, "--json"], { encoding: "utf8" });
  return { status: result.status ?? -1, body: JSON.parse(result.stdout), stdout: result.stdout, stderr: result.stderr };
}

function runVerifyText(repo: string, details = false): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(TSX, [CLI, "verify", "--repo", repo, ...(details ? ["--details"] : [])], { encoding: "utf8" });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

test("verify --json emits one structured document", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-verify-json-"));
  write(repo, ".agents/manifest.yaml", "spec: ai-harness/v0\nidentity: { name: json, summary: json fixture }\n");
  syncCmd(repo);
  const result = runVerify(repo);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.body.schema, "ai-harness/verify-report/v1");
  assert.equal(result.body.ok, true);
  assert.equal(result.body.failures, 0);
  assert.deepEqual(result.body.manifestErrors, []);
  assert.deepEqual(result.body.context, []);
  assert.equal(result.body.hooks.state, "degraded");
  assert.ok(result.body.hooks.issues.some((issue: string) => /runner|not installed|not configured/.test(issue)));
  assert.deepEqual(result.body.gapSummary, { total: 0, recommended: 0, informational: 0 });
  assert.deepEqual(result.body.gapDetails, []);
  assert.equal(result.body.nextActions[0].id, "optional-install-lifecycle-hooks");
  assert.equal(result.body.nextActions[0].owner, "agent");
  assert.equal(result.body.nextActions[0].priority, "recommended");
  assert.ok(Array.isArray(result.body.messages));
  assert.ok(result.body.messages.some((message: any) => /validation checks require matching run-checks evidence/.test(message.text)));
});

test("verify fails closed when required validation gate coverage is empty", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-verify-gate-"));
  write(repo, "src/page.ts", "export const page = 1;\n");
  write(
    repo,
    ".agents/manifest.yaml",
    `spec: ai-harness/v1
identity: { name: verify-gate, summary: gate fixture }
capabilities:
  e2e: { run: "true" }
modules:
  - name: renderer
    role: renderer
    entry: [src/page.ts]
    owns: [src/**]
    gates: [flow]
validation:
  gates:
    flow:
      checks: [e2e]
      acceptance:
        tests: [e2e/**]
        test_touch: required
`,
  );
  syncCmd(repo);

  const result = runVerify(repo);
  assert.equal(result.status, 1);
  assert.equal(result.body.ok, false);
  assert.ok(result.body.messages.some((message: any) => /validation gate flow.*matches 0 files/.test(message.text)));
});

test("verify collapses on-demand boundaries by default and explains them with --details", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-verify-guidance-"));
  write(
    repo,
    ".agents/manifest.yaml",
    `spec: ai-harness/v0
identity: { name: guidance, summary: guidance fixture }
capabilities:
  release: { run: "npm publish", mutating: true }
  dev: { run: "vite", background: true }
invariants:
  - { id: manual-policy, rule: "review policy", manual: true }
  - { id: missing-gate, rule: "enforce policy" }
contracts:
  - { id: manual-api, kind: api, desc: manual, manual_verify: "exercise real endpoint" }
  - { id: unchecked-api, kind: api, desc: unchecked }
`,
  );
  syncCmd(repo);

  const compact = runVerifyText(repo);
  assert.equal(compact.status, 0, compact.stderr + compact.stdout);
  assert.match(compact.stdout, /6 declared: 2 automation improvement\(s\), 4 check\(s\) only when relevant/);
  assert.match(compact.stdout, /details: `harness-kit verify --details`/);
  assert.doesNotMatch(compact.stdout, /Add enforcement for invariant missing-gate/);
  // Hooks are optional recommended maintenance; deliver is the task gate.
  assert.match(compact.stdout, /Harness readiness: READY|recommended maintenance/);

  const detailed = runVerifyText(repo, true);
  assert.equal(detailed.status, 0, detailed.stderr + detailed.stdout);
  assert.match(detailed.stdout, /\[RECOMMENDED\] Add enforcement for invariant missing-gate/);
  assert.match(detailed.stdout, /\[INFORMATIONAL\] Run release only when deliberately requested/);
  assert.match(detailed.stdout, /\[RECOMMENDED \| AGENT\] Improve 2 verification declaration\(s\)/);

  const json = runVerify(repo).body;
  assert.deepEqual(json.gapSummary, { total: 6, recommended: 2, informational: 4 });
  assert.equal(json.gaps.length, 6, "legacy flat gaps remain available");
  assert.equal(json.gapDetails.find((gap: any) => gap.scope === "release").classification, "informational");
});

test("unknown manifest spec fails closed in verify JSON", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-verify-spec-"));
  write(repo, ".agents/manifest.yaml", "spec: ai-harness/v999\nidentity: { name: future, summary: future fixture }\n");
  const result = runVerify(repo);
  assert.equal(result.status, 1);
  assert.equal(result.body.ok, false);
  assert.ok(result.body.manifestErrors.some((message: string) => /v999/.test(message)));
});

test("malformed manifest YAML still returns the structured verify failure contract", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-verify-yaml-"));
  write(repo, ".agents/manifest.yaml", "identity: [unterminated\n");
  const result = runVerify(repo);
  assert.equal(result.status, 1);
  assert.equal(result.body.schema, "ai-harness/verify-report/v1");
  assert.equal(result.body.ok, false);
  assert.ok(result.body.manifestErrors.length > 0);
});

test("oversized path_glob fails as one manifest-error JSON document without reaching fast-glob", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-verify-glob-"));
  write(
    repo,
    ".agents/manifest.yaml",
    JSON.stringify({
      spec: "ai-harness/v0",
      identity: { name: "glob", summary: "glob fixture" },
      invariants: [
        { id: "oversized", rule: "safe matcher", enforcement: { forbid_pattern: ["bad"], path_glob: ["a".repeat(70_000)] } },
      ],
    }),
  );

  const result = runVerify(repo);
  assert.equal(result.status, 1);
  assert.equal(result.body.schema, "ai-harness/verify-report/v1");
  assert.equal(result.body.ok, false);
  assert.ok(result.body.manifestErrors.some((message: string) => /path_glob.*过长.*安全编译/.test(message)));
  assert.equal(result.stdout.trim().split("\n").length, 1);
});

test("a directory at a contract snapshot path becomes one structured verify failure", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-verify-contract-dir-"));
  write(
    repo,
    ".agents/manifest.yaml",
    JSON.stringify({
      spec: "ai-harness/v0",
      identity: { name: "contract-dir", summary: "contract directory fixture" },
      contracts: [{ id: "http-api", kind: "api", desc: "HTTP API", snapshot: "printf stable" }],
    }),
  );
  syncCmd(repo);
  mkdirSync(join(repo, ".agents/contracts/http-api.snapshot"), { recursive: true });

  const result = runVerify(repo);
  assert.equal(result.status, 1);
  assert.equal(result.body.schema, "ai-harness/verify-report/v1");
  assert.equal(result.body.ok, false);
  assert.ok(result.body.messages.some((message: { text: string }) => /http-api.*contract filesystem.*regular file/.test(message.text)));
  assert.equal(result.stdout.trim().split("\n").length, 1);
});

test("corrupt context state fails inside verify JSON instead of breaking the output protocol", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-verify-state-"));
  write(repo, "src/api.ts", "export const route = '/v1';\n");
  write(repo, ".agents/knowledge/api.md", "API notes.\n");
  write(
    repo,
    ".agents/manifest.yaml",
    "spec: ai-harness/v0\nidentity: { name: state, summary: state fixture }\nknowledge: [{ path: knowledge/api.md, authority: derived, binds: [src/api.ts] }]\n",
  );
  syncCmd(repo);
  write(repo, ".agents/.harness-state.json", "{broken\n");
  const result = runVerify(repo);
  assert.equal(result.status, 1);
  assert.equal(result.body.schema, "ai-harness/verify-report/v1");
  assert.ok(result.body.messages.some((message: { text: string }) => /context freshness.*JSON|context freshness.*state/i.test(message.text)));
});

test("explicit context drift blocks verify until the Agent records a review", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-verify-context-"));
  write(repo, "src/api.ts", "export const route = '/v1';\n");
  write(repo, "engineering/api.md", "The route is /v1.\n");
  write(
    repo,
    ".agents/manifest.yaml",
    `spec: ai-harness/v0
identity: { name: context, summary: context fixture }
knowledge:
  - root: repo
    path: engineering/api.md
    authority: derived
    binds: [src/api.ts]
`,
  );
  syncCmd(repo);
  const blocked = runVerify(repo);
  assert.equal(blocked.status, 1);
  assert.equal(blocked.body.context[0].severity, "blocking");
  assert.match(blocked.body.context[0].reason, /尚未记录复核/);

  recordContextReview(repo, loadManifest(repo), { path: "engineering/api.md", reason: "checked against current implementation" });
  const passed = runVerify(repo);
  assert.equal(passed.status, 0, JSON.stringify(passed.body));
});

test("verify rejects a content-matching but unsafe generated-file symlink", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-verify-link-"));
  write(repo, ".agents/manifest.yaml", "spec: ai-harness/v0\nidentity: { name: link, summary: link fixture }\n");
  syncCmd(repo);
  const expectedClaude = join(repo, "CLAUDE.md");
  const elsewhere = join(repo, "elsewhere.md");
  writeFileSync(elsewhere, renderClaudeMd());
  unlinkSync(expectedClaude);
  symlinkSync("elsewhere.md", expectedClaude);

  const result = runVerify(repo);
  assert.equal(result.status, 1);
  assert.ok(result.body.messages.some((message: { text: string }) => /unsafe symlink/.test(message.text)));
});

test("verify JSON stays structured when an Agent hook config path is not a regular project file", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-verify-hook-dir-"));
  write(repo, ".agents/manifest.yaml", "spec: ai-harness/v0\nidentity: { name: hook-dir }\n");
  syncCmd(repo);
  mkdirSync(join(repo, ".codex", "hooks.json"), { recursive: true });

  const result = runVerify(repo);
  assert.equal(result.status, 0, JSON.stringify(result.body));
  assert.equal(result.body.schema, "ai-harness/verify-report/v1");
  assert.equal(result.body.hooks.state, "degraded");
  assert.ok(result.body.hooks.issues.some((issue: string) => /safe project-local regular file/.test(issue)));
});
