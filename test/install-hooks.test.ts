import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { installHooksCmd } from "../src/commands/install-hooks";
import { installStopHooks } from "../src/commands/stop-hooks";
import { collectChanges, EMPTY_TREE_BASE } from "../src/git";
import { agentHookConfigurationFingerprint, inspectAgentHookStatus } from "../src/hook-status";
import { recordValidationEvidence, startValidationSession } from "../src/validation-state";

function freshRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "hk-hooks-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  mkdirSync(join(dir, ".agents"), { recursive: true });
  writeFileSync(join(dir, ".agents", "manifest.yaml"), "spec: ai-harness/v0\nidentity: { name: test }\n");
  return dir;
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function addLinkedWorktree(repo: string): string {
  git(repo, ["add", "."]);
  git(repo, [
    "-c",
    "user.name=Harness Kit Test",
    "-c",
    "user.email=harness-kit@example.test",
    "commit",
    "-qm",
    "initial",
  ]);
  const linked = join(mkdtempSync(join(tmpdir(), "hk-hooks-linked-parent-")), "linked");
  git(repo, ["worktree", "add", "-q", "--detach", linked, "HEAD"]);
  return linked;
}

function resolvedHooksDir(repo: string): string {
  return resolve(repo, git(repo, ["rev-parse", "--git-path", "hooks"]));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function captureOutput(run: () => number): { code: number; output: string } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    return { code: run(), output: lines.join("\n") };
  } finally {
    console.log = original;
  }
}

function recordCurrentHookEvidence(repo: string, agent: "claude" | "cursor" | "codex"): void {
  const changes = collectChanges(repo, EMPTY_TREE_BASE, { mode: "exact" });
  const session = startValidationSession({
    repo,
    agent,
    sessionId: `install-hooks-${agent}`,
    baseSha: null,
    initialFingerprint: changes.fingerprint,
    initialDirty: changes.files,
    hookConfigFingerprint: agentHookConfigurationFingerprint(repo, agent) ?? undefined,
  });
  recordValidationEvidence(repo, session, {
    schema: "ai-harness/validation-evidence/v1",
    status: "verified",
    ok: true,
    requestedBase: EMPTY_TREE_BASE,
    resolvedBase: null,
    fingerprint: changes.fingerprint,
    changed: changes.files,
    affected: [],
    checks: [],
    gaps: [],
    notes: [],
    waivers: [],
    errors: [],
    verifyPassed: true,
    runChecksStatus: "verified",
    createdAt: new Date().toISOString(),
  });
}

test("install-hooks writes managed, executable pre-commit + pre-push in a single worktree", () => {
  const dir = freshRepo();
  const code = installHooksCmd(dir, { git: true });
  assert.equal(code, 0);
  for (const name of ["pre-commit", "pre-push"]) {
    const p = join(dir, ".git", "hooks", name);
    assert.ok(existsSync(p), `${name} exists`);
    const body = readFileSync(p, "utf8");
    assert.match(body, /harness-kit-managed-hook/);
    assert.match(body, /HARNESS_KIT_CMD/);
    assert.match(body, /@erzhe\/harness-kit@\d+\.\d+\.\d+/);
    assert.ok((statSync(p).mode & 0o100) !== 0, `${name} is owner-executable`);
  }
});

test("install-hooks refuses a linked worktree and leaves the common hooks directory untouched", () => {
  const main = freshRepo();
  const linked = addLinkedWorktree(main);
  const hooks = resolvedHooksDir(linked);

  const result = captureOutput(() => installHooksCmd(linked, { git: true }));

  assert.equal(result.code, 1);
  assert.match(result.output, /multiple Git worktrees/);
  assert.match(result.output, new RegExp(escapeRegex(hooks)));
  assert.equal(existsSync(join(hooks, "pre-commit")), false);
  assert.equal(existsSync(join(hooks, "pre-push")), false);
});

test("install-hooks allows an explicit shared-hooks override", () => {
  const main = freshRepo();
  const linked = addLinkedWorktree(main);
  const hooks = resolvedHooksDir(linked);

  const code = installHooksCmd(linked, { git: true, allowSharedGitHooks: true });

  assert.equal(code, 0);
  assert.match(readFileSync(join(hooks, "pre-commit"), "utf8"), /harness-kit-managed-hook/);
  assert.match(readFileSync(join(hooks, "pre-push"), "utf8"), /harness-kit-managed-hook/);
});

