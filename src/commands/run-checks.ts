import { spawnSync } from "node:child_process";
import { collectChanges, EMPTY_TREE_BASE, GitDiffError, type ChangeSet } from "../git";
import { loadManifest, validateManifest, type Manifest } from "../manifest";
import { validationPlanFingerprint, type Gap, type Plan } from "../planner";
import {
  manualValidationSession,
  readValidationSession,
  recordValidationEvidence,
  recordWaiver,
  type CheckEvidence,
  type StoredWaiver,
  type ValidationEvidence,
  type ValidationSession,
  type ValidationStatus,
} from "../validation-state";
import { err, info, ok, warn } from "../util";
import { planRepositoryChecks } from "../validation-plan";

export interface RunChecksOpts {
  base?: string;
  /** Diff mode. Session/task/delivery use exact; bare CLI defaults to merge-base. */
  mode?: "merge-base" | "exact";
  /**
   * Total wall-clock budget for all selected checks.
   * Omit for the default 7-minute CLI budget.
   * Pass 0 for unlimited (delivery path — long E2E is intentional).
   */
  budgetMs?: number;
  json?: boolean;
  profile?: string;
  waive?: string;
  where?: string;
  reason?: string;
  session?: string;
  /** When true, clean worktree is no-change without manual-base-required. */
  allowEmptyAsNoChange?: boolean;
}

interface Failure {
  id: string;
  cmd: string;
  code: number;
  logTail: string;
  durationMs: number;
}

export interface RunChecksReport {
  schema: "ai-harness/run-checks/v1";
  status: ValidationStatus;
  ok: boolean;
  requestedBase: string;
  resolvedBase: string | null;
  fingerprint: string;
  profile: string | null;
  planFingerprint: string;
  changed: string[];
  affected: string[];
  gates: string[];
  passed: string[];
  failed: Failure[];
  skipped: { id: string; reason: string }[];
  checks: CheckEvidence[];
  gaps: Gap[];
  notes: Plan["notes"];
  waivers: StoredWaiver[];
  errors: string[];
  session: string;
}

const CHECK_BUDGET_MS = 7 * 60 * 1000;
const WAIVABLE_GAP_KINDS = new Set<Gap["kind"]>([
  "missing-test-touch",
  "module-without-tests",
  "unmapped-required-file",
]);

function isWaivableGap(gap: Gap): boolean {
  return gap.severity === "blocking" && WAIVABLE_GAP_KINDS.has(gap.kind);
}

