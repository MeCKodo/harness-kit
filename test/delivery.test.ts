import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveChangeScope, startTaskRecord, readTaskRecord } from "../src/delivery";
import { deliverCmd } from "../src/commands/deliver";
import { syncCmd } from "../src/commands/sync";

function write(repo: string, rel: string, content: string): void {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function commit(repo: string, message: string): void {
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync(
    "git",
    ["-c", "user.name=Harness Test", "-c", "user.email=harness@example.test", "commit", "-qm", message],
    { cwd: repo },
  );
}

function fixture(): string {
  const repo = mkdtempSync(join(tmpdir(), "hk-delivery-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  write(
    repo,
    ".agents/manifest.yaml",
    `spec: ai-harness/v0
identity:
  name: delivery-fixture
  summary: delivery scope fixture
capabilities:
  test:
    run: 'node -e "if (process.env.HK_TEST_FAIL) process.exit(1)"'
modules:
  - name: core
    role: fixture
    entry: [src/core.ts]
    owns: [src/**]
    tests: [test/**]
    checks: [test]
    test_touch: required
`,
  );
  write(repo, "src/core.ts", "export const value = 1;\n");
  write(repo, "test/core.test.ts", "// coverage\n");
  syncCmd(repo);
  commit(repo, "initial");
  return repo;
}

function captureJson(fn: () => number): { code: number; json: any } {
  const chunks: string[] = [];
  const orig = process.stdout.write.bind(process.stdout);
  (process.stdout as any).write = (s: string) => {
    chunks.push(String(s));
    return true;
  };
  let code: number;
  try {
    code = fn();
  } finally {
    (process.stdout as any).write = orig;
  }
  return { code, json: JSON.parse(chunks.join("")) };
}

test("resolveChangeScope: worktree dirty falls back to HEAD exact diff", () => {
  const repo = fixture();
  write(repo, "src/core.ts", "export const value = 2;\n");
  const scope = resolveChangeScope(repo);
  assert.equal(scope.kind, "worktree");
  assert.equal(scope.base, "HEAD");
  assert.ok(scope.changes.files.includes("src/core.ts"));
});

test("resolveChangeScope: task base covers later commits", () => {
  const repo = fixture();
  const started = startTaskRecord({ repo, note: "feature" });
  assert.equal(readTaskRecord(repo)?.baseSha, started.baseSha);
  write(repo, "src/core.ts", "export const value = 2;\n");
  write(repo, "test/core.test.ts", "// covers 2\n");
  commit(repo, "task commit");
  const scope = resolveChangeScope(repo);
  assert.equal(scope.kind, "task");
  assert.deepEqual(scope.changes.files.sort(), ["src/core.ts", "test/core.test.ts"]);
});

test("resolveChangeScope: clean worktree is empty without task", () => {
  const repo = fixture();
  const scope = resolveChangeScope(repo);
  assert.equal(scope.kind, "worktree");
  assert.equal(scope.changes.files.length, 0);
});

test("deliver accepts worktree changes and stamps evidence", () => {
  const repo = fixture();
  write(repo, "src/core.ts", "export const value = 2;\n");
  write(repo, "test/core.test.ts", "// covers 2\n");
  const { code, json } = captureJson(() => deliverCmd(repo, { json: true }));
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.status, "accepted");
  assert.equal(json.scope, "worktree");
  assert.equal(json.ok, true);
  assert.equal(json.verifyPassed, true);
});

test("deliver reports needs-work when checks fail", () => {
  const repo = fixture();
  write(repo, "src/core.ts", "export const value = 2;\n");
  write(repo, "test/core.test.ts", "// covers 2\n");
  const prev = process.env.HK_TEST_FAIL;
  process.env.HK_TEST_FAIL = "1";
  try {
    const { code, json } = captureJson(() => deliverCmd(repo, { json: true }));
    assert.equal(code, 1);
    assert.equal(json.status, "needs-work");
    assert.ok(json.next.some((step: string) => /deliver/.test(step)));
  } finally {
    if (prev === undefined) delete process.env.HK_TEST_FAIL;
    else process.env.HK_TEST_FAIL = prev;
  }
});

test("deliver no-change on clean tree", () => {
  const repo = fixture();
  const { code, json } = captureJson(() => deliverCmd(repo, { json: true }));
  assert.equal(code, 0, JSON.stringify(json));
  assert.equal(json.status, "no-change");
});