test("install-hooks refuses the main worktree when it has a linked sibling", () => {
  const main = freshRepo();
  addLinkedWorktree(main);
  const hooks = resolvedHooksDir(main);

  const result = captureOutput(() => installHooksCmd(main, { git: true }));

  assert.equal(result.code, 1);
  assert.match(result.output, /multiple Git worktrees/);
  assert.match(result.output, new RegExp(escapeRegex(hooks)));
  assert.equal(existsSync(join(hooks, "pre-commit")), false);
  assert.equal(existsSync(join(hooks, "pre-push")), false);
});

test("install-hooks refuses a custom core.hooksPath and reports its config origin", () => {
  const dir = freshRepo();
  const customHooks = join(dir, "custom-hooks");
  git(dir, ["config", "core.hooksPath", customHooks]);

  const result = captureOutput(() => installHooksCmd(dir, { git: true }));

  assert.equal(result.code, 1);
  assert.match(result.output, /core\.hooksPath/);
  assert.match(result.output, /\.git\/config/);
  assert.match(result.output, new RegExp(escapeRegex(customHooks)));
  assert.equal(existsSync(join(customHooks, "pre-commit")), false);
  assert.equal(existsSync(join(customHooks, "pre-push")), false);
});

test("install-hooks refuses core.hooksPath from global config", () => {
  const dir = freshRepo();
  const configDir = mkdtempSync(join(tmpdir(), "hk-hooks-global-config-"));
  const globalConfig = join(configDir, "gitconfig");
  const globalHooks = join(configDir, "hooks");
  execFileSync("git", ["config", "--file", globalConfig, "core.hooksPath", globalHooks]);
  const previous = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  try {
    const result = captureOutput(() => installHooksCmd(dir, { git: true }));

    assert.equal(result.code, 1);
    assert.match(result.output, /core\.hooksPath/);
    assert.match(result.output, new RegExp(escapeRegex(globalConfig)));
    assert.match(result.output, new RegExp(escapeRegex(globalHooks)));
    assert.equal(existsSync(join(globalHooks, "pre-commit")), false);
    assert.equal(existsSync(join(globalHooks, "pre-push")), false);
  } finally {
    if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previous;
  }
});

test("install-hooks refuses ambiguous core.hooksPath values", () => {
  const dir = freshRepo();
  const firstHooks = join(dir, "first-hooks");
  const affectedHooks = join(dir, "affected-hooks");
  git(dir, ["config", "--add", "core.hooksPath", firstHooks]);
  git(dir, ["config", "--add", "core.hooksPath", affectedHooks]);

  const result = captureOutput(() => installHooksCmd(dir, { git: true }));

  assert.equal(result.code, 1);
  assert.match(result.output, /core\.hooksPath is ambiguous/);
  assert.match(result.output, new RegExp(escapeRegex(affectedHooks)));
  assert.equal(existsSync(join(firstHooks, "pre-commit")), false);
  assert.equal(existsSync(join(affectedHooks, "pre-commit")), false);
});

test("install-hooks refuses to clobber a foreign hook without --force", () => {
  const dir = freshRepo();
  const p = join(dir, ".git", "hooks", "pre-commit");
  writeFileSync(p, "#!/bin/sh\necho custom-hook\n");
  const code = installHooksCmd(dir, { git: true });
  assert.equal(code, 1);
  assert.match(readFileSync(p, "utf8"), /echo custom-hook/, "foreign hook left untouched");
  assert.equal(existsSync(join(dir, ".git", "hooks", "pre-push")), false, "native hook install is all-or-nothing");
});

test("install-hooks --force and shared override preserve a foreign hook", () => {
  const dir = freshRepo();
  const p = join(dir, ".git", "hooks", "pre-commit");
  writeFileSync(p, "#!/bin/sh\necho custom-hook\n");
  const code = installHooksCmd(dir, { git: true, force: true, allowSharedGitHooks: true });
  assert.equal(code, 1);
  assert.match(readFileSync(p, "utf8"), /echo custom-hook/, "force left the foreign hook untouched");
  assert.equal(existsSync(join(dir, ".git", "hooks", "pre-push")), false, "native hook install is all-or-nothing");
});

test("install-hooks --force refreshes only harness-kit-managed hooks", () => {
  const dir = freshRepo();
  assert.equal(installHooksCmd(dir, { git: true }), 0);
  const preCommitPath = join(dir, ".git", "hooks", "pre-commit");
  writeFileSync(preCommitPath, "#!/bin/sh\n# harness-kit-managed-hook\necho stale\n");

  assert.equal(installHooksCmd(dir, { git: true, force: true }), 0);

  assert.doesNotMatch(readFileSync(preCommitPath, "utf8"), /echo stale/);
  assert.match(readFileSync(preCommitPath, "utf8"), /harness-kit-managed-hook/);
});

