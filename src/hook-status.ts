import { lstatSync } from "node:fs";
import { join } from "node:path";
import { inspectCodexLinkedHooks, isLinkedGitWorktree } from "./codex-linked-hooks";
import { collectChanges, EMPTY_TREE_BASE } from "./git";
import { inspectManagedFiles } from "./managed-files";
import { readLatestHookValidationSession } from "./validation-state";
import { sha256 } from "./util";
import {
  installedAgentHookRunnerScript,
  isInstalledAgentHookCommand,
  type AgentTool,
} from "./commands/stop-hooks";

export type AgentHookState = "configured" | "active" | "degraded";

export interface AgentHookStatus {
  state: AgentHookState;
  configuredAgents: AgentTool[];
  evidenceAgent?: AgentTool;
  evidenceAt?: string;
  issues: string[];
}

const RUNNER_REL = ".agents/hooks/harness-agent-hook.sh";
const COMMAND_MARK = "harness-agent-hook.sh";

interface SafeProjectText {
  exists: boolean;
  content: string | null;
}

function safeProjectText(repo: string, rel: string, issues: string[]): SafeProjectText {
  try {
    const inspection = inspectManagedFiles(repo, [[rel, ""]])[0]!;
    return { exists: inspection.kind !== "missing", content: inspection.currentContent };
  } catch (error) {
    issues.push(`${rel} is not a safe project-local regular file: ${(error as Error).message}`);
    return { exists: true, content: null };
  }
}

function parsedJson(rel: string, raw: string, issues: string[]): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // Report one actionable structural issue below.
  }
  issues.push(`${rel} is not valid hook JSON`);
  return null;
}

function managedCommand(
  value: unknown,
  agent: AgentTool,
  event: "session-start" | "stop",
): boolean {
  return !!value && typeof value === "object" && typeof (value as { command?: unknown }).command === "string" &&
    isInstalledAgentHookCommand((value as { command: string }).command, agent, event);
}

function groupEventConfigured(value: unknown, agent: "claude" | "codex", event: "session-start" | "stop"): boolean {
  return Array.isArray(value) && value.some((group) => {
    if (!group || typeof group !== "object" || !Array.isArray((group as { hooks?: unknown }).hooks)) return false;
    return ((group as { hooks: unknown[] }).hooks).some((hook) =>
      (hook as { type?: unknown })?.type === "command" && managedCommand(hook, agent, event));
  });
}

function cursorEventConfigured(value: unknown, event: "session-start" | "stop"): boolean {
  return Array.isArray(value) && value.some((hook) => managedCommand(hook, "cursor", event));
}

function groupStyleConfigured(repo: string, rel: string, agent: "claude" | "codex", issues: string[]): boolean {
  const inspected = safeProjectText(repo, rel, issues);
  const raw = inspected.content;
  if (!inspected.exists || raw === null || !raw.includes(COMMAND_MARK)) return false;
  const json = parsedJson(rel, raw, issues);
  if (!json) return false;
  const hooks = json.hooks as Record<string, unknown> | undefined;
  const start = groupEventConfigured(hooks?.SessionStart, agent, "session-start");
  const stop = groupEventConfigured(hooks?.Stop, agent, "stop");
  if (!start || !stop) issues.push(`${agent}: ${rel} does not contain both managed SessionStart and Stop hooks`);
  return start && stop;
}

function cursorConfigured(repo: string, issues: string[]): boolean {
  const rel = ".cursor/hooks.json";
  const inspected = safeProjectText(repo, rel, issues);
  const raw = inspected.content;
  if (!inspected.exists || raw === null || !raw.includes(COMMAND_MARK)) return false;
  const json = parsedJson(rel, raw, issues);
  if (!json) return false;
  const hooks = json.hooks as Record<string, unknown> | undefined;
  const start = cursorEventConfigured(hooks?.sessionStart, "session-start");
  const stop = cursorEventConfigured(hooks?.stop, "stop");
  if (!start || !stop) issues.push(`cursor: ${rel} does not contain both managed sessionStart and stop hooks`);
  return start && stop;
}

