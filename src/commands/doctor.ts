import fg from "fast-glob";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildHarnessGuidance } from "../guidance";
import { inspectAgentHookStatus } from "../hook-status";
import { loadManifest, validateManifest } from "../manifest";
import { inspectManagedFiles } from "../managed-files";
import { renderAgentsMd, renderTargets } from "../render";
import { inspectContextFreshness, readState, resolveKnowledgePath } from "../state";
import { err, info, ok, warn } from "../util";
import { inspectValidationGateHealth } from "../validation-gates";

// AGENTS.md must stay short (progressive disclosure): it is an index, not a dump.
const AGENTS_MAX_LINES = 150;
const AGENTS_MAX_WORDS = 700;

export interface DoctorOpts {
  details?: boolean;
}

export function doctorCmd(repo: string, opts: DoctorOpts = {}): number {
  let problems = 0;
  const m = loadManifest(repo);

  info("1) Manifest validation");
  const issues = validateManifest(m);
  if (!issues.length) ok("schema looks good");
  for (const i of issues) {
    if (i.level === "error") {
      err(i.msg);
      problems++;
    } else {
      warn(i.msg);
    }
  }
  if (issues.some((issue) => issue.level === "error")) {
    info("\ndoctor: manifest is invalid; fix schema errors before deeper checks");
    return 1;
  }
  // Guard against a "vacuous pass": an enforcement whose path_glob matches no
  // files silently passes `verify` while checking nothing — worse than no gate.
  for (const inv of m.invariants ?? []) {
    if (!inv.enforcement) continue;
    const globs = inv.enforcement.path_glob?.length ? inv.enforcement.path_glob : ["**/*"];
    const n = fg.sync(globs, {
      cwd: repo,
      onlyFiles: true,
      dot: false,
      ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
    }).length;
    if (n === 0 && !inv.enforcement.allow_empty)
      warn(`invariant ${inv.id}: enforcement path_glob matches 0 files — passes without checking anything (wrong path_glob for this repo layout?)`);
  }
  // Map rot: a module.owns glob that matches nothing means the impact planner
  // will never select this module — a silent hole in the implement->verify loop.
  for (const mod of m.modules ?? []) {
    if (!mod.owns?.length) continue;
    const n = fg.sync(mod.owns, {
      cwd: repo,
      onlyFiles: true,
      dot: true,
      ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
    }).length;
    if (n === 0)
      warn(`module ${mod.name}: owns glob matches 0 files — impact planner can never select it (stale owns for this layout?)`);
  }
  for (const glob of m.validation?.required_coverage ?? []) {
    const n = fg.sync(glob, {
      cwd: repo,
      onlyFiles: true,
      dot: true,
      ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
    }).length;
    if (n === 0)
      warn(`validation.required_coverage glob matches 0 files: ${glob} — a typo here silently weakens unmapped-file protection`);
  }
  for (const issue of inspectValidationGateHealth(repo, m)) {
    const message = `validation gate ${issue.gate}: ${issue.message}`;
    if (issue.level === "error") {
      err(message);
      problems++;
    } else {
      warn(message);
    }
  }

  info("\n2) Referenced paths");
  const checkPath = (rel: string, label: string) => {
    if (existsSync(join(repo, ".agents", rel))) ok(`${label}: ${rel}`);
    else {
      err(`${label} missing: .agents/${rel}`);
      problems++;
    }
  };
  // repo-relative path referenced by routing/modules (e.g. src/server.ts).
  // wantFile=true for entry/binds: they hash a file for freshness, so pointing
  // at a directory is a config mistake — warn instead of silently OK-ing it.
  const checkRepoPath = (rel: string, label: string, wantFile = false) => {
    const abs = join(repo, rel);
    if (!existsSync(abs)) {
      err(`${label} points at a missing path: ${rel}`);
      problems++;
    } else if (wantFile && statSync(abs).isDirectory()) {
      warn(`${label}: ${rel} is a directory — entry/binds should be a file (freshness hashes file content)`);
    } else ok(`${label}: ${rel}`);
  };
  const checkRepoPointer = (pointer: string, label: string) => {
    if (!fg.isDynamicPattern(pointer)) return checkRepoPath(pointer, label);
    const matches = fg.sync(pointer, {
      cwd: repo,
      onlyFiles: false,
      dot: true,
      followSymbolicLinks: false,
      ignore: ["**/node_modules/**", "**/.git/**", "**/dist/**"],
    });
    if (!matches.length) {
      err(`${label} glob matches 0 paths: ${pointer}`);
      problems++;
    } else ok(`${label} glob: ${pointer} (${matches.length} match(es))`);
  };
  for (const k of m.knowledge ?? []) {
    let knowledgePath: string;
    try {
      knowledgePath = resolveKnowledgePath(repo, k);
    } catch (error) {
      err((error as Error).message);
      problems++;
      continue;
    }
    if (existsSync(knowledgePath)) ok(`knowledge: ${k.path}`);
    else {
      err(`knowledge missing: ${k.root === "repo" ? "" : ".agents/"}${k.path}`);
      problems++;
    }
    for (const b of new Set(k.binds ?? [])) checkRepoPath(b, `knowledge "${k.path}" binds`, true);
  }
  if (m.playbooks?.dir) checkPath(m.playbooks.dir, "playbooks");
  // routing read/entry are navigation pointers (NOT freshness-bound) — dirs OK.
  for (const r of m.routing ?? [])
    for (const p of new Set([...(r.read ?? []), ...(r.entry ?? [])])) checkRepoPointer(p, `routing "${r.when}"`);
  for (const mod of m.modules ?? [])
    for (const p of new Set(mod.entry ?? [])) checkRepoPath(p, `module ${mod.name}`, true);
  // module.playbook must resolve to a real file (tries <playbooks.dir>, .agents/, repo-relative).
  for (const mod of m.modules ?? []) {
    if (!mod.playbook) continue;
    const candidates = [
      m.playbooks?.dir ? join(repo, ".agents", m.playbooks.dir, mod.playbook) : "",
      join(repo, ".agents", mod.playbook),
      join(repo, mod.playbook),
    ].filter(Boolean);
    if (candidates.some((c) => existsSync(c))) ok(`module ${mod.name} playbook: ${mod.playbook}`);
    else {
      err(`module ${mod.name} playbook missing: ${mod.playbook} (looked in ${m.playbooks?.dir ? `.agents/${m.playbooks.dir}/, ` : ""}.agents/, repo root)`);
      problems++;
    }
  }

  info("\n3) Generated files drift");
  try {
    for (const inspection of inspectManagedFiles(repo, renderTargets(m))) {
      if (inspection.kind === "missing") warn(`${inspection.relativePath} not generated yet (run \`harness-kit sync\`)`);
      else if (!inspection.satisfiesDesired) {
        err(`${inspection.relativePath} drifted from manifest (run \`harness-kit sync\`)`);
        problems++;
      } else if (inspection.kind === "allowed-alias") ok(`${inspection.relativePath} semantic alias -> AGENTS.md`);
      else ok(`${inspection.relativePath} in sync`);
    }
  } catch (error) {
    err(`generated-file safety check failed: ${(error as Error).message}`);
    problems++;
  }

  info("\n4) Knowledge freshness");
  const prev = readState(repo);
  const boundCount = (m.knowledge ?? []).filter((item) => item.binds?.length || item.authority).length +
    (m.modules ?? []).filter((item) => item.entry?.length).length;
  if (boundCount === 0) {
    ok("no knowledge bound to source files (nothing to drift)");
  } else {
    const freshness = inspectContextFreshness(repo, m);
    if (!prev && !(m.knowledge ?? []).some((item) => item.authority))
      warn("no legacy freshness baseline yet; use `record-context-review` for durable Agent-reviewed context");
    for (const issue of freshness) {
      const changed = issue.changedSources.length ? ` -> ${issue.changedSources.join(", ")}` : "";
      const message = `${issue.key}: ${issue.reason}${changed}`;
      if (issue.severity === "blocking") {
        err(message);
        problems++;
      } else warn(message);
    }
    if (!freshness.length) ok("no knowledge drift");
  }

  const declaredGuidance = buildHarnessGuidance({ manifest: m });
  info("\n5) Declared verification boundaries");
  if (!declaredGuidance.gapSummary.total) ok("no declared verification boundaries");
  else {
    info(
      `${declaredGuidance.gapSummary.total} declared: ${declaredGuidance.gapSummary.recommended} automation improvement(s), ` +
        `${declaredGuidance.gapSummary.informational} check(s) only when relevant; these are not health failures`,
    );
    if (opts.details) {
      for (const gap of declaredGuidance.gapDetails) {
        const text = `[${gap.classification.toUpperCase()}] ${gap.title} — ${gap.when} ${gap.reason}`;
        if (gap.classification === "recommended") warn(text);
        else info(text);
      }
    } else info("       details: `harness-kit doctor --details`");
  }

  info("\n6) AGENTS.md size budget (must stay short — agents read it every session)");
  const agents = renderAgentsMd(m);
  const nLines = agents.split("\n").length;
  const nWords = agents.trim().split(/\s+/).length;
  if (nLines > AGENTS_MAX_LINES || nWords > AGENTS_MAX_WORDS) {
    warn(
      `AGENTS.md is ${nLines} lines / ${nWords} words (budget ${AGENTS_MAX_LINES}/${AGENTS_MAX_WORDS}). ` +
        "Move detail into .agents/knowledge/ and keep AGENTS.md as an index.",
    );
  } else {
    ok(`AGENTS.md ${nLines} lines / ${nWords} words (within budget)`);
  }

  info("\n7) Agent lifecycle hooks");
  const hooks = inspectAgentHookStatus(repo);
  const configuredAgents = hooks.configuredAgents.length ? hooks.configuredAgents.join(", ") : "none";
  if (hooks.state === "active") {
    ok(`ACTIVE — ${hooks.evidenceAgent} observed on Stop; configured: ${configuredAgents} (optional intercept; task gate is deliver)`);
  } else if (hooks.state === "configured") {
    warn(`CONFIGURED — ${configuredAgents}; optional intercept not yet observed. Task acceptance: harness-kit deliver`);
  } else {
    warn(`DEGRADED — configured: ${configuredAgents}; ${hooks.issues.join("; ")}`);
  }

  const guidance = buildHarnessGuidance({ manifest: m, hooks });
  const visibleActions = opts.details
    ? guidance.nextActions
    : guidance.nextActions.filter((action) => action.priority === "required");
  info("\nNEXT ACTIONS");
  if (!visibleActions.length) ok("nothing required now");
  for (const action of visibleActions) {
    warn(`[${action.priority.toUpperCase()} | ${action.owner.toUpperCase()}] ${action.title}`);
    info(`       why: ${action.reason}`);
    info(`       when: ${action.when}`);
    for (const command of action.commands) info(`       run: ${command}`);
    info(`       done when: ${action.completion}`);
  }
  const hiddenRecommended = guidance.nextActions.length - visibleActions.length;
  if (hiddenRecommended > 0)
    info(`       ${hiddenRecommended} recommended maintenance action(s) hidden; use \`--details\` to view`);

  info("");
  const requiredActions = guidance.nextActions.filter((action) => action.priority === "required");
  if (problems) {
    info(`doctor: ${problems} problem(s) found`);
    if (requiredActions.length) warn(`Harness readiness: INCOMPLETE (${requiredActions.length} required action(s) above)`);
    return 1;
  }
  info("doctor: repository configuration healthy");
  if (requiredActions.length) warn(`Harness readiness: INCOMPLETE (${requiredActions.length} required action(s) above)`);
  else ok("Harness readiness: READY");
  return 0;
}