test("install-hooks continues worktree-local Stop hooks after shared Git hooks are refused", () => {
  const main = freshRepo();
  const linked = addLinkedWorktree(main);
  const hooks = resolvedHooksDir(linked);

  const code = installHooksCmd(linked, { git: true, stop: true, agents: ["claude"] });

  assert.equal(code, 1, "the combined command reports the refused native hooks");
  assert.equal(existsSync(join(hooks, "pre-commit")), false);
  assert.equal(existsSync(join(hooks, "pre-push")), false);
  assert.ok(existsSync(join(linked, ".agents", "hooks", "harness-agent-hook.sh")), "linked worktree runner installed");
  assert.ok(existsSync(join(linked, ".claude", "settings.json")), "linked worktree agent config installed");
  assert.equal(existsSync(join(main, ".agents", "hooks", "harness-agent-hook.sh")), false, "main worktree untouched");
  assert.equal(existsSync(join(main, ".claude", "settings.json")), false, "main worktree config untouched");
});

test("Codex linked-worktree hooks refuse an ineffective project-only install", () => {
  const main = freshRepo();
  const linked = addLinkedWorktree(main);
  const codexHome = mkdtempSync(join(tmpdir(), "hk-hooks-codex-home-"));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    const result = captureOutput(() => installHooksCmd(linked, { stop: true, agents: ["codex"] }));
    assert.equal(result.code, 1);
    assert.match(result.output, /--allow-user-dispatcher/);
    assert.equal(existsSync(join(linked, ".agents", "hooks", "harness-agent-hook.sh")), false);
    assert.equal(existsSync(join(linked, ".codex", "hooks.json")), false);
    assert.equal(existsSync(join(codexHome, "hooks.json")), false);
    assert.equal(
      existsSync(join(git(linked, ["rev-parse", "--absolute-git-dir"]), "harness-kit", "codex-linked-dispatch-v1.json")),
      false,
    );
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});

test("Codex linked-worktree fallback installs project files, user dispatcher, and activation last", () => {
  const main = freshRepo();
  const linked = addLinkedWorktree(main);
  const codexHome = mkdtempSync(join(tmpdir(), "hk-hooks-codex-home-"));
  writeFileSync(
    join(codexHome, "hooks.json"),
    JSON.stringify({ hooks: { SessionStart: [{ _foreign: true, hooks: [] }], Stop: [] }, keep: true }) + "\n",
  );
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    assert.equal(
      installHooksCmd(linked, {
        stop: true,
        agents: ["codex"],
        allowUserDispatcher: true,
      }),
      0,
    );
    assert.ok(existsSync(join(linked, ".agents", "hooks", "harness-agent-hook.sh")));
    assert.ok(existsSync(join(linked, ".codex", "hooks.json")));
    assert.ok(existsSync(join(codexHome, "harness-kit", "codex-linked-dispatch-v1.cjs")));
    assert.ok(
      existsSync(join(git(linked, ["rev-parse", "--absolute-git-dir"]), "harness-kit", "codex-linked-dispatch-v1.json")),
    );
    const userHooks = JSON.parse(readFileSync(join(codexHome, "hooks.json"), "utf8"));
    assert.equal(userHooks.keep, true);
    assert.equal(userHooks.hooks.SessionStart[0]._foreign, true);
    assert.equal(userHooks.hooks.SessionStart.at(-1)._harnessKit, "codex-linked-dispatch-v1");
    assert.equal(userHooks.hooks.Stop.at(-1)._harnessKit, "codex-linked-dispatch-v1");
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});

test("Codex linked-worktree ACTIVE binds the dispatcher but ignores unrelated user hooks", () => {
  const main = freshRepo();
  const linked = addLinkedWorktree(main);
  const codexHome = mkdtempSync(join(tmpdir(), "hk-hooks-codex-home-"));
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    assert.equal(
      installHooksCmd(linked, { stop: true, agents: ["codex"], allowUserDispatcher: true }),
      0,
    );
    recordCurrentHookEvidence(linked, "codex");
    assert.equal(inspectAgentHookStatus(linked).state, "active");
    const bound = agentHookConfigurationFingerprint(linked, "codex");

    const userHooksPath = join(codexHome, "hooks.json");
    const userHooks = JSON.parse(readFileSync(userHooksPath, "utf8"));
    userHooks.hooks.SessionStart.unshift({ _foreign: true, hooks: [{ type: "command", command: "echo unrelated" }] });
    writeFileSync(userHooksPath, JSON.stringify(userHooks, null, 2) + "\n");
    assert.equal(agentHookConfigurationFingerprint(linked, "codex"), bound);
    assert.equal(inspectAgentHookStatus(linked).state, "active");

    const dispatcher = join(codexHome, "harness-kit", "codex-linked-dispatch-v1.cjs");
    writeFileSync(dispatcher, readFileSync(dispatcher, "utf8") + "// tampered\n");
    const degraded = inspectAgentHookStatus(linked);
    assert.equal(degraded.state, "degraded");
    assert.ok(degraded.issues.some((issue) => /dispatcher|configuration/i.test(issue)));
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
});