function codexFeatureEnabled(repo: string, issues: string[]): boolean {
  const rel = ".codex/config.toml";
  const inspected = safeProjectText(repo, rel, issues);
  const raw = inspected.content;
  if (!inspected.exists || raw === null) {
    issues.push(`codex: ${rel} is missing while Codex hooks are configured`);
    return false;
  }
  let inFeatures = false;
  let enabled = false;
  for (const line of raw.split(/\r?\n/)) {
    if (/^\s*\[features\]\s*(?:#.*)?$/.test(line)) {
      inFeatures = true;
      continue;
    }
    if (inFeatures && /^\s*\[.+\]\s*(?:#.*)?$/.test(line)) break;
    if (inFeatures && /^\s*(?:hooks|codex_hooks)\s*=\s*true\s*(?:#.*)?$/.test(line)) enabled = true;
  }
  if (!enabled) issues.push(`codex: ${rel} does not enable project hooks`);
  return enabled;
}

function runnerReady(repo: string, issues: string[]): boolean {
  const path = join(repo, RUNNER_REL);
  try {
    const inspected = safeProjectText(repo, RUNNER_REL, issues);
    if (!inspected.exists) {
      issues.push(`${RUNNER_REL} runner is missing`);
      return false;
    }
    if (inspected.content === null) return false;
    const stat = lstatSync(path);
    const withoutOptionalFinalNewline = (value: string): string => value.endsWith("\n") ? value.slice(0, -1) : value;
    const ready = stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o100) !== 0 &&
      withoutOptionalFinalNewline(inspected.content) === withoutOptionalFinalNewline(installedAgentHookRunnerScript());
    if (!ready) issues.push(`${RUNNER_REL} is not a managed executable runner`);
    return !!ready;
  } catch {
    issues.push(`${RUNNER_REL} runner is missing`);
    return false;
  }
}

/** Bind ACTIVE evidence to the exact runner and project-local client files
 * that were present when SessionStart ran. Entire file bytes are intentional:
 * an override or neighboring hook edit must earn fresh lifecycle evidence. */
export function agentHookConfigurationFingerprint(repo: string, agent: AgentTool): string | null {
  const issues: string[] = [];
  if (!runnerReady(repo, issues)) return null;
  let configured = false;
  let linkedArtifacts: Array<{ path: string; content: string; mode?: number }> = [];
  const rels = [RUNNER_REL];
  if (agent === "claude") {
    configured = groupStyleConfigured(repo, ".claude/settings.json", "claude", issues);
    rels.push(".claude/settings.json");
  } else if (agent === "cursor") {
    configured = cursorConfigured(repo, issues);
    rels.push(".cursor/hooks.json");
  } else {
    const projectConfigured = groupStyleConfigured(repo, ".codex/hooks.json", "codex", issues) && codexFeatureEnabled(repo, issues);
    if (projectConfigured && isLinkedGitWorktree(repo)) {
      const linked = inspectCodexLinkedHooks(repo);
      configured = linked.configured;
      linkedArtifacts = linked.artifacts;
    } else {
      configured = projectConfigured;
    }
    rels.push(".codex/hooks.json", ".codex/config.toml");
  }
  if (!configured) return null;
  const artifacts: Array<{ path: string; content: string; mode?: number }> = [];
  for (const rel of rels) {
    const inspected = safeProjectText(repo, rel, issues);
    if (!inspected.exists || inspected.content === null) return null;
    artifacts.push({
      path: rel,
      content: inspected.content,
      ...(rel === RUNNER_REL ? { mode: lstatSync(join(repo, rel)).mode & 0o7777 } : {}),
    });
  }
  artifacts.push(...linkedArtifacts);
  return sha256(JSON.stringify({ agent, artifacts }));
}

export function inspectAgentHookStatus(repo: string): AgentHookStatus {
  const issues: string[] = [];
  const runner = runnerReady(repo, issues);
  const configuredAgents: AgentTool[] = [];

  if (groupStyleConfigured(repo, ".claude/settings.json", "claude", issues)) configuredAgents.push("claude");
  if (cursorConfigured(repo, issues)) configuredAgents.push("cursor");
  const codexGroup = groupStyleConfigured(repo, ".codex/hooks.json", "codex", issues);
  if (codexGroup && codexFeatureEnabled(repo, issues)) {
    if (isLinkedGitWorktree(repo)) {
      const linked = inspectCodexLinkedHooks(repo);
      issues.push(...linked.issues);
      if (linked.configured) configuredAgents.push("codex");
    } else {
      configuredAgents.push("codex");
    }
  }

  if (!configuredAgents.length) issues.push("no complete effective Agent SessionStart + Stop hook pair is configured");

  let evidenceAgent: AgentTool | undefined;
  let evidenceAt: string | undefined;
  let evidenceInvalid = false;
  try {
    const session = readLatestHookValidationSession(repo);
    const evidence = session?.lastEvidence;
    if (session && session.agent !== "manual" && evidence) {
      evidenceAgent = session.agent;
      evidenceAt = evidence.createdAt;
      let currentFingerprint = "";
      try {
        currentFingerprint = collectChanges(repo, evidence.resolvedBase ?? EMPTY_TREE_BASE, { mode: "exact" }).fingerprint;
      } catch (error) {
        issues.push(`cannot refresh lifecycle evidence: ${(error as Error).message}`);
      }
      const stale = !currentFingerprint || currentFingerprint !== evidence.fingerprint;
      const runChecksValid =
        (evidence.runChecksStatus !== undefined
          ? evidence.runChecksStatus !== "not-verified"
          : evidence.ok && evidence.status !== "not-verified") && !stale;
      const valid = runChecksValid && evidence.verifyPassed === true;
      if (!valid) {
        evidenceInvalid = true;
        issues.push(stale ? "latest lifecycle evidence is stale" : "latest lifecycle evidence did not pass both gates");
      } else if (!configuredAgents.includes(session.agent)) {
        evidenceInvalid = true;
        issues.push(`latest lifecycle evidence came from ${session.agent}, but that project hook is no longer configured`);
      } else if (!session.hookConfigFingerprint) {
        evidenceInvalid = true;
        issues.push("latest lifecycle evidence predates hook configuration binding; start a new Agent session");
      } else if (agentHookConfigurationFingerprint(repo, session.agent) !== session.hookConfigFingerprint) {
        evidenceInvalid = true;
        issues.push(`latest lifecycle evidence from ${session.agent} belongs to a different hook configuration`);
      }
    }
  } catch (error) {
    issues.push(`cannot read lifecycle evidence: ${(error as Error).message}`);
    evidenceInvalid = true;
  }

  const structurallyReady = runner && configuredAgents.length > 0 && !issues.some((issue) =>
    issue.includes("not valid hook JSON") ||
    issue.includes("does not contain both") ||
    issue.includes("does not enable") ||
    issue.includes("is missing while") ||
    issue.includes("not a safe project-local regular file") ||
    issue.includes("not a managed executable") ||
    issue.includes("runner is missing") ||
    issue.includes("Codex linked") ||
    issue.includes("Codex user hooks.json") ||
    issue.includes("$CODEX_HOME"),
  );
  if (!structurallyReady || evidenceInvalid) {
    return { state: "degraded", configuredAgents, ...(evidenceAgent ? { evidenceAgent, evidenceAt } : {}), issues };
  }
  if (evidenceAgent) return { state: "active", configuredAgents, evidenceAgent, evidenceAt, issues };
  return { state: "configured", configuredAgents, issues };
}
