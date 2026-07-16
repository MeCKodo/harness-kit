import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitAdminDir } from "../src/git";
import { evidenceCmd } from "../src/commands/evidence";
import { runChecksCmd } from "../src/commands/run-checks";
import { syncCmd } from "../src/commands/sync";
import { verifyCmd } from "../src/commands/verify";
import {
  manualValidationSession,
  markLatestVerifyResult,
  readLatestValidationSession,
  readValidationSession,
  recordValidationEvidence,
  startValidationSession,
} from "../src/validation-state";

test("validation sessions live in private Git-admin state, not the worktree", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-state-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const session = startValidationSession({
    repo,
    agent: "codex",
    sessionId: "conversation-1",
    baseSha: null,
    initialFingerprint: "abc",
    initialDirty: [],
  });
  const path = join(gitAdminDir(repo), "harness-kit", "validation", `${session.token}.json`);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(readValidationSession(repo, session.token)?.sessionId, "conversation-1");
});

test("validation evidence expires after the seven-day retention window", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-state-expired-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const session = startValidationSession({
    repo,
    agent: "cursor",
    sessionId: "old-conversation",
    baseSha: null,
    initialFingerprint: "abc",
    initialDirty: [],
  });
  const path = join(gitAdminDir(repo), "harness-kit", "validation", `${session.token}.json`);
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  utimesSync(path, old, old);

  assert.equal(readValidationSession(repo, session.token), null);
  assert.equal(existsSync(path), false);
});

test("manual latest-evidence pointers are isolated between harness targets in one Git worktree", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-state-targets-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const first = join(repo, "packages", "first");
  const second = join(repo, "packages", "second");
  mkdirSync(first, { recursive: true });
  mkdirSync(second, { recursive: true });
  const firstSession = manualValidationSession(first, null, "first");
  const secondSession = manualValidationSession(second, null, "second");

  assert.equal(readLatestValidationSession(first)?.token, firstSession.token);
  assert.equal(readLatestValidationSession(second)?.token, secondSession.token);
  assert.notEqual(firstSession.token, secondSession.token);
});

test("a failed verify downgrades otherwise-green run-checks evidence", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-state-verify-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const session = startValidationSession({
    repo,
    agent: "claude",
    sessionId: "conversation-2",
    baseSha: null,
    initialFingerprint: "abc",
    initialDirty: [],
  });
  recordValidationEvidence(repo, session, {
    schema: "ai-harness/validation-evidence/v1",
    status: "verified",
    ok: true,
    requestedBase: "HEAD",
    resolvedBase: null,
    fingerprint: "abc",
    planFingerprint: "plan-v1",
    changed: ["src/a.ts"],
    affected: ["a"],
    checks: [{ id: "test", status: "passed", exitCode: 0, durationMs: 1 }],
    gaps: [],
    notes: [],
    waivers: [],
    errors: [],
    createdAt: new Date().toISOString(),
  });
  markLatestVerifyResult(repo, session.token, false);
  const evidence = readValidationSession(repo, session.token)?.lastEvidence;
  assert.equal(evidence?.runChecksStatus, "verified");
  assert.equal(evidence?.verifyPassed, false);
  assert.equal(evidence?.status, "not-verified");
  assert.equal(evidence?.ok, false);

  markLatestVerifyResult(repo, session.token, true);
  const recovered = readValidationSession(repo, session.token)?.lastEvidence;
  assert.equal(recovered?.status, "verified");
  assert.equal(recovered?.ok, true);

  const original = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];
  (process.stdout as unknown as { write: (chunk: string | Uint8Array) => boolean }).write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  let code: number;
  try {
    code = evidenceCmd(repo, { json: true, session: session.token });
  } finally {
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = original;
  }
  assert.equal(code, 1, "JSON and human evidence modes share failure exit semantics");
  assert.equal(JSON.parse(chunks.join("")).valid, false);
});

