import { readFileSync } from "node:fs";
import { collectChanges, EMPTY_TREE_BASE, gitRoot } from "../git";
import { agentHookConfigurationFingerprint } from "../hook-status";
import {
  clearValidationEvidence,
  markLatestVerifyResult,
  readValidationSession,
  startValidationSession,
  validationSessionToken,
  type HookAgent,
} from "../validation-state";
import { runChecksCmd, type RunChecksReport } from "./run-checks";
import { verifyCmd } from "./verify";

export interface HookEventOpts {
  agent: Exclude<HookAgent, "manual">;
  event: "session-start" | "stop";
}

interface HookPayload {
  session_id?: string;
  conversation_id?: string;
  turn_id?: string;
  status?: string;
  stop_hook_active?: boolean;
}

const MAX_HOOK_VERIFY_BUDGET_MS = 2 * 60 * 1000;

function hookVerifyBudgetMs(): number {
  const configured = Number(process.env.HARNESS_KIT_VERIFY_BUDGET_MS);
  if (!Number.isFinite(configured) || configured <= 0) return MAX_HOOK_VERIFY_BUDGET_MS;
  return Math.min(configured, MAX_HOOK_VERIFY_BUDGET_MS);
}

function readPayload(): HookPayload {
  const raw = readFileSync(0, "utf8").trim();
  if (!raw) return {};
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("hook stdin must be a JSON object");
  return value as HookPayload;
}

function sessionId(payload: HookPayload): string | null {
  return payload.session_id ?? payload.conversation_id ?? payload.turn_id ?? null;
}

function captureStdout(fn: () => number): { code: number; output: string } {
  const chunks: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (chunk: string | Uint8Array) => boolean }).write = (chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  };
  let code = 1;
  try {
    code = fn();
  } catch (error) {
    chunks.push(`command threw: ${(error as Error).message}\n`);
  } finally {
    (process.stdout as unknown as { write: typeof process.stdout.write }).write = original;
  }
  return { code, output: chunks.join("") };
}

function allow(agent: HookEventOpts["agent"]): number {
  if (agent === "cursor") process.stdout.write("{}\n");
  return 0;
}

function block(agent: HookEventOpts["agent"], event: HookEventOpts["event"], reason: string): number {
  if (event === "stop" && agent === "cursor") {
    process.stdout.write(JSON.stringify({ followup_message: reason }) + "\n");
    return 0;
  }
  if (event === "stop") {
    process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n");
    return 0;
  }
  process.stderr.write(reason.trimEnd() + "\n");
  return 2;
}

function parseRunReport(output: string): RunChecksReport | null {
  try {
    return JSON.parse(output) as RunChecksReport;
  } catch {
    return null;
  }
}

function failureMessage(report: RunChecksReport | null, verifyOutput: string, token: string): string {
  const lines = ["harness-kit: delivery is not verified; continue working before stopping."];
  if (!report) lines.push("run-checks did not return valid evidence.");
  else {
    for (const message of report.errors.slice(0, 5)) lines.push(`- ${message}`);
    for (const failure of report.failed.slice(0, 5)) {
      lines.push(`- check ${failure.id} failed (exit ${failure.code})`);
      lines.push(`  run: ${failure.cmd}`);
      const tail = failure.logTail.split("\n").filter(Boolean).slice(-5);
      if (tail.length) {
        lines.push("  output (tail):");
        for (const line of tail) lines.push(`    ${line}`);
      }
    }
    for (const skipped of report.skipped.slice(0, 5)) lines.push(`- check ${skipped.id} was not run: ${skipped.reason}`);
    for (const gap of report.gaps.filter((item) => item.severity === "blocking").slice(0, 5))
      lines.push(`- [${gap.kind}] ${gap.where ? `${gap.where}: ` : ""}${gap.why}`);
  }
  if (verifyOutput.trim()) {
    const outputLines = verifyOutput.trim().split("\n");
    const actionable = outputLines.filter((line) => /\bERR\b|timed out|budget exhausted|verify: FAILED/.test(line));
    lines.push(`- verify: ${(actionable.length ? actionable.slice(-8) : outputLines.slice(-8)).join(" | ")}`);
  }
  lines.push("Fix the failures, then finish again; every Stop attempt is re-checked.");
  lines.push(
    `For a genuine non-goal, only an eligible coverage gap may be waived: harness-kit run-checks --repo . --session ${token} --waive <kind> --where <scope> --reason "<why>"`,
  );
  return lines.join("\n");
}

