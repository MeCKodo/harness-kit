import { collectChanges } from "../git";
import {
  inspectDeliveryStamp,
  resolveChangeScope,
  type ChangeScope,
  type DeliveryStamp,
} from "../delivery";
import { err, info, ok, warn } from "../util";
import { runChecksCmd, type RunChecksReport } from "./run-checks";
import { verifyCmd } from "./verify";

export interface DeliverOpts {
  base?: string;
  json?: boolean;
  profile?: string;
}

export type DeliverStatus = "accepted" | "needs-work" | "no-change";

export interface DeliverReport {
  schema: "ai-harness/deliver-report/v1";
  status: DeliverStatus;
  ok: boolean;
  scope: ChangeScope["kind"];
  base: string;
  fingerprint: string;
  changed: string[];
  runChecks?: RunChecksReport | null;
  verifyPassed: boolean;
  stamp: DeliveryStamp;
  errors: string[];
  next: string[];
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

function parseRunReport(output: string): RunChecksReport | null {
  try {
    return JSON.parse(output) as RunChecksReport;
  } catch {
    return null;
  }
}

function nextActions(status: DeliverStatus, report: RunChecksReport | null): string[] {
  if (status === "accepted" || status === "no-change") return [];
  const next: string[] = [];
  if (report) {
    for (const failure of report.failed.slice(0, 5)) {
      next.push(`fix failing check "${failure.id}": ${failure.cmd}`);
    }
    for (const gap of report.gaps.filter((g) => g.severity === "blocking").slice(0, 5)) {
      next.push(gap.suggestion);
    }
    for (const skipped of report.skipped.slice(0, 3)) {
      next.push(`resolve skipped check ${skipped.id}: ${skipped.reason}`);
    }
  }
  next.push('re-run: harness-kit deliver --repo .');
  return next;
}

function reportHuman(report: DeliverReport): void {
  info(`deliver (scope=${report.scope}, base ${report.base}) — ${report.changed.length} changed file(s)`);
  if (report.scope === "worktree" && report.status !== "no-change") {
    info("  using worktree diff vs HEAD (no task base); for committed task range run: harness-kit task start");
  }
  if (report.runChecks) {
    info(`  run-checks: ${report.runChecks.status} (${report.runChecks.passed.length} passed, ${report.runChecks.failed.length} failed)`);
    for (const failure of report.runChecks.failed.slice(0, 5)) {
      err(`${failure.id}: FAILED (exit ${failure.code}) — ${failure.cmd}`);
      for (const line of failure.logTail.split("\n")) if (line) info(`       ${line}`);
    }
    for (const gap of report.runChecks.gaps.filter((g) => g.severity === "blocking").slice(0, 8)) {
      err(`[${gap.kind}] ${gap.where ? `${gap.where} — ` : ""}${gap.why}`);
      info(`       -> ${gap.suggestion}`);
    }
  }
  if (report.verifyPassed) ok("verify: passed");
  else err("verify: failed");
  for (const message of report.errors) err(message);
  info("");
  if (report.status === "accepted") ok("deliver: ACCEPTED — task stamp is valid for this fingerprint");
  else if (report.status === "no-change") ok("deliver: NO-CHANGE — no pending worktree changes to accept");
  else err("deliver: NEEDS-WORK — fix failures and re-run harness-kit deliver");
  if (report.next.length) {
    info("\nNEXT");
    for (const step of report.next) info(`  - ${step}`);
  }
}

/**
 * Single task-acceptance entry: resolve change scope → run-checks (unlimited budget)
 * → verify → require stable fingerprint → leave a stamp via validation evidence.
 */
export function deliverCmd(repo: string, opts: DeliverOpts = {}): number {
  const errors: string[] = [];
  let scope: ChangeScope;
  try {
    scope = resolveChangeScope(repo, { base: opts.base });
  } catch (error) {
    err(`deliver cannot resolve change scope: ${(error as Error).message}`);
    return 1;
  }

  // Unlimited check budget: long E2E for complex tasks is intentional.
  const run = captureStdout(() =>
    runChecksCmd(repo, {
      base: scope.base,
      mode: "exact",
      budgetMs: 0,
      allowEmptyAsNoChange: true,
      profile: opts.profile,
      json: true,
    }),
  );
  const runReport = parseRunReport(run.output);
  if (!runReport) errors.push("run-checks did not return valid JSON evidence");

  // No tight verify budget for deliver (optional env override still respected by verify if set later).
  const verify = captureStdout(() =>
    verifyCmd(repo, {
      recordManualEvidence: true,
      budgetMs: Number(process.env.HARNESS_KIT_DELIVER_VERIFY_BUDGET_MS) || 60 * 60 * 1000,
    }),
  );
  const verifyPassed = verify.code === 0;
  if (!verifyPassed) {
    const tail = verify.output.trim().split("\n").filter(Boolean).slice(-8);
    if (tail.length) errors.push(`verify failed: ${tail.join(" | ")}`);
    else errors.push("verify failed");
  }

  let fingerprintError = "";
  if (runReport?.fingerprint) {
    try {
      const current = collectChanges(repo, scope.base, { mode: "exact" });
      if (current.fingerprint !== runReport.fingerprint) {
        fingerprintError = "change fingerprint changed during delivery; re-run deliver on a stable tree";
        errors.push(fingerprintError);
      }
    } catch (error) {
      fingerprintError = `final fingerprint failed: ${(error as Error).message}`;
      errors.push(fingerprintError);
    }
  }

  const runOk = run.code === 0 && !!runReport?.ok;
  const stable = !fingerprintError;
  let status: DeliverStatus;
  if (runOk && verifyPassed && stable && runReport?.status === "no-change") status = "no-change";
  else if (runOk && verifyPassed && stable) status = "accepted";
  else status = "needs-work";

  // Stamp is refreshed by run-checks evidence + verify's markManualVerifyResult.
  const stamp = inspectDeliveryStamp(repo);
  const report: DeliverReport = {
    schema: "ai-harness/deliver-report/v1",
    status,
    ok: status === "accepted" || status === "no-change",
    scope: scope.kind,
    base: scope.base,
    fingerprint: runReport?.fingerprint ?? scope.changes.fingerprint,
    changed: runReport?.changed ?? scope.changes.files,
    runChecks: runReport,
    verifyPassed,
    stamp,
    errors,
    next: nextActions(status, runReport),
  };

  if (opts.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    reportHuman(report);
  }
  return report.ok ? 0 : 1;
}
