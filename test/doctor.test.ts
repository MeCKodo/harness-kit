import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { doctorCmd } from "../src/commands/doctor";
import { syncCmd } from "../src/commands/sync";
import { loadManifest } from "../src/manifest";
import { recordContextReview } from "../src/state";

function write(repo: string, rel: string, content: string): void {
  const path = join(repo, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function capture(fn: () => number): { code: number; output: string } {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (chunk: string | Uint8Array) => boolean }).write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    return { code: fn(), output: chunks.join("") };
  } finally {
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = original;
  }
}

test("doctor accepts arbitrary repo-root knowledge, routing globs, and intentional empty enforcement", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-doctor-v03-"));
  write(repo, "src/api/route.ts", "export const route = '/v1';\n");
  write(repo, "engineering/handbook/api.md", "API notes.\n");
  write(
    repo,
    ".agents/manifest.yaml",
    `spec: ai-harness/v0
identity: { name: doctor-v03, summary: doctor fixture }
knowledge:
  - { root: repo, path: engineering/handbook/api.md, role: api }
routing:
  - { when: change-api, read: ['src/api/**/*.ts'], entry: ['src/api/*.ts'] }
invariants:
  - id: intentionally-absent
    rule: removed workspace stays removed
    enforcement:
      path_glob: [pnpm-workspace.yaml]
      forbid_pattern: [packages]
      allow_empty: true
`,
  );
  syncCmd(repo);
  const result = capture(() => doctorCmd(repo));
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /knowledge: engineering\/handbook\/api\.md/);
  assert.doesNotMatch(result.output, /passes without checking anything/);
  assert.match(result.output, /Agent lifecycle hooks[\s\S]*DEGRADED/);
  assert.match(result.output, /NEXT ACTIONS[\s\S]*nothing required now/);
  assert.match(result.output, /recommended maintenance action/);
  assert.match(result.output, /doctor: repository configuration healthy/);
  assert.match(result.output, /Harness readiness: READY/);
});

test("doctor keeps informational boundaries compact and expands maintenance work on request", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-doctor-guidance-"));
  write(
    repo,
    ".agents/manifest.yaml",
    `spec: ai-harness/v0
identity: { name: doctor-guidance, summary: doctor guidance fixture }
invariants:
  - { id: manual-policy, rule: "review policy", manual: true }
  - { id: missing-gate, rule: "enforce policy" }
`,
  );
  syncCmd(repo);

  const compact = capture(() => doctorCmd(repo));
  assert.equal(compact.code, 0, compact.output);
  assert.match(compact.output, /2 declared: 1 automation improvement\(s\), 1 check\(s\) only when relevant/);
  assert.doesNotMatch(compact.output, /Add enforcement for invariant missing-gate/);

  const detailed = capture(() => doctorCmd(repo, { details: true }));
  assert.equal(detailed.code, 0, detailed.output);
  assert.match(detailed.output, /\[RECOMMENDED\] Add enforcement for invariant missing-gate/);
  assert.match(detailed.output, /\[INFORMATIONAL\] Review invariant manual-policy when relevant/);
  assert.match(detailed.output, /\[RECOMMENDED \| AGENT\] Improve 1 verification declaration\(s\)/);
});

test("explicit authority is blocking until record-context-review is recorded", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-doctor-context-"));
  write(repo, "src/api.ts", "export const route = '/v1';\n");
  write(repo, "engineering/api.md", "API notes.\n");
  write(
    repo,
    ".agents/manifest.yaml",
    `spec: ai-harness/v0
identity: { name: doctor-context, summary: context fixture }
knowledge:
  - root: repo
    path: engineering/api.md
    role: api
    authority: derived
    binds: [src/api.ts]
`,
  );
  syncCmd(repo);
  const before = capture(() => doctorCmd(repo));
  assert.equal(before.code, 1);
  assert.match(before.output, /尚未记录复核/);

  const manifest = loadManifest(repo);
  recordContextReview(repo, manifest, { path: "engineering/api.md", reason: "compared against current route implementation" });
  const after = capture(() => doctorCmd(repo));
  assert.equal(after.code, 0, after.output);
});

test("a routing glob that matches nothing is an actionable doctor error", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-doctor-route-"));
  write(
    repo,
    ".agents/manifest.yaml",
    `spec: ai-harness/v0
identity: { name: doctor-route, summary: route fixture }
routing:
  - { when: missing, read: ['nowhere/**/*.ts'] }
`,
  );
  syncCmd(repo);
  const result = capture(() => doctorCmd(repo));
  assert.equal(result.code, 1);
  assert.match(result.output, /routing.*glob.*0 paths/);
});

test("doctor treats only the semantic CLAUDE.md -> AGENTS.md alias as in sync", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-doctor-alias-"));
  write(repo, ".agents/manifest.yaml", "spec: ai-harness/v0\nidentity: { name: alias, summary: alias fixture }\n");
  symlinkSync("AGENTS.md", join(repo, "CLAUDE.md"));
  syncCmd(repo);

  const result = capture(() => doctorCmd(repo));
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /CLAUDE\.md.*semantic alias|CLAUDE\.md in sync/);
});

