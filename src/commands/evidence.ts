import { inspectDeliveryStamp, type DeliveryStamp } from "../delivery";
import { buildHarnessGuidance, type HarnessNextAction } from "../guidance";
import { agentHookConfigurationFingerprint, inspectAgentHookStatus, type AgentHookStatus } from "../hook-status";
import { inspectValidationEvidenceFreshness, readLatestValidationSession, readValidationSession } from "../validation-state";
import { err, info, ok, warn } from "../util";

export interface EvidenceOpts {
  json?: boolean;
  session?: string;
}

function safeHookStatus(repo: string): AgentHookStatus {
  try {
    return inspectAgentHookStatus(repo);
  } catch (error) {
    return {
      state: "degraded",
      configuredAgents: [],
      issues: [`cannot inspect Agent lifecycle hooks: ${(error as Error).message}`],
    };
  }
}

function printNextActions(actions: HarnessNextAction[]): void {
  info("\nNEXT ACTIONS");
  if (!actions.length) {
    ok("nothing required now");
    return;
  }
  for (const action of actions) {
    warn(`[${action.priority.toUpperCase()} | ${action.owner.toUpperCase()}] ${action.title}`);
    info(`       why: ${action.reason}`);
    info(`       when: ${action.when}`);
    for (const command of action.commands) info(`       run: ${command}`);
    info(`       done when: ${action.completion}`);
  }
}

export function evidenceCmd(repo: string, opts: EvidenceOpts = {}): number {
  let session;
  try {
    session = opts.session ? readValidationSession(repo, opts.session) : readLatestValidationSession(repo);
  } catch (error) {
    err(`cannot read validation evidence: ${(error as Error).message}`);
    return 1;
  }
  const hooks = safeHookStatus(repo);
  if (!session?.lastEvidence) {
    const guidance = buildHarnessGuidance({ hooks, evidence: { found: false } });
    if (opts.json) {
      process.stdout.write(
        JSON.stringify(
          { schema: "ai-harness/evidence/v1", found: false, hooks, nextActions: guidance.nextActions },
          null,
          2,
        ) + "\n",
      );
    } else {
      warn("no validation evidence recorded for this worktree/session");
      printNextActions(guidance.nextActions.filter((action) => action.priority === "required"));
      warn(`Harness readiness: INCOMPLETE (${guidance.nextActions.filter((action) => action.priority === "required").length} required action(s) above)`);
    }
    return 1;
  }

  const body = {
    schema: "ai-harness/evidence/v1",
    found: true,
    session: session.token,
    agent: session.agent,
    createdAt: session.createdAt,
    initialDirty: session.initialDirty,
    evidence: session.lastEvidence,
  };
  const evidence = session.lastEvidence;
  const freshness = inspectValidationEvidenceFreshness(repo, evidence);
  const { currentFingerprint, currentPlanFingerprint, stale } = freshness;
  const runChecksValid =
    (evidence.runChecksStatus !== undefined ? evidence.runChecksStatus !== "not-verified" : evidence.ok && evidence.status !== "not-verified") &&
    !stale;
  const valid = runChecksValid && evidence.verifyPassed === true;
  const hookConfigurationCurrent = session.agent !== "manual" && !!session.hookConfigFingerprint &&
    agentHookConfigurationFingerprint(repo, session.agent) === session.hookConfigFingerprint;
  const hookActive = valid && hookConfigurationCurrent;
  const stamp: DeliveryStamp = inspectDeliveryStamp(repo);
  const guidance = buildHarnessGuidance({
    hooks,
    evidence: { found: true, stale, runChecksValid, verifyPassed: evidence.verifyPassed, valid },
  });
  const result = {
    ...body,
    runChecksValid,
    valid,
    stamp,
    hookActive,
    hookConfigurationCurrent,
    stale,
    currentFingerprint,
    currentPlanFingerprint,
    fingerprintStale: freshness.fingerprintStale,
    planStale: freshness.planStale,
    refreshError: freshness.error,
    hooks,
    nextActions: guidance.nextActions,
  };
  if (opts.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return valid ? 0 : 1;
  }

  if (valid) ok(`stamp: ${stamp.status}`);
  else if (stale) err("stale stamp — the change no longer matches this record");
  else if (evidence.verifyPassed !== true) err("delivery stamp incomplete — matching verify result is missing or failed");
  else err(evidence.status);
  info(`session: ${session.token}`);
  info(`agent: ${session.agent}`);
  if (session.agent === "manual") info("stamp source: deliver/manual (not a lifecycle hook proof)");
  info(`base: ${evidence.requestedBase} -> ${evidence.resolvedBase ?? "empty tree"}`);
  info(`fingerprint: ${evidence.fingerprint}`);
  if (session.initialDirty.length) info(`dirty at task/session start: ${session.initialDirty.join(", ")}`);
  if (evidence.verifyPassed !== undefined) info(`verify: ${evidence.verifyPassed ? "passed" : "failed"}`);
  else err("verify: no matching result was recorded");
  if (freshness.error) err(`cannot refresh current validation plan: ${freshness.error}`);
  info(`checks: ${evidence.checks.map((check) => `${check.id}:${check.status}`).join(", ") || "(none)"}`);
  if (evidence.gates?.length) info(`validation gates: ${evidence.gates.join(", ")}`);
  if (evidence.waivers.length) {
    info("waivers:");
    for (const waiver of evidence.waivers) warn(`${waiver.kind}:${waiver.where} — ${waiver.reason}`);
  }
  if (evidence.errors.length) {
    info("errors:");
    for (const message of evidence.errors) err(message);
  }
  if (hooks.configuredAgents.length) {
    info(`session intercept: ${hooks.state} (configured: ${hooks.configuredAgents.join(",")})`);
  } else {
    info("session intercept: none (cooperative deliver only)");
  }
  const requiredActions = guidance.nextActions.filter((action) => action.priority === "required");
  printNextActions(requiredActions);
  if (!valid) warn(`Delivery stamp: NOT READY (${requiredActions.length} required action(s) above)`);
  else ok("Delivery stamp: READY");
  return valid ? 0 : 1;
}