export function hookEventCmd(repoInput: string, opts: HookEventOpts): number {
  let payload: HookPayload;
  try {
    payload = readPayload();
  } catch (error) {
    return block(opts.agent, opts.event, `harness-kit hook input invalid: ${(error as Error).message}`);
  }
  const id = sessionId(payload);
  if (!id) return block(opts.agent, opts.event, "harness-kit hook input has no session/conversation id");

  let repo: string;
  try {
    repo = gitRoot(repoInput);
  } catch (error) {
    return block(opts.agent, opts.event, `harness-kit cannot resolve repository root: ${(error as Error).message}`);
  }

  if (opts.event === "session-start") {
    try {
      const initial = collectChanges(repo, "HEAD", { mode: "exact" });
      startValidationSession({
        repo,
        agent: opts.agent,
        sessionId: id,
        baseSha: initial.head,
        initialFingerprint: initial.fingerprint,
        initialDirty: initial.files,
        hookConfigFingerprint: agentHookConfigurationFingerprint(repo, opts.agent) ?? undefined,
      });
      return allow(opts.agent);
    } catch (error) {
      return block(opts.agent, opts.event, `harness-kit could not capture the session baseline: ${(error as Error).message}`);
    }
  }

  if (opts.agent === "cursor" && ["aborted", "error"].includes(payload.status ?? "")) return allow(opts.agent);

  const token = validationSessionToken(opts.agent, id);
  let session;
  try {
    session = readValidationSession(repo, token);
  } catch (error) {
    return block(opts.agent, opts.event, `harness-kit validation session is unreadable: ${(error as Error).message}`);
  }
  if (!session) {
    return block(
      opts.agent,
      opts.event,
      "harness-kit has no SessionStart baseline for this conversation. Start a new agent session after installing hooks; refusing to guess and miss committed changes.",
    );
  }

  if (
    session.hookConfigFingerprint &&
    agentHookConfigurationFingerprint(repo, opts.agent) !== session.hookConfigFingerprint
  ) {
    return block(
      opts.agent,
      opts.event,
      "harness-kit project hook configuration changed after SessionStart. Start a new agent session before delivery; refusing to trust evidence from another hook configuration.",
    );
  }

  try {
    clearValidationEvidence(repo, session);
  } catch (error) {
    return block(opts.agent, opts.event, `harness-kit could not start a fresh validation attempt: ${(error as Error).message}`);
  }

  // stop_hook_active is intentionally not a bypass: every attempt is re-checked.
  const run = captureStdout(() => runChecksCmd(repo, { session: token, json: true }));
  const report = parseRunReport(run.output);
  const verify = captureStdout(() => verifyCmd(repo, { budgetMs: hookVerifyBudgetMs(), recordManualEvidence: false }));
  let finalFingerprintError = "";
  if (report?.fingerprint) {
    try {
      const current = collectChanges(repo, session.baseSha ?? EMPTY_TREE_BASE, { mode: "exact" });
      if (current.fingerprint !== report.fingerprint)
        finalFingerprintError = "change fingerprint changed during final verification; rerun both gates on the stable change";
    } catch (error) {
      finalFingerprintError = `final fingerprint failed: ${(error as Error).message}`;
    }
  }
  const verifyPassed = verify.code === 0 && !finalFingerprintError;
  let evidencePersisted = false;
  try {
    evidencePersisted = markLatestVerifyResult(repo, token, verifyPassed, report?.fingerprint);
  } catch (error) {
    return block(opts.agent, opts.event, `harness-kit could not persist the final verify result: ${(error as Error).message}`);
  }
  if (run.code === 0 && report?.ok && verifyPassed && evidencePersisted) return allow(opts.agent);
  const verifyDetails = [
    verify.code === 0 ? "" : verify.output.trim(),
    finalFingerprintError,
    evidencePersisted ? "" : "matching final evidence was not persisted; refusing to allow Stop",
  ]
    .filter(Boolean)
    .join("\n");
  return block(opts.agent, opts.event, failureMessage(report, verifyDetails, token));
}