test("install-hooks --stop writes a pinned shared runner + SessionStart/Stop hooks per agent tool", () => {
  const dir = freshRepo();
  assert.equal(installHooksCmd(dir, { stop: true }), 0);

  const script = join(dir, ".agents", "hooks", "harness-agent-hook.sh");
  assert.ok(existsSync(script), "shared runner exists");
  const runner = readFileSync(script, "utf8");
  assert.match(runner, /hook-event/);
  assert.match(runner, /@erzhe\/harness-kit@\d+\.\d+\.\d+/);
  assert.ok((statSync(script).mode & 0o100) !== 0, "runner is executable");

  const claude = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
  assert.match(claude.hooks.SessionStart[0].hooks[0].command, /harness-agent-hook\.sh.*session-start/);
  assert.match(claude.hooks.Stop[0].hooks[0].command, /harness-agent-hook\.sh.*stop/);
  const cursor = JSON.parse(readFileSync(join(dir, ".cursor", "hooks.json"), "utf8"));
  assert.match(cursor.hooks.sessionStart[0].command, /harness-agent-hook\.sh.*session-start/);
  assert.match(cursor.hooks.stop[0].command, /harness-agent-hook\.sh.*stop/);
  const codex = JSON.parse(readFileSync(join(dir, ".codex", "hooks.json"), "utf8"));
  assert.match(codex.hooks.SessionStart[0].hooks[0].command, /harness-agent-hook\.sh.*session-start/);
  assert.match(codex.hooks.Stop[0].hooks[0].command, /harness-agent-hook\.sh.*stop/);
  assert.match(readFileSync(join(dir, ".codex", "config.toml"), "utf8"), /\[features\][\s\S]*hooks = true/);

  const configured = inspectAgentHookStatus(dir);
  assert.equal(configured.state, "configured");
  assert.deepEqual(configured.configuredAgents, ["claude", "cursor", "codex"]);

  unlinkSync(script);
  const degraded = inspectAgentHookStatus(dir);
  assert.equal(degraded.state, "degraded");
  assert.ok(degraded.issues.some((issue) => /runner/.test(issue)));
});

test("install-hooks --stop merges into existing config and stays idempotent", () => {
  const dir = freshRepo();
  const p = join(dir, ".claude", "settings.json");
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(p, JSON.stringify({ permissions: { allow: ["Read"] } }));

  installHooksCmd(dir, { stop: true, agents: ["claude"] });
  const once = JSON.parse(readFileSync(p, "utf8"));
  once.hooks.Stop[0].hooks.push({ type: "command", command: "echo custom-sibling" });
  writeFileSync(p, JSON.stringify(once));
  installHooksCmd(dir, { stop: true, agents: ["claude"] }); // second run must not duplicate or delete siblings

  const cfg = JSON.parse(readFileSync(p, "utf8"));
  assert.deepEqual(cfg.permissions.allow, ["Read"], "existing keys preserved");
  const ours = cfg.hooks.Stop.filter((g: any) => g.hooks?.some((h: any) => /harness-agent-hook\.sh/.test(h.command)));
  assert.equal(ours.length, 1, "our Stop hook present exactly once");
  assert.ok(cfg.hooks.Stop.some((g: any) => g.hooks?.some((h: any) => h.command === "echo custom-sibling")));
  assert.equal(cfg.hooks.SessionStart.length, 1, "our SessionStart hook present exactly once");
});

test("Agent hook install refuses a config changed after render and preserves the concurrent bytes", () => {
  const dir = freshRepo();
  const path = join(dir, ".claude", "settings.json");
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(path, JSON.stringify({ owner: "initial", mustPreserve: false }));

  const concurrent = JSON.stringify({ owner: "concurrent", mustPreserve: true });
  const result = installStopHooks(dir, ["claude"], {
    testHooks: {
      beforeTransaction: () => writeFileSync(path, concurrent),
    },
  });

  assert.equal(result, 1);
  assert.equal(readFileSync(path, "utf8"), concurrent);
  assert.equal(existsSync(join(dir, ".agents", "hooks", "harness-agent-hook.sh")), false);
});