test("doctor blocks a required validation gate whose acceptance glob matches no tests", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-doctor-gate-"));
  write(repo, "src/renderer/page.ts", "export const page = 1;\n");
  write(
    repo,
    ".agents/manifest.yaml",
    `spec: ai-harness/v1
identity: { name: doctor-gate, summary: validation gate fixture }
capabilities:
  e2e: { run: "true" }
modules:
  - name: renderer
    role: renderer UI
    entry: [src/renderer/page.ts]
    owns: [src/renderer/**]
    gates: [user-flow]
validation:
  gates:
    user-flow:
      checks: [e2e]
      acceptance:
        tests: [e2e/**]
        test_touch: required
`,
  );
  syncCmd(repo);

  const missing = capture(() => doctorCmd(repo));
  assert.equal(missing.code, 1);
  assert.match(missing.output, /validation gate user-flow.*acceptance.*0 files.*required/i);

  write(repo, "e2e/user-flow.spec.ts", "// acceptance coverage\n");
  const covered = capture(() => doctorCmd(repo));
  assert.equal(covered.code, 0, covered.output);
});

test("doctor does not accept validation coverage reached through a symlink outside the repository", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-doctor-gate-symlink-"));
  const outside = mkdtempSync(join(tmpdir(), "hk-doctor-gate-outside-"));
  write(repo, "src/renderer/page.ts", "export const page = 1;\n");
  write(outside, "flow.spec.ts", "// outside acceptance coverage\n");
  symlinkSync(outside, join(repo, "e2e"), "dir");
  write(
    repo,
    ".agents/manifest.yaml",
    `spec: ai-harness/v1
identity: { name: symlink-gate, summary: validation gate symlink fixture }
capabilities:
  e2e: { run: "true" }
modules:
  - name: renderer
    role: renderer UI
    entry: [src/renderer/page.ts]
    owns: [src/renderer/**]
    gates: [user-flow]
validation:
  gates:
    user-flow:
      checks: [e2e]
      acceptance:
        tests: [e2e/**]
        test_touch: required
`,
  );
  syncCmd(repo);

  const result = capture(() => doctorCmd(repo));
  assert.equal(result.code, 1);
  assert.match(result.output, /validation gate user-flow.*acceptance.*0 files.*required/i);
});

test("doctor does not let an in-repository symlink alias bypass gate boundary overlap", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-doctor-gate-alias-"));
  write(repo, "src/renderer/page.ts", "export const page = 1;\n");
  write(repo, "test/flow.spec.ts", "// unit coverage cannot double as gate acceptance\n");
  symlinkSync(join(repo, "test"), join(repo, "e2e"), "dir");
  write(
    repo,
    ".agents/manifest.yaml",
    `spec: ai-harness/v1
identity: { name: alias-gate, summary: validation gate symlink alias fixture }
capabilities:
  e2e: { run: "true" }
modules:
  - name: renderer
    role: renderer UI
    entry: [src/renderer/page.ts]
    owns: [src/renderer/**]
    tests: [test/**]
    gates: [user-flow]
validation:
  gates:
    user-flow:
      checks: [e2e]
      acceptance:
        tests: [e2e/**]
        test_touch: required
`,
  );
  syncCmd(repo);

  const result = capture(() => doctorCmd(repo));
  assert.equal(result.code, 1);
  assert.match(result.output, /validation gate user-flow.*acceptance.*0 files.*required/i);
});

test("doctor blocks a check-only gate whose module owns no real files", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-doctor-gate-dead-owns-"));
  write(repo, "src/page.ts", "export const page = 1;\n");
  write(
    repo,
    ".agents/manifest.yaml",
    `spec: ai-harness/v1
identity: { name: dead-owns-gate, summary: check-only gate fixture }
capabilities:
  e2e: { run: "true" }
modules:
  - name: renderer
    role: renderer UI
    entry: [src/page.ts]
    owns: [src/renderer/**]
    gates: [user-flow]
validation:
  gates:
    user-flow:
      checks: [e2e]
`,
  );
  syncCmd(repo);

  const result = capture(() => doctorCmd(repo));
  assert.equal(result.code, 1);
  assert.match(result.output, /validation gate user-flow.*module renderer owns matches 0 files.*cannot activate this gate/i);
});

test("doctor blocks required acceptance files that overlap module unit or production boundaries", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-doctor-gate-overlap-"));
  write(repo, "src/page.ts", "export const page = 1;\n");
  write(repo, "test/page.test.ts", "// unit\n");
  write(
    repo,
    ".agents/manifest.yaml",
    `spec: ai-harness/v1
identity: { name: overlap, summary: overlap fixture }
capabilities:
  e2e: { run: "true" }
modules:
  - name: renderer
    role: renderer
    entry: [src/page.ts]
    owns: [src/**]
    tests: [test/**]
    gates: [flow]
validation:
  gates:
    flow:
      checks: [e2e]
      acceptance:
        tests: [test/**]
        test_touch: required
`,
  );
  syncCmd(repo);

  const result = capture(() => doctorCmd(repo));
  assert.equal(result.code, 1);
  assert.match(result.output, /validation gate flow.*overlap module renderer owns\/tests.*unit or production files cannot satisfy/i);
});