test("standalone verify completes matching manual delivery evidence", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-state-manual-verify-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  mkdirSync(join(repo, ".agents"), { recursive: true });
  mkdirSync(join(repo, "src"), { recursive: true });
  mkdirSync(join(repo, "test"), { recursive: true });
  writeFileSync(
    join(repo, ".agents", "manifest.yaml"),
    `spec: ai-harness/v0
identity: { name: fixture, summary: fixture }
capabilities:
  test: { run: "true" }
modules:
  - name: core
    role: fixture
    entry: [src/a.ts]
    owns: [src/**]
    tests: [test/**]
    checks: [test]
    test_touch: required
`,
  );
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, "test", "a.test.ts"), "// initial\n");
  syncCmd(repo);
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.name=Harness Test", "-c", "user.email=harness@example.test", "commit", "-qm", "initial"], {
    cwd: repo,
  });
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  writeFileSync(join(repo, "src", "a.ts"), "export const a = 2;\n");
  writeFileSync(join(repo, "test", "a.test.ts"), "// covers 2\n");

  const original = process.stdout.write.bind(process.stdout);
  const capture = (fn: () => number): { code: number; output: string } => {
    const output: string[] = [];
    (process.stdout as unknown as { write: (chunk: string | Uint8Array) => boolean }).write = (chunk) => {
      output.push(String(chunk));
      return true;
    };
    try {
      return { code: fn(), output: output.join("") };
    } finally {
      (process.stdout as unknown as { write: typeof process.stdout.write }).write = original;
    }
  };

  assert.equal(capture(() => runChecksCmd(repo, { base, json: true })).code, 0);
  const before = capture(() => evidenceCmd(repo, { json: true }));
  assert.equal(before.code, 1);
  assert.equal(JSON.parse(before.output).runChecksValid, true);
  assert.equal(JSON.parse(before.output).valid, false);
  assert.ok(JSON.parse(before.output).nextActions.some((action: any) => action.id === "complete-verify"));

  assert.equal(capture(() => verifyCmd(repo)).code, 0);
  const after = capture(() => evidenceCmd(repo, { json: true }));
  assert.equal(after.code, 0);
  assert.equal(JSON.parse(after.output).valid, true);
  assert.equal(JSON.parse(after.output).evidence.verifyPassed, true);
  assert.ok(
    JSON.parse(after.output).nextActions.every((action: any) => action.priority !== "required" || action.id === "record-delivery-evidence") ||
      JSON.parse(after.output).nextActions.filter((a: any) => a.priority === "required").length === 0,
  );
  assert.ok(JSON.parse(after.output).nextActions.some((action: any) => action.id === "optional-install-lifecycle-hooks"));

  const session = readLatestValidationSession(repo)!;
  const currentEvidence = session.lastEvidence!;
  const { planFingerprint: _oldPlan, verifyPassed: _oldVerify, runChecksStatus: _oldStatus, ...legacyEvidence } = currentEvidence;
  recordValidationEvidence(repo, session, legacyEvidence);
  assert.equal(capture(() => verifyCmd(repo)).code, 0, "repository verification itself still passes");
  const legacy = capture(() => evidenceCmd(repo, { json: true }));
  assert.equal(legacy.code, 1, "pre-plan-binding evidence cannot be revived by a new verify");
  assert.equal(JSON.parse(legacy.output).planStale, true);
  assert.equal(JSON.parse(legacy.output).valid, false);
  assert.match(JSON.parse(legacy.output).refreshError, /predates plan fingerprint binding/);
});

test("missing evidence JSON tells an Agent exactly how to create and prove it", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-state-no-evidence-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const original = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];
  (process.stdout as unknown as { write: (chunk: string | Uint8Array) => boolean }).write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  let code: number;
  try {
    code = evidenceCmd(repo, { json: true });
  } finally {
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = original;
  }
  assert.equal(code, 1);
  const body = JSON.parse(chunks.join(""));
  assert.equal(body.found, false);
  assert.ok(body.nextActions.some((action: any) => action.id === "record-delivery-evidence" && action.owner === "agent"));
  assert.ok(body.nextActions.some((action: any) => /deliver/.test(action.commands?.join(" ") ?? "")));
  assert.ok(body.nextActions.some((action: any) => action.id === "optional-install-lifecycle-hooks"));
});