test("hook status ignores unrelated configs for agent tools that were not selected", () => {
  const dir = freshRepo();
  mkdirSync(join(dir, ".cursor"), { recursive: true });
  writeFileSync(join(dir, ".cursor", "hooks.json"), JSON.stringify({ version: 1, hooks: { stop: [{ command: "echo foreign" }] } }));

  assert.equal(installHooksCmd(dir, { stop: true, agents: ["codex"] }), 0);
  const status = inspectAgentHookStatus(dir);
  assert.equal(status.state, "configured");
  assert.deepEqual(status.configuredAgents, ["codex"]);
  assert.doesNotMatch(status.issues.join(" "), /cursor/);
});

test("install-hooks --stop fails closed on invalid JSON", () => {
  const dir = freshRepo();
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, ".claude", "settings.json"), "{broken");
  assert.equal(installHooksCmd(dir, { stop: true, agents: ["claude"] }), 1);
  assert.equal(existsSync(join(dir, ".agents", "hooks", "harness-agent-hook.sh")), false, "preflight failure writes no runner");
});

test("Agent hook install refuses unknown existing hook shapes without changing any target", () => {
  const dir = freshRepo();
  const path = join(dir, ".claude", "settings.json");
  mkdirSync(join(dir, ".claude"), { recursive: true });
  const original = JSON.stringify({ hooks: { Stop: "run-foreign-hook" }, keep: true });
  writeFileSync(path, original);

  assert.equal(installHooksCmd(dir, { stop: true, agents: ["claude"] }), 1);
  assert.equal(readFileSync(path, "utf8"), original);
  assert.equal(existsSync(join(dir, ".agents", "hooks", "harness-agent-hook.sh")), false);
});

test("Agent hook install is all-or-nothing across selected clients", () => {
  const dir = freshRepo();
  mkdirSync(join(dir, ".cursor"), { recursive: true });
  writeFileSync(join(dir, ".cursor", "hooks.json"), "{broken");

  assert.equal(installHooksCmd(dir, { stop: true, agents: ["claude", "cursor"] }), 1);
  assert.equal(existsSync(join(dir, ".claude", "settings.json")), false);
  assert.equal(existsSync(join(dir, ".agents", "hooks", "harness-agent-hook.sh")), false);
});

test("Agent hook install refuses project config symlinks and never writes through them", () => {
  const dir = freshRepo();
  const outside = join(mkdtempSync(join(tmpdir(), "hk-hooks-outside-")), "settings.json");
  writeFileSync(outside, JSON.stringify({ keep: "outside" }));
  mkdirSync(join(dir, ".claude"), { recursive: true });
  symlinkSync(outside, join(dir, ".claude", "settings.json"));

  assert.equal(installHooksCmd(dir, { stop: true, agents: ["claude"] }), 1);
  assert.equal(readFileSync(outside, "utf8"), JSON.stringify({ keep: "outside" }));
  assert.equal(existsSync(join(dir, ".agents", "hooks", "harness-agent-hook.sh")), false);
});

test("--force never replaces a foreign Agent hook runner", () => {
  const dir = freshRepo();
  const runner = join(dir, ".agents", "hooks", "harness-agent-hook.sh");
  mkdirSync(join(dir, ".agents", "hooks"), { recursive: true });
  writeFileSync(runner, "#!/bin/sh\necho foreign-runner\n");

  assert.equal(installHooksCmd(dir, { stop: true, agents: ["codex"], force: true }), 1);
  assert.match(readFileSync(runner, "utf8"), /foreign-runner/);
  assert.equal(existsSync(join(dir, ".codex", "hooks.json")), false);
});

test("hook status ignores marker text outside an actual command field", () => {
  const dir = freshRepo();
  assert.equal(installHooksCmd(dir, { stop: true, agents: ["codex"] }), 0);
  writeFileSync(
    join(dir, ".codex", "hooks.json"),
    JSON.stringify({
      description: "harness-agent-hook.sh is documented here only",
      hooks: {
        SessionStart: [{ description: "harness-agent-hook.sh" }],
        Stop: [{ description: "harness-agent-hook.sh" }],
      },
    }),
  );

  const status = inspectAgentHookStatus(dir);
  assert.equal(status.state, "degraded");
  assert.deepEqual(status.configuredAgents, []);
});

