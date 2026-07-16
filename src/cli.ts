#!/usr/bin/env node
import { Command } from "commander";
import { resolve } from "node:path";
import pkg from "../package.json";
import { initCmd } from "./commands/init";
import { syncCmd } from "./commands/sync";
import { doctorCmd } from "./commands/doctor";
import { verifyCmd } from "./commands/verify";
import { acceptContractCmd } from "./commands/accept";
import { checkLoopCmd } from "./commands/check-loop";
import { evidenceCmd } from "./commands/evidence";
import { hookEventCmd } from "./commands/hook-event";
import { installHooksCmd } from "./commands/install-hooks";
import { onboardCmd } from "./commands/onboard";
import { planChecksCmd } from "./commands/plan-checks";
import { runChecksCmd } from "./commands/run-checks";
import { recordContextReviewCmd } from "./commands/record-context-review";
import { prepareAdoptionCmd } from "./commands/prepare-adoption";
import { recordAdoptionAuditCmd } from "./commands/record-adoption-audit";
import { upgradeCmd } from "./commands/upgrade";
import { deliverCmd } from "./commands/deliver";
import { taskStartCmd, taskStatusCmd } from "./commands/task";
import { ALL_AGENTS, type AgentTool } from "./commands/stop-hooks";

function guard(fn: () => void | number): void {
  try {
    const code = fn();
    if (typeof code === "number") process.exitCode = code;
  } catch (e) {
    console.error(`  ERR  ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

const program = new Command();
program.name("harness-kit").description("AI-friendly repo harness").version(pkg.version);

const repoOf = (o: { repo?: string }) => resolve(o.repo ?? process.cwd());

function agentList(value: string): AgentTool[] {
  const agents = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const invalid = agents.filter((agent) => !ALL_AGENTS.includes(agent as AgentTool));
  if (!agents.length || invalid.length) throw new Error(`invalid --agents value; supported: ${ALL_AGENTS.join(",")}`);
  return agents as AgentTool[];
}

program
  .command("init")
  .description("scaffold .agents/ skeleton + starter manifest")
  .option("-C, --repo <dir>", "target repo dir (default: current directory)")
  .option("--name <name>", "project name", "my-project")
  .option("--force", "overwrite existing manifest", false)
  .action((o) => guard(() => initCmd(repoOf(o), o.name, o.force)));

program
  .command("sync")
  .description("generate tool files (AGENTS.md, CLAUDE.md) from manifest")
  .option("-C, --repo <dir>", "target repo dir (default: current directory)")
  .option("--adopt-existing", "apply only a content-bound, pass-attested legacy adoption", false)
  .option("--candidate <dir>", "prepared adoption bundle outside the repository")
  .option("--audit <receipt>", "pass audit receipt bound to the candidate bundle")
  .action((o) =>
    guard(() =>
      syncCmd(repoOf(o), {
        adoptExisting: o.adoptExisting,
        adoptionCandidate: o.candidate,
        adoptionAudit: o.audit,
      }),
    ),
  );

program
  .command("upgrade")
  .description("upgrade this repository to the running harness-kit version")
  .option("-C, --repo <dir>", "target repo dir (default: current directory)")
  .option("--check", "read-only; exit 2 when an upgrade is available", false)
  .option("--json", "machine-readable single-report output", false)
  .action((o) => guard(() => upgradeCmd(repoOf(o), { check: o.check, json: o.json })));

program
  .command("prepare-adoption")
  .description("render a private, repository-external candidate bundle for blind legacy review")
  .option("-C, --repo <dir>", "target repo dir (default: current directory)")
  .requiredOption("--out <dir>", "new or empty output directory outside the repository")
  .option("--json", "machine-readable output", false)
  .action((o) => guard(() => prepareAdoptionCmd(repoOf(o), { output: o.out, json: o.json })));

program
  .command("record-adoption-audit")
  .description("record a declared pass/fail review receipt bound to one adoption candidate and report")
  .option("-C, --repo <dir>", "target repo dir (default: current directory)")
  .requiredOption("--candidate <dir>", "prepared adoption bundle outside the repository")
  .requiredOption("--verdict <pass|fail>", "declared audit verdict")
  .requiredOption("--report <file>", "independent audit report to hash and bind")
  .requiredOption("--reason <text>", "non-empty reviewer rationale")
  .option("--out <receipt>", "receipt path outside the repository (default: candidate bundle)")
  .option("--json", "machine-readable output", false)
  .action((o) =>
    guard(() =>
      recordAdoptionAuditCmd(repoOf(o), {
        candidate: o.candidate,
        verdict: o.verdict,
        report: o.report,
        reason: o.reason,
        receipt: o.out,
        json: o.json,
      }),
    ),
  );

program
  .command("doctor")
  .description("dev-time health check: completeness, drift, freshness, tech debt")
  .option("-C, --repo <dir>", "target repo dir (default: current directory)")
  .option("--details", "show every declared verification boundary and maintenance action", false)
  .action((o) => guard(() => doctorCmd(repoOf(o), { details: o.details })));

program
  .command("verify")
  .description("CI gate: run enforceable invariants + contracts + drift; nonzero on failure")
  .option("-C, --repo <dir>", "target repo dir (default: current directory)")
  .option("--json", "machine-readable output", false)
  .option("--details", "show every declared verification boundary and maintenance action", false)
  .action((o) => guard(() => verifyCmd(repoOf(o), { json: o.json, details: o.details })));

program
  .command("plan-checks")
  .description("compute which declared checks THIS change should run (impact-driven, executes nothing)")
  .option("-C, --repo <dir>", "target repo dir (default: current directory)")
  .option("--base <ref>", "diff base (default: working tree + untracked vs HEAD)", "HEAD")
  .option("--profile <checkset>", "use a validation.checksets entry instead of per-module checks")
  .option("--json", "machine-readable output", false)
  .action((o) => guard(() => planChecksCmd(repoOf(o), { base: o.base, json: o.json, profile: o.profile })));

program
  .command("task")
  .description("manage the worktree task base used by deliver (optional; SessionStart also sets it)")
  .option("-C, --repo <dir>", "target repo dir (default: current directory)")
  .option("--json", "machine-readable output", false)
  .action((o) => guard(() => taskStatusCmd(repoOf(o), { json: o.json })));

program
  .command("task-start")
  .description("record task-start base SHA for this worktree so deliver covers later commits")
  .option("-C, --repo <dir>", "target repo dir (default: current directory)")
  .option("--base <ref>", "override base (default: current HEAD)")
  .option("--note <text>", "optional task note")
  .option("--json", "machine-readable output", false)
  .action((o) => guard(() => taskStartCmd(repoOf(o), { base: o.base, note: o.note, json: o.json })));

program
  .command("deliver")
  .description("accept this task change: resolve scope → run-checks + verify → stamp (preferred finish gate)")
  .option("-C, --repo <dir>", "target repo dir (default: current directory)")
  .option("--base <ref>", "explicit task base (overrides task record)")
  .option("--profile <checkset>", "use a validation.checksets entry instead of per-module checks")
  .option("--json", "machine-readable output", false)
  .action((o) =>
    guard(() =>
      deliverCmd(repoOf(o), {
        base: o.base,
        profile: o.profile,
        json: o.json,
      }),
    ),
  );

program
  .command("run-checks")
  .description("plan + run resolved checks; record evidence; nonzero on failure/unresolved blocking gap")
  .option("-C, --repo <dir>", "target repo dir (default: current directory)")
  .option("--base <ref>", "task-start ref; required for manual proof after task changes were committed")
  .option("--profile <checkset>", "use a validation.checksets entry instead of per-module checks")
  .option("--waive <kind>", "waive one eligible coverage gap for this exact change fingerprint")
  .option("--where <scope>", "exact gap scope; required when a kind matches multiple gaps")
  .option("--reason <text>", "reason recorded with --waive")
  .option("--session <token>", "validation session token (normally supplied by an agent hook)")
  .option("--json", "machine-readable output", false)
  .action((o) =>
    guard(() =>
      runChecksCmd(repoOf(o), {
        base: o.base,
        json: o.json,
        profile: o.profile,
        waive: o.waive,
        where: o.where,
        reason: o.reason,
        session: o.session,
      }),
    ),
  );

program
  .command("evidence")
  .description("show the latest durable delivery stamp / run-checks evidence for this worktree/session")
  .option("-C, --repo <dir>", "target repo dir (default: current directory)")
  .option("--session <token>", "specific validation session token")
  .option("--json", "machine-readable output", false)
  .action((o) => guard(() => evidenceCmd(repoOf(o), { session: o.session, json: o.json })));

program
  .command("record-context-review")
  .description("record an Agent's completed review of one knowledge item or module against its bound sources")
  .option("-C, --repo <dir>", "target repo dir (default: current directory)")
  .option("--path <knowledge-path>", "exact knowledge.path from the manifest")
  .option("--module <name>", "exact module name (mutually exclusive with --path)")
  .requiredOption("--reason <text>", "what was reviewed and why the context remains correct")
  .option("--session <token>", "Agent/session identifier to keep with the review evidence")
  .option("--json", "machine-readable output", false)
  .action((o) =>
    guard(() =>
      recordContextReviewCmd(repoOf(o), {
        path: o.path,
        module: o.module,
        reason: o.reason,
        session: o.session,
        json: o.json,
      }),
    ),
  );

program
  .command("accept-contract")
  .description("record current contract fingerprint(s) as the accepted baseline (after an intended change)")
  .option("-C, --repo <dir>", "target repo dir (default: current directory)")
  .option("--id <id>", "only this contract (default: all with a snapshot command)")
  .action((o) => guard(() => acceptContractCmd(repoOf(o), o.id)));

program
  .command("install-hooks")
  .description("install git hooks and/or agent SessionStart + Stop hooks (run-checks + verify gate)")
  .option("-C, --repo <dir>", "target repo dir (default: current directory)")
  .option("--git", "install git hooks (default when no selector given)")
  .option("--stop", "install agent SessionStart + Stop hooks (Claude Code / Cursor / Codex)")
  .option("--agents <list>", "comma list of agent tools for --stop: claude,cursor,codex (default: all)")
  .option("--force", "refresh harness-kit-managed hooks; never overwrite foreign hooks", false)
  .option("--allow-shared-git-hooks", "acknowledge native hooks affect every linked worktree", false)
  .option(
    "--allow-user-dispatcher",
    "allow the safe CODEX_HOME dispatcher required by Codex in linked worktrees",
    false,
  )
  .action((o) =>
    guard(() =>
      installHooksCmd(repoOf(o), {
        force: o.force,
        git: o.git,
        stop: o.stop,
        agents: o.agents ? agentList(String(o.agents)) : undefined,
        allowSharedGitHooks: o.allowSharedGitHooks,
        allowUserDispatcher: o.allowUserDispatcher,
      }),
    ),
  );

program
  .command("onboard")
  .description("print the erzhe-harness-init skill for an agent to follow (use via npx, always latest)")
  .action(() => guard(() => onboardCmd()));

program
  .command("check-loop")
  .description("print the harness-check-loop skill: the implement -> verify loop for an agent")
  .action(() => guard(() => checkLoopCmd()));

program
  .command("hook-event", { hidden: true })
  .description("internal lifecycle hook adapter")
  .requiredOption("-C, --repo <dir>", "target repo dir")
  .requiredOption("--agent <agent>", "claude, cursor, or codex")
  .requiredOption("--event <event>", "session-start or stop")
  .action((o) =>
    guard(() => {
      const agent = String(o.agent);
      const event = String(o.event);
      if (!ALL_AGENTS.includes(agent as AgentTool)) throw new Error(`invalid --agent value: ${agent}`);
      if (event !== "session-start" && event !== "stop") throw new Error(`invalid --event value: ${event}`);
      return hookEventCmd(repoOf(o), { agent: agent as AgentTool, event });
    }),
  );

program.parseAsync();
