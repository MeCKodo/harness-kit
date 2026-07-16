import { readFileSync } from "node:fs";
import { resolveChangeScope, stampCoversScope, startTaskRecord } from "../delivery";
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
import { deliverCmd } from "./deliver";
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
  loop_count?: number;
}

const MAX_HOOK_VERIFY_BUDGET_MS = 2 * 60 * 1000;

function hookVerifyBudgetMs(): number {
  const configured = Number(process.env.HARNESS_KIT_VERIFY_BUDGET_MS);
  if (!Number.isFinite(configured) || configured <= 0) return MAX_HOOK_VERIFY_BUDGET_MS;
  return Math.min(configured, MAX_HOOK_VERIFY_BUDGET_MS);
}

/** thin (default): check delivery stamp. execute: run full deliver/legacy gates in-hook. */
function stopMode(): "thin" | "execute" {
  const raw = (process.env.HARNESS_KIT_STOP_MODE ?? "thin").trim().toLowerCase();
  return raw === "execute" || raw === "thick" ? "execute" : "thin";
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

function deliverBlockMessage(extra = ""): string {
  const lines = [
    "harness-kit: delivery is not verified; continue working before stopping.",
    "Run: harness-kit deliver --repo .",
    "Only status=accepted (or no-change with a clean tree) may finish.",
    "Fix failures from deliver, then finish again.",
  ];
  if (extra.trim()) lines.splice(1, 0, extra.trim());
  return lines.join("\n");
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
  lines.push("Prefer: harness-kit deliver --repo .  (then finish again)");
  lines.push(
    `For a genuine non-goal coverage gap only: harness-kit run-checks --repo . --session ${token} --waive <kind> --where <scope> --reason "<why>"`,
  );
  return lines.join("\n");
}

function thinStop(repo: string, agent: HookEventOpts["agent"]): number {
  let scope;
  try {
    scope = resolveChangeScope(repo);
  } catch (error) {
    return block(agent, "stop", deliverBlockMessage(`cannot resolve changes: ${(error as Error).message}`));
  }
  if (scope.changes.files.length === 0) return allow(agent);
  if (stampCoversScope(repo, scope)) return allow(agent);
  return block(
    agent,
    "stop",
    deliverBlockMessage(
      `scope=${scope.kind} base=${scope.base} changed=${scope.changes.files.length} file(s); no matching accepted delivery stamp.`,
    ),
  );
}

function executeStop(repo: string, agent: HookEventOpts["agent"], id: string): number {
  const token = validationSessionToken(agent, id);
  let session;
  try {
    session = readValidationSession(repo, token);
  } catch (error) {
    return block(agent, "stop", deliverBlockMessage(`validation session unreadable: ${(error as Error).message}`));
  }

  // No SessionStart: still deliver via shared engine (do NOT demand a new session).
  if (!session) {
    const delivered = captureStdout(() => deliverCmd(repo, { json: true }));
    if (delivered.code === 0) return allow(agent);
    let detail = "";
    try {
      const body = JSON.parse(delivered.output) as { errors?: string[]; status?: string };
      detail = `deliver status=${body.status ?? "needs-work"}; ${(body.errors ?? []).slice(0, 3).join("; ")}`;
    } catch {
      detail = delivered.output.trim().slice(0, 500);
    }
    return block(agent, "stop", deliverBlockMessage(detail));
  }

  // Config fingerprint change: do not trust lifecycle binding, but still accept a fresh deliver stamp path.
  if (
    session.hookConfigFingerprint &&
    agentHookConfigurationFingerprint(repo, agent) !== session.hookConfigFingerprint
  ) {
    // Fall through to deliver-based acceptance for current scope rather than "start a new session".
    const delivered = captureStdout(() => deliverCmd(repo, { json: true }));
    if (delivered.code === 0) return allow(agent);
    return block(
      agent,
      "stop",
      deliverBlockMessage(
        "project hook configuration changed after SessionStart; lifecycle proof was discarded. Run deliver to re-accept the current change.",
      ),
    );
  }

  try {
    clearValidationEvidence(repo, session);
  } catch (error) {
    return block(agent, "stop", deliverBlockMessage(`could not start a fresh validation attempt: ${(error as Error).message}`));
  }

  const run = captureStdout(() => runChecksCmd(repo, { session: token, json: true, budgetMs: 0 }));
  const report = parseRunReport(run.output);
  const verify = captureStdout(() => verifyCmd(repo, { budgetMs: hookVerifyBudgetMs(), recordManualEvidence: false }));
  let finalFingerprintError = "";
  if (report?.fingerprint) {
    try {
      const current = collectChanges(repo, session.baseSha ?? EMPTY_TREE_BASE, { mode: "exact" });
      if (current.fingerprint !== report.fingerprint)
        finalFingerprintError = "change fingerprint changed during final verification; rerun deliver on the stable change";
    } catch (error) {
      finalFingerprintError = `final fingerprint failed: ${(error as Error).message}`;
    }
  }
  const verifyPassed = verify.code === 0 && !finalFingerprintError;
  let evidencePersisted = false;
  try {
    evidencePersisted = markLatestVerifyResult(repo, token, verifyPassed, report?.fingerprint, report?.planFingerprint);
  } catch (error) {
    return block(agent, "stop", deliverBlockMessage(`could not persist verify result: ${(error as Error).message}`));
  }
  if (run.code === 0 && report?.ok && verifyPassed && evidencePersisted) return allow(agent);
  const verifyDetails = [
    verify.code === 0 ? "" : verify.output.trim(),
    finalFingerprintError,
    evidencePersisted ? "" : "matching final evidence was not persisted; refusing to allow Stop",
  ]
    .filter(Boolean)
    .join("\n");
  return block(agent, "stop", failureMessage(report, verifyDetails, token));
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
      // Optimize: auto task base so deliver can cover commits after session start.
      if (initial.head) {
        try {
          startTaskRecord({
            repo,
            baseSha: initial.head,
            hostSessionId: id,
            agent: opts.agent,
            note: "auto from SessionStart",
          });
        } catch {
          // Task start is an optimization; never fail SessionStart for it.
        }
      }
      return allow(opts.agent);
    } catch (error) {
      return block(opts.agent, opts.event, `harness-kit could not capture the session baseline: ${(error as Error).message}`);
    }
  }

  if (opts.agent === "cursor" && ["aborted", "error"].includes(payload.status ?? "")) return allow(opts.agent);

  if (stopMode() === "thin") return thinStop(repo, opts.agent);
  return executeStop(repo, opts.agent, id);
}