test("hook status rejects marker-only commands even when lifecycle evidence was current", () => {
  const dir = freshRepo();
  assert.equal(installHooksCmd(dir, { stop: true, agents: ["codex"] }), 0);
  recordCurrentHookEvidence(dir, "codex");
  assert.equal(inspectAgentHookStatus(dir).state, "active");

  const path = join(dir, ".codex", "hooks.json");
  const config = JSON.parse(readFileSync(path, "utf8"));
  config.hooks.SessionStart[0].hooks[0].command = "true # harness-agent-hook.sh";
  config.hooks.Stop[0].hooks[0].command = "true # harness-agent-hook.sh";
  writeFileSync(path, JSON.stringify(config));

  const status = inspectAgentHookStatus(dir);
  assert.equal(status.state, "degraded");
  assert.deepEqual(status.configuredAgents, []);
});

test("a legal command override invalidates ACTIVE evidence until that exact config runs", () => {
  const dir = freshRepo();
  writeFileSync(join(dir, ".git", "info", "exclude"), ".codex/\n");
  assert.equal(installHooksCmd(dir, { stop: true, agents: ["codex"] }), 0);
  recordCurrentHookEvidence(dir, "codex");
  assert.equal(inspectAgentHookStatus(dir).state, "active");

  const path = join(dir, ".codex", "hooks.json");
  const config = JSON.parse(readFileSync(path, "utf8"));
  config.hooks.SessionStart[0].hooks[0].command = `HARNESS_KIT_CMD=true ${config.hooks.SessionStart[0].hooks[0].command}`;
  config.hooks.Stop[0].hooks[0].command = `HARNESS_KIT_CMD=true ${config.hooks.Stop[0].hooks[0].command}`;
  writeFileSync(path, JSON.stringify(config));

  const status = inspectAgentHookStatus(dir);
  assert.equal(status.state, "degraded");
  assert.deepEqual(status.configuredAgents, ["codex"]);
  assert.ok(status.issues.some((issue) => /different hook configuration/.test(issue)));
});

test("hook status rejects a marker-only runner even with current lifecycle evidence", () => {
  const dir = freshRepo();
  assert.equal(installHooksCmd(dir, { stop: true, agents: ["codex"] }), 0);
  const runner = join(dir, ".agents", "hooks", "harness-agent-hook.sh");
  writeFileSync(runner, "#!/bin/sh\n# harness-kit-managed-hook (agent-lifecycle)\nexit 0\n");
  assert.ok((statSync(runner).mode & 0o100) !== 0, "the fake remains executable");
  recordCurrentHookEvidence(dir, "codex");

  const status = inspectAgentHookStatus(dir);
  assert.equal(status.state, "degraded");
  assert.ok(status.issues.some((issue) => /runner/.test(issue)));
});

test("hook status checks the installed runner agent and event for every client", () => {
  const cases = [
    { agent: "claude", path: ".claude/settings.json", start: ["SessionStart", 0, "hooks", 0], stop: ["Stop", 0, "hooks", 0] },
    { agent: "cursor", path: ".cursor/hooks.json", start: ["sessionStart", 0], stop: ["stop", 0] },
    { agent: "codex", path: ".codex/hooks.json", start: ["SessionStart", 0, "hooks", 0], stop: ["Stop", 0, "hooks", 0] },
  ] as const;

  function commandAt(config: any, path: readonly (string | number)[]): { command: string; type?: string } {
    let current = config.hooks;
    for (const part of path) current = current[part];
    return current;
  }

  for (const { agent, path, start, stop } of cases) {
    const dir = freshRepo();
    assert.equal(installHooksCmd(dir, { stop: true, agents: [agent] }), 0);
    const abs = join(dir, path);
    const original = JSON.parse(readFileSync(abs, "utf8"));
    const startCommand = commandAt(original, start).command;
    const stopCommand = commandAt(original, stop).command;

    const wrongEvents = structuredClone(original);
    commandAt(wrongEvents, start).command = stopCommand;
    commandAt(wrongEvents, stop).command = startCommand;
    writeFileSync(abs, JSON.stringify(wrongEvents));
    assert.ok(!inspectAgentHookStatus(dir).configuredAgents.includes(agent), `${agent}: swapped events are not installed hooks`);

    const wrongAgent = structuredClone(original);
    const other = agent === "claude" ? "codex" : "claude";
    commandAt(wrongAgent, start).command = startCommand.replace(` ${agent} session-start`, ` ${other} session-start`);
    writeFileSync(abs, JSON.stringify(wrongAgent));
    assert.ok(!inspectAgentHookStatus(dir).configuredAgents.includes(agent), `${agent}: another agent command is not its hook`);

    if (agent !== "cursor") {
      const wrongType = structuredClone(original);
      commandAt(wrongType, start).type = "prompt";
      writeFileSync(abs, JSON.stringify(wrongType));
      assert.ok(!inspectAgentHookStatus(dir).configuredAgents.includes(agent), `${agent}: a non-command hook type is not executable`);
    }

    const localOverride = structuredClone(original);
    commandAt(localOverride, start).command = `HARNESS_KIT_CMD='node_modules/.bin/harness-kit' ${startCommand}`;
    commandAt(localOverride, stop).command = `env HARNESS_KIT_CMD="/tmp/local-harness" ${stopCommand}`;
    writeFileSync(abs, JSON.stringify(localOverride));
    assert.ok(inspectAgentHookStatus(dir).configuredAgents.includes(agent), `${agent}: a legal local CLI override remains recognizable`);
  }
});