function runOne(repo: string, cmd: string, timeoutMs: number): { ok: boolean; code: number; logTail: string; durationMs: number } {
  const started = Date.now();
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.max(1, timeoutMs) : undefined;
  const r = spawnSync(cmd, {
    cwd: repo,
    shell: true,
    encoding: "utf8",
    ...(timeout !== undefined ? { timeout } : {}),
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? `\n${r.error.message}` : ""}`;
  const logTail = out.split("\n").filter(Boolean).slice(-15).join("\n");
  const code = r.status ?? 1;
  return { ok: code === 0, code, logTail, durationMs: Date.now() - started };
}

function emptyPlan(changed: string[], gaps: Gap[] = []): Plan {
  return { changed, affected: [], gates: [], checks: [], gaps, notes: [], profile: null };
}

function outputJson(report: RunChecksReport): void {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
}

function evidenceOf(report: RunChecksReport): ValidationEvidence {
  return {
    schema: "ai-harness/validation-evidence/v1",
    status: report.status,
    ok: report.ok,
    requestedBase: report.requestedBase,
    resolvedBase: report.resolvedBase,
    fingerprint: report.fingerprint,
    profile: report.profile,
    planFingerprint: report.planFingerprint,
    changed: report.changed,
    affected: report.affected,
    gates: report.gates,
    checks: report.checks,
    gaps: report.gaps,
    notes: report.notes,
    waivers: report.waivers,
    errors: report.errors,
    createdAt: new Date().toISOString(),
  };
}

function reportHuman(report: RunChecksReport): void {
  info(`run-checks (base ${report.requestedBase}) — ${report.changed.length} changed file(s), ${report.checks.length} check(s)`);
  if (report.gates.length) info(`validation gates: ${report.gates.join(", ")}`);
  for (const id of report.passed) ok(id);
  for (const skipped of report.skipped) err(`${skipped.id}: NOT RUN — ${skipped.reason}`);
  for (const failure of report.failed) {
    err(`${failure.id}: FAILED (exit ${failure.code}) — ${failure.cmd}`);
    for (const line of failure.logTail.split("\n")) if (line) info(`       ${line}`);
  }
  for (const message of report.errors) err(message);

  const blocking = report.gaps.filter((gap) => gap.severity === "blocking");
  const advisory = report.gaps.filter((gap) => gap.severity === "advisory");
  if (blocking.length) info("\nblocking gaps:");
  for (const gap of blocking) {
    err(`[${gap.kind}] ${gap.where ? `${gap.where} — ` : ""}${gap.why}`);
    info(`       -> ${gap.suggestion}`);
  }
  if (advisory.length) info("\nadvisory gaps:");
  for (const gap of advisory) warn(`[${gap.kind}] ${gap.where ? `${gap.where} — ` : ""}${gap.why}`);
  for (const waiver of report.waivers) warn(`waived ${waiver.kind}:${waiver.where} — ${waiver.reason}`);
  for (const note of report.notes) info(`  NOTE ${note.message}`);

  info("");
  if (!report.ok) info(`run-checks: NOT VERIFIED (${report.status})`);
  else info(`run-checks: ${report.status.toUpperCase()} (${report.passed.length} passed, ${report.gaps.length} gap(s))`);
}

function matchingWaiver(waiver: StoredWaiver, fingerprint: string, gap: Gap): boolean {
  return isWaivableGap(gap) && waiver.fingerprint === fingerprint && waiver.kind === gap.kind && waiver.where === gap.where;
}

function buildReport(args: {
  changes: ChangeSet;
  plan: Plan;
  passed: string[];
  failed: Failure[];
  skipped: { id: string; reason: string }[];
  checks: CheckEvidence[];
  waivers: StoredWaiver[];
  errors: string[];
  session: string;
}): RunChecksReport {
  const { changes, plan, passed, failed, skipped, checks, waivers, errors, session } = args;
  const unwaivedBlocking = plan.gaps.filter(
    (gap) => gap.severity === "blocking" && !waivers.some((waiver) => matchingWaiver(waiver, changes.fingerprint, gap)),
  );
  const activeWaivers = waivers.filter((waiver) =>
    plan.gaps.some((gap) => gap.severity === "blocking" && matchingWaiver(waiver, changes.fingerprint, gap)),
  );
  let status: ValidationStatus;
  if (errors.length || failed.length || skipped.length || unwaivedBlocking.length) status = "not-verified";
  else if (changes.files.length === 0) status = "no-change";
  else if (activeWaivers.length) status = "verified-with-waivers";
  else if (plan.gaps.some((gap) => gap.severity === "advisory")) status = "verified-with-advisories";
  else status = "verified";

  return {
    schema: "ai-harness/run-checks/v1",
    status,
    ok: status !== "not-verified",
    requestedBase: changes.requestedBase,
    resolvedBase: changes.resolvedBase,
    fingerprint: changes.fingerprint,
    profile: plan.profile,
    planFingerprint: validationPlanFingerprint(plan),
    changed: changes.files,
    affected: plan.affected,
    gates: plan.gates,
    passed,
    failed,
    skipped,
    checks,
    gaps: plan.gaps,
    notes: plan.notes,
    waivers: activeWaivers,
    errors,
    session,
  };
}

function fallbackChanges(base: string): ChangeSet {
  return { requestedBase: base, resolvedBase: null, head: null, files: [], entries: [], fingerprint: "" };
}

export function runChecksCmd(repo: string, opts: RunChecksOpts): number {
  const errors: string[] = [];
  let session: ValidationSession | null = null;
  const implicitManualBase = !opts.session && opts.base === undefined && !opts.allowEmptyAsNoChange;
  let base = opts.base ?? "HEAD";
  let mode: "merge-base" | "exact" = opts.mode ?? "merge-base";

  if (opts.session) {
    try {
      session = readValidationSession(repo, opts.session);
    } catch (error) {
      errors.push(`validation session invalid: ${(error as Error).message}`);
    }
    if (!session) errors.push(`validation session not found: ${opts.session}`);
    else {
      base = session.baseSha ?? EMPTY_TREE_BASE;
      mode = "exact";
    }
  }

  let changes = fallbackChanges(base);
  if (!errors.length) {
    try {
      changes = collectChanges(repo, base, { mode });
    } catch (error) {
      const kind = error instanceof GitDiffError ? error.kind : "diff-failed";
      errors.push(`[${kind}] ${(error as Error).message}`);
    }
  }

  let manifest: Manifest | null = null;
  try {
    manifest = loadManifest(repo);
  } catch (error) {
    errors.push(`manifest-invalid: ${(error as Error).message}`);
  }
  const manifestErrors = manifest ? validateManifest(manifest).filter((issue) => issue.level === "error") : [];
  errors.push(...manifestErrors.map((issue) => `manifest-invalid: ${issue.msg}`));

  let plan = emptyPlan(changes.files);
  if (manifest && !manifestErrors.length && changes.fingerprint) {
    plan = planRepositoryChecks(repo, manifest, changes.entries, { profile: opts.profile });
  } else if (manifestErrors.length) {
    plan.gaps.push({
      kind: "manifest-invalid",
      where: ".agents/manifest.yaml",
      why: "manifest 校验失败，不能安全选择或执行 checks",
      suggestion: "先运行 doctor 并修复所有 manifest error",
      severity: "blocking",
    });
  } else if (errors.some((message) => /diff|base|git repo/.test(message))) {
    plan.gaps.push({
      kind: "diff-unavailable",
      where: base,
      why: "无法可靠计算本次改动",
      suggestion: "确认当前目录是 Git 仓库且 base ref 有效，然后重试",
      severity: "blocking",
    });
  }

  if (implicitManualBase && changes.fingerprint && changes.files.length === 0 && !errors.length) {
    plan.gaps.push({
      kind: "manual-base-required",
      where: "HEAD",
      why: "手动 run-checks 只看到当前工作区无改动，无法证明已经 commit 的任务内容被验收",
      suggestion: "传入任务开始时的 commit：run-checks --base <task-start-sha>；或使用 SessionStart + Stop 生命周期门禁",
      severity: "blocking",
    });
  }

  if (!session && changes.fingerprint) {
    try {
      session = manualValidationSession(repo, changes.resolvedBase, changes.fingerprint);
    } catch (error) {
      errors.push(`evidence state unavailable: ${(error as Error).message}`);
    }
  }

  if (opts.waive) {
    if (!opts.reason?.trim()) errors.push("waiver reason is required and cannot be empty");
    if (!opts.where?.trim()) errors.push("waiver scope is required; pass --where <scope>");
    const matchingGaps = opts.where?.trim()
      ? plan.gaps.filter((gap) => gap.severity === "blocking" && gap.kind === opts.waive && gap.where === opts.where!.trim())
      : [];
    const candidates = matchingGaps.filter(isWaivableGap);
    if (opts.where?.trim() && matchingGaps.length > 0 && candidates.length === 0)
      errors.push(
        `gap ${opts.waive}:${opts.where.trim()} cannot be waived; only missing-test-touch, module-without-tests, and unmapped-required-file are waivable`,
      );
    else if (opts.where?.trim() && candidates.length === 0)
      errors.push(`no waivable blocking gap matches ${opts.waive}:${opts.where.trim()}`);
    if (session && opts.reason?.trim() && candidates.length === 1) {
      const gap = candidates[0]!;
      session = recordWaiver(repo, session, {
        fingerprint: changes.fingerprint,
        kind: gap.kind,
        where: gap.where,
        reason: opts.reason.trim(),
        createdAt: new Date().toISOString(),
      });
    }
  }

  const passed: string[] = [];
  const failed: Failure[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const checks: CheckEvidence[] = [];
  const capabilities = manifest?.capabilities ?? {};
  // budgetMs === 0 → unlimited (deliver). Otherwise default 7 minutes for bare run-checks.
  const unlimitedBudget = opts.budgetMs === 0;
  const checkDeadline = unlimitedBudget
    ? Number.POSITIVE_INFINITY
    : Date.now() + (opts.budgetMs !== undefined && opts.budgetMs > 0 ? opts.budgetMs : CHECK_BUDGET_MS);

  if (!errors.length) {
    for (const check of plan.checks) {
      const remainingMs = checkDeadline - Date.now();
      if (!unlimitedBudget && remainingMs <= 0) {
        const reason = "run-checks 的检查总预算已耗尽；复杂任务请用 harness-kit deliver（无紧总预算）";
        skipped.push({ id: check.id, reason });
        checks.push({ id: check.id, status: "not-run", exitCode: 1, durationMs: 0 });
        plan.gaps.push({
          kind: "selected-check-not-run",
          where: check.id,
          why: reason,
          suggestion: "使用 harness-kit deliver 做任务验收，或拆分快速自动门禁",
          severity: "blocking",
        });
        continue;
      }
      const cap = capabilities[check.id];
      if (!cap || cap.mutating || cap.background) {
        const reason = !cap ? "capability 未声明" : cap.mutating ? "mutating capability 不可自动执行" : "background capability 不可自动执行";
        skipped.push({ id: check.id, reason });
        checks.push({ id: check.id, status: "not-run", exitCode: 1, durationMs: 0 });
        plan.gaps.push({
          kind: "selected-check-not-run",
          where: check.id,
          why: reason,
          suggestion: "把自动 checks 改为可终止、无副作用的 capability；其他验证留在 routing/manual gap",
          severity: "blocking",
        });
        continue;
      }
      const result = runOne(repo, cap.run, unlimitedBudget ? 0 : remainingMs);
      checks.push({ id: check.id, status: result.ok ? "passed" : "failed", exitCode: result.code, durationMs: result.durationMs });
      if (result.ok) passed.push(check.id);
      else failed.push({ id: check.id, cmd: cap.run, code: result.code, logTail: result.logTail, durationMs: result.durationMs });
    }
  }

  if (checks.length && changes.fingerprint) {
    try {
      const afterChecks = collectChanges(repo, base, { mode });
      if (afterChecks.fingerprint !== changes.fingerprint)
        errors.push("change fingerprint changed while checks were running; discard this evidence and rerun on the stable change");
    } catch (error) {
      errors.push(`post-check fingerprint failed: ${(error as Error).message}`);
    }
  }

  let report = buildReport({
    changes,
    plan,
    passed,
    failed,
    skipped,
    checks,
    waivers: session?.waivers ?? [],
    errors,
    session: session?.token ?? "",
  });

  if (session) {
    try {
      recordValidationEvidence(repo, session, evidenceOf(report));
    } catch (error) {
      report = { ...report, status: "not-verified", ok: false, errors: [...report.errors, `evidence write failed: ${(error as Error).message}`] };
    }
  }

  if (opts.json) outputJson(report);
  else reportHuman(report);
  return report.ok ? 0 : 1;
}
