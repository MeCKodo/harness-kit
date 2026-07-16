import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installHooksCmd } from "../src/commands/install-hooks";
import { syncCmd } from "../src/commands/sync";
import { inspectAgentHookStatus } from "../src/hook-status";
import { manualValidationSession, recordValidationEvidence } from "../src/validation-state";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

const MANIFEST = `spec: ai-harness/v0
identity:
  name: hook-fixture
  summary: lifecycle hook fixture
capabilities:
  test:
    run: 'node -e "if (process.env.HK_TEST_FAIL) { console.error(process.env.HK_TEST_MESSAGE); process.exit(1) }"'
modules:
  - name: core
    role: fixture code
    entry: [src/core.ts]
    owns: [src/**]
    tests: [test/**]
    checks: [test]
    test_touch: required
validation:
  required_coverage: [src/**]
  policies:
    test_touch_default: advisory
`;

function write(repo: string, rel: string, content: string): void {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function commit(repo: string, message: string): void {
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.name=Harness Test", "-c", "user.email=harness@example.test", "commit", "-qm", message], {
    cwd: repo,
  });
}

function fixture(manifest = MANIFEST): string {
  const repo = mkdtempSync(join(tmpdir(), "hk-hook-event-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  write(repo, ".agents/manifest.yaml", manifest);
  write(repo, "src/core.ts", "export const value = 1;\n");
  write(repo, "test/core.test.ts", "// initial coverage\n");
  syncCmd(repo);
  commit(repo, "initial");
  return repo;
}

function hook(
  repo: string,
  agent: "claude" | "cursor" | "codex",
  event: "session-start" | "stop",
  payload: Record<string, unknown>,
  env: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(TSX, [CLI, "hook-event", "--repo", repo, "--agent", agent, "--event", event], {
    cwd: repo,
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function installedHook(
  repo: string,
  agent: "claude" | "cursor" | "codex",
  event: "session-start" | "stop",
  payload: Record<string, unknown>,
  env: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
  const runner = join(repo, ".agents", "hooks", "harness-agent-hook.sh");
  const result = spawnSync("bash", [runner, agent, event], {
    cwd: repo,
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, HARNESS_KIT_CMD: `${TSX} ${CLI}`, ...env },
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

test("thin Stop without SessionStart asks for deliver, never a new session", () => {
  const repo = fixture();
  write(repo, "src/core.ts", "export const value = 2;\n");
  const claude = hook(repo, "claude", "stop", { session_id: "no-session-start" });
  assert.equal(claude.status, 0);
  assert.equal(JSON.parse(claude.stdout).decision, "block");
  assert.match(JSON.parse(claude.stdout).reason, /harness-kit deliver/);
  assert.doesNotMatch(JSON.parse(claude.stdout).reason, /Start a new agent session|SessionStart baseline/);

  const cursor = hook(repo, "cursor", "stop", { conversation_id: "no-session-start" });
  assert.equal(cursor.status, 0);
  assert.match(JSON.parse(cursor.stdout).followup_message, /harness-kit deliver/);
  assert.doesNotMatch(JSON.parse(cursor.stdout).followup_message, /Start a new agent session/);
});

test("thin Stop allows clean trees and accepted deliver stamps", () => {
  const repo = fixture();
  // Clean: allow without SessionStart.
  const clean = hook(repo, "claude", "stop", { session_id: "clean-1" });
  assert.equal(clean.status, 0);
  assert.equal(clean.stdout.trim(), "");

  write(repo, "src/core.ts", "export const value = 2;\n");
  write(repo, "test/core.test.ts", "// covers 2\n");
  const blocked = hook(repo, "claude", "stop", { session_id: "dirty-1" });
  assert.equal(JSON.parse(blocked.stdout).decision, "block");

  const delivered = spawnSync(TSX, [CLI, "deliver", "--repo", repo, "--json"], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.equal(delivered.status, 0, delivered.stderr + delivered.stdout);
  const allowed = hook(repo, "claude", "stop", { session_id: "dirty-1" });
  assert.equal(allowed.status, 0);
  assert.equal(allowed.stdout.trim(), "");
});

test("execute mode: SessionStart base + Stop runs checks without demanding a new session", () => {
  const repo = fixture();
  writeFileSync(join(repo, ".git", "info", "exclude"), ".codex/\n");
  assert.equal(installHooksCmd(repo, { stop: true, agents: ["codex"] }), 0);
  commit(repo, "install lifecycle hooks");
  const payload = { session_id: "session-1" };
  const executeEnv = { HARNESS_KIT_STOP_MODE: "execute" };
  assert.equal(installedHook(repo, "codex", "session-start", payload, executeEnv).status, 0);

  write(repo, "src/core.ts", "export const value = 2;\n");
  write(repo, "test/core.test.ts", "// covers value 2\n");
  commit(repo, "task change");

  // Resumed SessionStart must keep the original task/session base.
  assert.equal(installedHook(repo, "codex", "session-start", payload, executeEnv).status, 0);

  const failed = installedHook(
    repo,
    "codex",
    "stop",
    { ...payload, stop_hook_active: true },
    { ...executeEnv, HK_TEST_FAIL: "1", HK_TEST_MESSAGE: "backend assertion exploded" },
  );
  assert.equal(failed.status, 0);
  assert.equal(JSON.parse(failed.stdout).decision, "block");
  const failedReason = JSON.parse(failed.stdout).reason as string;
  assert.match(failedReason, /check test failed/);
  assert.match(failedReason, /run: node -e/);
  assert.match(failedReason, /backend assertion exploded/);
  assert.doesNotMatch(failedReason, /Start a new agent session|Prove the lifecycle Hook in a fresh Agent session/);

  const passed = installedHook(repo, "codex", "stop", { ...payload, stop_hook_active: true }, executeEnv);
  assert.equal(passed.status, 0);
  assert.equal(passed.stdout, "");

  const evidence = spawnSync(TSX, [CLI, "evidence", "--repo", repo, "--json"], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.equal(evidence.status, 0);
  const body = JSON.parse(evidence.stdout);
  assert.equal(body.evidence.status, "verified");
  assert.deepEqual(body.evidence.changed, ["src/core.ts", "test/core.test.ts"]);
  assert.equal(body.evidence.verifyPassed, true);
  assert.equal(body.stamp?.status, "accepted");
  assert.ok(Array.isArray(body.nextActions));
  assert.equal(
    body.nextActions.filter((a: { priority: string }) => a.priority === "required").length,
    0,
  );
  const hookStatus = inspectAgentHookStatus(repo);
  assert.equal(hookStatus.state, "active");
  assert.equal(hookStatus.evidenceAgent, "codex");
  const manual = manualValidationSession(repo, null, "manual-latest-pointer");
  recordValidationEvidence(repo, manual, {
    schema: "ai-harness/validation-evidence/v1",
    status: "verified",
    ok: true,
    requestedBase: "HEAD",
    resolvedBase: null,
    fingerprint: "stale-manual-fingerprint",
    changed: [],
    affected: [],
    checks: [],
    gaps: [],
    notes: [],
    waivers: [],
    errors: [],
    createdAt: new Date().toISOString(),
    runChecksStatus: "verified",
    verifyPassed: true,
  });
  assert.equal(inspectAgentHookStatus(repo).state, "active", "manual commands must not hide valid hook evidence");

  const hooksPath = join(repo, ".codex", "hooks.json");
  const originalHooks = readFileSync(hooksPath, "utf8");
  const overridden = JSON.parse(originalHooks);
  overridden.hooks.SessionStart[0].hooks[0].command =
    `HARNESS_KIT_CMD=true ${overridden.hooks.SessionStart[0].hooks[0].command}`;
  overridden.hooks.Stop[0].hooks[0].command = `HARNESS_KIT_CMD=true ${overridden.hooks.Stop[0].hooks[0].command}`;
  writeFileSync(hooksPath, JSON.stringify(overridden));
  assert.equal(inspectAgentHookStatus(repo).state, "degraded");
  const rebound = spawnSync(TSX, [CLI, "evidence", "--repo", repo, "--session", body.session, "--json"], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.equal(rebound.status, 0, "delivery stamp remains valid even when it no longer proves Hook ACTIVE");
  assert.equal(JSON.parse(rebound.stdout).valid, true);
  assert.equal(JSON.parse(rebound.stdout).hookActive, false);
  writeFileSync(hooksPath, originalHooks);
  assert.equal(inspectAgentHookStatus(repo).state, "active");

  write(repo, "src/core.ts", "export const value = 3;\n");
  const stale = spawnSync(TSX, [CLI, "evidence", "--repo", repo, "--session", body.session, "--json"], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.equal(stale.status, 1);
  assert.equal(JSON.parse(stale.stdout).stale, true);
  assert.equal(inspectAgentHookStatus(repo).state, "degraded");
});

test("Codex linked dispatcher: config change without code changes does not demand a new session", () => {
  const main = fixture();
  const linked = join(mkdtempSync(join(tmpdir(), "hk-hook-event-linked-parent-")), "linked");
  execFileSync("git", ["worktree", "add", "-q", "--detach", linked, "HEAD"], { cwd: main });
  const codexHome = mkdtempSync(join(tmpdir(), "hk-hook-event-codex-home-"));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    assert.equal(
      installHooksCmd(linked, { stop: true, agents: ["codex"], allowUserDispatcher: true }),
      0,
    );
    const dispatcher = join(codexHome, "harness-kit", "codex-linked-dispatch-v1.cjs");
    const env = { ...process.env, HARNESS_KIT_CMD: `${TSX} ${CLI}`, HARNESS_KIT_STOP_MODE: "execute" };
    const payload = JSON.stringify({ session_id: "linked-session" });
    const start = spawnSync(process.execPath, [dispatcher, "session-start"], {
      cwd: linked,
      input: payload,
      encoding: "utf8",
      env,
    });
    assert.equal(start.status, 0, start.stderr);

    writeFileSync(dispatcher, readFileSync(dispatcher, "utf8") + "// changed after SessionStart\n");
    // No repo code change → deliver no-change / thin allow path must not ask for a new session.
    const stop = spawnSync(process.execPath, [dispatcher, "stop"], {
      cwd: linked,
      input: payload,
      encoding: "utf8",
      env,
    });
    assert.equal(stop.status, 0, stop.stderr);
    if (stop.stdout.trim()) {
      const body = JSON.parse(stop.stdout);
      assert.doesNotMatch(body.reason ?? body.followup_message ?? "", /Start a new agent session/);
    }
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});

test("a hung verify contract is timed out early enough to return the client's blocking protocol", () => {
  const repo = fixture(`${MANIFEST}
contracts:
  - id: hung-contract
    kind: other
    desc: timeout fixture
    check: 'node -e "setTimeout(() => {}, 5000)"'
`);
  const payload = { session_id: "hung-verify" };
  assert.equal(hook(repo, "claude", "session-start", payload).status, 0);
  write(repo, "src/core.ts", "export const value = 2;\n");
  write(repo, "test/core.test.ts", "// covers value 2\n");

  const started = Date.now();
  const stopped = hook(repo, "claude", "stop", payload, {
    HARNESS_KIT_VERIFY_BUDGET_MS: "75",
    HARNESS_KIT_STOP_MODE: "execute",
  });
  assert.ok(Date.now() - started < 3_000, "hook returns before the client-level timeout");
  assert.equal(stopped.status, 0);
  const response = JSON.parse(stopped.stdout);
  assert.equal(response.decision, "block");
  assert.match(response.reason, /timed out|budget exhausted/);
});