test("hook status rejects local CLI overrides containing shell expansion or control operators", () => {
  const dir = freshRepo();
  assert.equal(installHooksCmd(dir, { stop: true, agents: ["codex"] }), 0);
  const path = join(dir, ".codex", "hooks.json");
  const original = JSON.parse(readFileSync(path, "utf8"));
  const start = original.hooks.SessionStart[0].hooks[0].command;
  const stop = original.hooks.Stop[0].hooks[0].command;
  const unsafePrefixes = [
    `HARNESS_KIT_CMD="$(touch /tmp/harness-pwned)" `,
    "HARNESS_KIT_CMD='`touch /tmp/harness-pwned`' ",
    'HARNESS_KIT_CMD="$HOME/bin/harness-kit" ',
    "HARNESS_KIT_CMD='node; true' ",
    "HARNESS_KIT_CMD='node & true' ",
    "HARNESS_KIT_CMD='node | true' ",
    "HARNESS_KIT_CMD='sh -c id' ",
    "HARNESS_KIT_CMD='node\nharness-kit' ",
  ];

  for (const prefix of unsafePrefixes) {
    const config = structuredClone(original);
    config.hooks.SessionStart[0].hooks[0].command = prefix + start;
    config.hooks.Stop[0].hooks[0].command = prefix + stop;
    writeFileSync(path, JSON.stringify(config));
    assert.ok(
      !inspectAgentHookStatus(dir).configuredAgents.includes("codex"),
      `unsafe override must not be recognized: ${JSON.stringify(prefix)}`,
    );
  }
});

test("reinstalling preserves marker-like foreign commands for every client", () => {
  const dir = freshRepo();
  assert.equal(installHooksCmd(dir, { stop: true, agents: ["claude", "cursor", "codex"] }), 0);
  const markerLikeForeign = { type: "command", command: "true # harness-agent-hook.sh", timeout: 5 };

  const claudePath = join(dir, ".claude", "settings.json");
  const claude = JSON.parse(readFileSync(claudePath, "utf8"));
  claude.hooks.SessionStart[0].hooks.push(markerLikeForeign);
  claude.hooks.Stop[0].hooks.push(markerLikeForeign);
  writeFileSync(claudePath, JSON.stringify(claude));

  const cursorPath = join(dir, ".cursor", "hooks.json");
  const cursor = JSON.parse(readFileSync(cursorPath, "utf8"));
  cursor.hooks.sessionStart.push(markerLikeForeign);
  cursor.hooks.stop.push(markerLikeForeign);
  writeFileSync(cursorPath, JSON.stringify(cursor));

  const codexPath = join(dir, ".codex", "hooks.json");
  const codex = JSON.parse(readFileSync(codexPath, "utf8"));
  codex.hooks.SessionStart[0].hooks.push(markerLikeForeign);
  codex.hooks.Stop[0].hooks.push(markerLikeForeign);
  writeFileSync(codexPath, JSON.stringify(codex));

  assert.equal(installHooksCmd(dir, { stop: true, agents: ["claude", "cursor", "codex"] }), 0);

  const groupCommands = (path: string, event: string): string[] =>
    JSON.parse(readFileSync(path, "utf8")).hooks[event].flatMap((group: any) =>
      (group.hooks ?? []).map((hook: any) => hook.command),
    );
  const cursorCommands = JSON.parse(readFileSync(cursorPath, "utf8")).hooks;
  assert.ok(groupCommands(claudePath, "SessionStart").includes(markerLikeForeign.command));
  assert.ok(groupCommands(claudePath, "Stop").includes(markerLikeForeign.command));
  assert.ok(cursorCommands.sessionStart.some((hook: any) => hook.command === markerLikeForeign.command));
  assert.ok(cursorCommands.stop.some((hook: any) => hook.command === markerLikeForeign.command));
  assert.ok(groupCommands(codexPath, "SessionStart").includes(markerLikeForeign.command));
  assert.ok(groupCommands(codexPath, "Stop").includes(markerLikeForeign.command));
  assert.deepEqual(inspectAgentHookStatus(dir).configuredAgents, ["claude", "cursor", "codex"]);
});

