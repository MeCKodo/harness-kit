import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHarnessGuidance } from "../src/guidance";
import type { AgentHookStatus } from "../src/hook-status";
import type { Manifest } from "../src/manifest";

const manifest: Manifest = {
  spec: "ai-harness/v0",
  identity: { name: "guidance", summary: "guidance fixture" },
  capabilities: {
    release: { run: "npm publish", mutating: true },
    dev: { run: "vite", background: true },
  },
  invariants: [
    { id: "manual-policy", rule: "review the policy", manual: true },
    { id: "missing-gate", rule: "must be enforced" },
  ],
  contracts: [
    { id: "manual-api", kind: "api", desc: "manual API", manual_verify: "exercise the real endpoint" },
    { id: "unchecked-api", kind: "api", desc: "unchecked API" },
  ],
};

test("guidance separates maintenance improvements from on-demand boundaries", () => {
  const guidance = buildHarnessGuidance({ manifest });
  assert.deepEqual(guidance.gapSummary, { total: 6, recommended: 2, informational: 4 });
  assert.equal(guidance.gapDetails.find((gap) => gap.scope === "release")?.classification, "informational");
  assert.equal(guidance.gapDetails.find((gap) => gap.scope === "missing-gate")?.classification, "recommended");
  assert.deepEqual(guidance.nextActions.map((action) => action.id), ["improve-verification-automation"]);
  assert.equal(guidance.nextActions[0]?.when, "harness-maintenance");
});
test("missing, configured, and conflicting Hooks are recommended only — deliver remains the task gate", () => {
  const missing: AgentHookStatus = {
    state: "degraded",
    configuredAgents: [],
    issues: [".agents/hooks/harness-agent-hook.sh runner is missing", "no complete effective Agent SessionStart + Stop hook pair is configured"],
  };
  const install = buildHarnessGuidance({ hooks: missing }).nextActions[0]!;
  assert.equal(install.id, "optional-install-lifecycle-hooks");
  assert.equal(install.owner, "agent");
  assert.equal(install.priority, "recommended");
  assert.ok(install.commands.some((c) => /deliver/.test(c)));

  const configured: AgentHookStatus = { state: "configured", configuredAgents: ["codex"], issues: [] };
  const observe = buildHarnessGuidance({ hooks: configured }).nextActions[0]!;
  assert.equal(observe.id, "optional-lifecycle-hook-observation");
  assert.equal(observe.priority, "recommended");
  assert.doesNotMatch(observe.completion, /fresh Agent session|hookActive/);

  const conflicting: AgentHookStatus = {
    state: "degraded",
    configuredAgents: [],
    issues: [".codex/hooks.json is not valid hook JSON"],
  };
  const review = buildHarnessGuidance({ hooks: conflicting }).nextActions[0]!;
  assert.equal(review.id, "review-lifecycle-hook-conflict");
  assert.equal(review.owner, "human");
  assert.equal(review.priority, "recommended");
  assert.deepEqual(review.commands, []);
});

test("active Hooks need no lifecycle action and stale evidence is repaired before finish", () => {
  const active: AgentHookStatus = {
    state: "active",
    configuredAgents: ["cursor"],
    evidenceAgent: "cursor",
    evidenceAt: new Date().toISOString(),
    issues: [],
  };
  assert.deepEqual(buildHarnessGuidance({ hooks: active }).nextActions, []);

  const stale = buildHarnessGuidance({ hooks: active, evidence: { found: true, stale: true } }).nextActions;
  assert.deepEqual(stale.map((action) => action.id), ["refresh-stale-delivery-evidence"]);
  assert.equal(stale[0]?.when, "before-finish");
});