test("Codex feature enablement preserves existing project TOML and is idempotent", () => {
  const dir = freshRepo();
  mkdirSync(join(dir, ".codex"), { recursive: true });
  const path = join(dir, ".codex", "config.toml");
  writeFileSync(path, 'model = "gpt-5"\n\n[features]\nmemories = true\ncodex_hooks = false\nhooks = false\n');
  assert.equal(installHooksCmd(dir, { stop: true, agents: ["codex"] }), 0);
  assert.equal(installHooksCmd(dir, { stop: true, agents: ["codex"] }), 0);
  const config = readFileSync(path, "utf8");
  assert.match(config, /model = "gpt-5"/);
  assert.match(config, /memories = true/);
  assert.equal(config.match(/^hooks = true$/gm)?.length, 1);
});

test("install-hooks --stop refuses a non-Git directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "hk-hooks-not-git-"));
  assert.equal(installHooksCmd(dir, { stop: true, agents: ["codex"] }), 1);
  assert.equal(existsSync(join(dir, ".agents", "hooks", "harness-agent-hook.sh")), false);
});

test("the shared runner converts infrastructure failures into each client's blocking protocol", () => {
  const dir = freshRepo();
  assert.equal(installHooksCmd(dir, { stop: true, agents: ["claude", "cursor", "codex"] }), 0);
  writeFileSync(join(dir, ".agents", "manifest.yaml"), "spec: ai-harness/v0\nidentity: { name: test }\n");
  const runner = join(dir, ".agents", "hooks", "harness-agent-hook.sh");
  const env = { ...process.env, HARNESS_KIT_CMD: "false" };

  const cursor = spawnSync("bash", [runner, "cursor", "stop"], { cwd: dir, input: "{}", encoding: "utf8", env });
  assert.equal(cursor.status, 0);
  assert.match(JSON.parse(cursor.stdout).followup_message, /infrastructure failed/);

  const codex = spawnSync("bash", [runner, "codex", "stop"], { cwd: dir, input: "{}", encoding: "utf8", env });
  assert.equal(codex.status, 0);
  assert.equal(JSON.parse(codex.stdout).decision, "block");

  const claudeStart = spawnSync("bash", [runner, "claude", "session-start"], {
    cwd: dir,
    input: "{}",
    encoding: "utf8",
    env,
  });
  assert.equal(claudeStart.status, 2);
  assert.match(claudeStart.stderr, /infrastructure failed/);
});

test("installed outer commands still block when the shared runner is missing", () => {
  const dir = freshRepo();
  assert.equal(installHooksCmd(dir, { stop: true, agents: ["claude", "cursor", "codex"] }), 0);
  unlinkSync(join(dir, ".agents", "hooks", "harness-agent-hook.sh"));

  const claude = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
  const claudeStart = spawnSync("bash", ["-lc", claude.hooks.SessionStart[0].hooks[0].command], {
    cwd: dir,
    input: "{}",
    encoding: "utf8",
  });
  assert.equal(claudeStart.status, 2);
  assert.match(claudeStart.stderr, /runner is missing/);

  const cursor = JSON.parse(readFileSync(join(dir, ".cursor", "hooks.json"), "utf8"));
  const cursorStop = spawnSync("bash", ["-lc", cursor.hooks.stop[0].command], { cwd: dir, input: "{}", encoding: "utf8" });
  assert.equal(cursorStop.status, 0);
  assert.match(JSON.parse(cursorStop.stdout).followup_message, /runner is missing/);

  const codex = JSON.parse(readFileSync(join(dir, ".codex", "hooks.json"), "utf8"));
  const codexStop = spawnSync("bash", ["-lc", codex.hooks.Stop[0].hooks[0].command], {
    cwd: dir,
    input: "{}",
    encoding: "utf8",
  });
  assert.equal(codexStop.status, 0);
  assert.equal(JSON.parse(codexStop.stdout).decision, "block");
});
