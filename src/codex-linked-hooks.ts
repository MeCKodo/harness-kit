import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import pkg from "../package.json";
import { gitAdminDir, gitRoot } from "./git";
import {
  inspectManagedFiles,
  writeManagedFiles,
  type ManagedFileInspection,
  type ManagedFileTarget,
} from "./managed-files";
import { sha256 } from "./util";

export const CODEX_LINKED_PROTOCOL = "ai-harness/codex-linked-dispatch/v1";

const DISPATCH_ID = "codex-linked-dispatch-v1";
const DISPATCHER_REL = `harness-kit/${DISPATCH_ID}.cjs`;
const REGISTRATION_REL = `harness-kit/${DISPATCH_ID}.json`;
const USER_HOOKS_REL = "hooks.json";
const RUNNER_REL = ".agents/hooks/harness-agent-hook.sh";
const DISPATCHER_MARK = "harness-kit-managed-codex-linked-dispatch-v1";

interface CodexLinkedRegistration {
  schema: typeof CODEX_LINKED_PROTOCOL;
  repoRoot: string;
  gitDir: string;
  codexHome: string;
  runner: {
    relativePath: typeof RUNNER_REL;
    sha256: string;
    mode: number;
  };
  harnessVersion: string;
}

export interface CodexLinkedInstallPlan {
  repoRoot: string;
  gitDir: string;
  codexHome: string;
  requiresRuntimeRefresh: boolean;
  userTargets: readonly ManagedFileTarget[];
  registrationTarget: ManagedFileTarget;
  userInspections: readonly ManagedFileInspection[];
  registrationInspections: readonly ManagedFileInspection[];
}

export interface CodexLinkedInstallTestHooks {
  beforeUserTransaction?: () => void;
  beforeRegistrationTransaction?: () => void;
}

export interface CodexLinkedPrepareOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export interface CodexLinkedInspection {
  linked: boolean;
  configured: boolean;
  issues: string[];
  artifacts: Array<{ path: string; content: string; mode?: number }>;
}

function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function ensureCodexHome(requestedInput: string, label: string): string {
  const requested = resolve(requestedInput);
  mkdirSync(requested, { recursive: true, mode: 0o700 });
  const resolved = realpathSync(requested);
  if (!statSync(resolved).isDirectory()) throw new Error(`${label} is not a directory: ${requested}`);
  return resolved;
}

function resolveCodexHookSourceHome(
  options: CodexLinkedPrepareOptions = {},
): { codexHome: string; requiresRuntimeRefresh: boolean } {
  const env = options.env ?? process.env;
  const userHome = options.homeDir ?? homedir();
  const runtimeHome = ensureCodexHome(env.CODEX_HOME ?? join(userHome, ".codex"), "CODEX_HOME");
  const orcaRuntimeHome = env.ORCA_CODEX_HOME?.trim();

  // Orca regenerates its runtime CODEX_HOME from the user's system Codex home
  // when a terminal starts. Install into that source so the managed entry is
  // mirrored into future runtimes instead of being lost on the next refresh.
  if (
    env.ORCA_WORKTREE_ID?.trim() &&
    orcaRuntimeHome &&
    canonical(resolve(orcaRuntimeHome)) === runtimeHome
  ) {
    const codexHome = ensureCodexHome(join(userHome, ".codex"), "Codex system hook source home");
    return { codexHome, requiresRuntimeRefresh: codexHome !== runtimeHome };
  }

  return { codexHome: runtimeHome, requiresRuntimeRefresh: false };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function userHookCommand(codexHome: string, event: "session-start" | "stop"): string {
  return `node ${shellQuote(join(codexHome, DISPATCHER_REL))} ${event}`;
}

function managedUserGroup(codexHome: string, event: "session-start" | "stop"): Record<string, unknown> {
  return {
    _harnessKit: DISPATCH_ID,
    hooks: [
      {
        type: "command",
        command: userHookCommand(codexHome, event),
        timeout: 600,
      },
    ],
  };
}

function isExactManagedUserGroup(
  value: unknown,
  codexHome: string,
  event: "session-start" | "stop",
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const group = value as { _harnessKit?: unknown; hooks?: unknown };
  if (group._harnessKit !== DISPATCH_ID || !Array.isArray(group.hooks) || group.hooks.length !== 1) return false;
  const hook = group.hooks[0] as { type?: unknown; command?: unknown; timeout?: unknown } | undefined;
  return hook?.type === "command" &&
    hook.command === userHookCommand(codexHome, event) &&
    hook.timeout === 600;
}

function parseObjectJson(raw: string | null, label: string): Record<string, unknown> {
  if (raw === null) return {};
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // Use one actionable error below.
  }
  throw new Error(`${label} exists but is not valid JSON`);
}

function renderUserHooks(current: string | null, codexHome: string): string {
  const hooksPath = join(codexHome, USER_HOOKS_REL);
  const json = parseObjectJson(current, hooksPath);
  if (json.hooks !== undefined && (!json.hooks || typeof json.hooks !== "object" || Array.isArray(json.hooks))) {
    throw new Error(`${hooksPath} hooks must be an object; refusing to replace an unknown existing shape`);
  }
  const hooks = (json.hooks as Record<string, unknown> | undefined) ?? {};
  for (const [jsonEvent, semanticEvent] of [
    ["SessionStart", "session-start"],
    ["Stop", "stop"],
  ] as const) {
    if (hooks[jsonEvent] !== undefined && !Array.isArray(hooks[jsonEvent])) {
      throw new Error(`${hooksPath} hooks.${jsonEvent} must be an array; refusing to replace an unknown existing shape`);
    }
    const existing = Array.isArray(hooks[jsonEvent]) ? (hooks[jsonEvent] as unknown[]) : [];
    for (const group of existing) {
      if (
        group &&
        typeof group === "object" &&
        !Array.isArray(group) &&
        (group as { _harnessKit?: unknown })._harnessKit === DISPATCH_ID &&
        !isExactManagedUserGroup(group, codexHome, semanticEvent)
      ) {
        throw new Error(`${hooksPath} contains a foreign or changed ${DISPATCH_ID} ${jsonEvent} group`);
      }
    }
    hooks[jsonEvent] = [
      ...existing.filter((group) => !isExactManagedUserGroup(group, codexHome, semanticEvent)),
      managedUserGroup(codexHome, semanticEvent),
    ];
  }
  json.hooks = hooks;
  return JSON.stringify(json, null, 2) + "\n";
}

function inspectionMap(inspections: readonly ManagedFileInspection[]): Map<string, ManagedFileInspection> {
  return new Map(inspections.map((inspection) => [inspection.relativePath, inspection]));
}

function assertInspectionsUnchanged(
  expected: readonly ManagedFileInspection[],
  current: readonly ManagedFileInspection[],
  label: string,
): void {
  const before = inspectionMap(expected);
  if (before.size !== current.length) throw new Error(`${label} target set changed after render`);
  for (const item of current) {
    const previous = before.get(item.relativePath);
    if (
      !previous ||
      previous.absolutePath !== item.absolutePath ||
      previous.kind !== item.kind ||
      previous.currentContent !== item.currentContent ||
      previous.linkTarget !== item.linkTarget
    ) {
      throw new Error(`${label} changed after render: ${item.relativePath}`);
    }
  }
}

function registrationFrom(raw: string, label: string): CodexLinkedRegistration {
  const value = parseObjectJson(raw, label) as Partial<CodexLinkedRegistration>;
  if (
    value.schema !== CODEX_LINKED_PROTOCOL ||
    typeof value.repoRoot !== "string" ||
    typeof value.gitDir !== "string" ||
    typeof value.codexHome !== "string" ||
    !value.runner ||
    value.runner.relativePath !== RUNNER_REL ||
    typeof value.runner.sha256 !== "string" ||
    typeof value.runner.mode !== "number" ||
    typeof value.harnessVersion !== "string"
  ) {
    throw new Error(`${label} is not a managed ${CODEX_LINKED_PROTOCOL} registration`);
  }
  return value as CodexLinkedRegistration;
}

function runnerMode(repoRoot: string, content: string): number {
  try {
    const path = join(repoRoot, RUNNER_REL);
    const stat = lstatSync(path);
    if (stat.isFile() && !stat.isSymbolicLink() && readFileSync(path, "utf8") === content) return stat.mode & 0o777;
  } catch {
    // First installation uses the mode written by the project transaction.
  }
  return 0o755;
}

export function isLinkedGitWorktree(repo: string): boolean {
  try {
    const root = gitRoot(repo);
    const current = canonical(gitAdminDir(root));
    const common = canonical(
      execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim(),
    );
    return current !== common;
  } catch {
    return false;
  }
}

export function installedCodexDispatcherProgram(): string {
  return `#!/usr/bin/env node
// ${DISPATCHER_MARK}
"use strict";
const childProcess = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PROTOCOL = ${JSON.stringify(CODEX_LINKED_PROTOCOL)};
const REGISTRATION_REL = ${JSON.stringify(REGISTRATION_REL)};
const DISPATCHER_REL = ${JSON.stringify(DISPATCHER_REL)};
const RUNNER_REL = ${JSON.stringify(RUNNER_REL)};
const event = process.argv[2];

function fail(message) {
  const reason = "harness-kit linked-worktree hook infrastructure failed: " + message;
  if (event === "stop") {
    process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\\n");
    process.exit(0);
  }
  process.stderr.write(reason + "\\n");
  process.exit(2);
}

function git(args) {
  return childProcess.execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function canonical(value) {
  return fs.realpathSync(value);
}

function inside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel));
}

if (event !== "session-start" && event !== "stop") fail("invalid lifecycle event");
const payload = fs.readFileSync(0, "utf8");

let root;
let gitDir;
try {
  root = canonical(git(["rev-parse", "--show-toplevel"]));
  gitDir = canonical(git(["rev-parse", "--absolute-git-dir"]));
} catch {
  process.exit(0);
}

const registrationPath = path.join(gitDir, REGISTRATION_REL);
if (!fs.existsSync(registrationPath)) process.exit(0);

try {
  const registrationStat = fs.lstatSync(registrationPath);
  if (!registrationStat.isFile() || registrationStat.isSymbolicLink()) throw new Error("registration is not a regular file");
  if ((registrationStat.mode & 0o777) !== 0o600) throw new Error("registration permissions are not 0600");
  const registration = JSON.parse(fs.readFileSync(registrationPath, "utf8"));
  if (!registration || registration.schema !== PROTOCOL) throw new Error("registration schema is invalid");
  if (registration.repoRoot !== root || registration.gitDir !== gitDir) throw new Error("registration belongs to another worktree");
  const codexHome = canonical(registration.codexHome);
  if (canonical(__filename) !== path.join(codexHome, DISPATCHER_REL)) throw new Error("dispatcher path does not match registration");
  if (!registration.runner || registration.runner.relativePath !== RUNNER_REL) throw new Error("runner registration is invalid");

  const manifest = path.join(root, ".agents", "manifest.yaml");
  const manifestStat = fs.lstatSync(manifest);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || !inside(root, canonical(manifest))) {
    throw new Error("manifest is not a safe project file");
  }

  const runner = path.join(root, RUNNER_REL);
  const runnerStat = fs.lstatSync(runner);
  const runnerReal = canonical(runner);
  if (!runnerStat.isFile() || runnerStat.isSymbolicLink() || !inside(root, runnerReal)) {
    throw new Error("runner is not a safe project file");
  }
  const mode = runnerStat.mode & 0o777;
  if (mode !== registration.runner.mode || (mode & 0o100) === 0) throw new Error("runner mode changed after registration");
  const hash = crypto.createHash("sha256").update(fs.readFileSync(runner)).digest("hex");
  if (hash !== registration.runner.sha256) throw new Error("runner hash changed after registration");

  const result = childProcess.spawnSync("bash", [runnerReal, "codex", event], {
    cwd: root,
    input: payload,
    encoding: "utf8",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status === null) throw new Error("runner exited without a status");
  process.exit(result.status);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
`;
}

export function prepareCodexLinkedInstall(
  repoInput: string,
  runnerContent: string,
  options: CodexLinkedPrepareOptions = {},
): CodexLinkedInstallPlan {
  const repoRoot = canonical(gitRoot(repoInput));
  if (!isLinkedGitWorktree(repoRoot)) throw new Error("Codex user dispatcher is only valid for a Git linked worktree");
  const gitDir = canonical(gitAdminDir(repoRoot));
  const { codexHome, requiresRuntimeRefresh } = resolveCodexHookSourceHome(options);
  const dispatcher = installedCodexDispatcherProgram();

  const initialUser = inspectManagedFiles(codexHome, [
    [USER_HOOKS_REL, ""],
    [DISPATCHER_REL, ""],
  ]);
  const initialByPath = inspectionMap(initialUser);
  const currentDispatcher = initialByPath.get(DISPATCHER_REL)?.currentContent ?? null;
  if (currentDispatcher !== null && currentDispatcher !== dispatcher) {
    throw new Error(`${join(codexHome, DISPATCHER_REL)} exists and is foreign or changed; refusing to replace it`);
  }
  const currentHooks = initialByPath.get(USER_HOOKS_REL)?.currentContent ?? null;
  const renderedHooks = renderUserHooks(currentHooks, codexHome);
  const userTargets: readonly ManagedFileTarget[] = [
    [DISPATCHER_REL, dispatcher],
    [USER_HOOKS_REL, renderedHooks],
  ];
  const userInspections = inspectManagedFiles(codexHome, userTargets);

  // Preflight the project runner path even on first install; this rejects a
  // symlinked/out-of-project target before any CODEX_HOME write occurs.
  inspectManagedFiles(repoRoot, [[RUNNER_REL, runnerContent]]);
  const registration: CodexLinkedRegistration = {
    schema: CODEX_LINKED_PROTOCOL,
    repoRoot,
    gitDir,
    codexHome,
    runner: {
      relativePath: RUNNER_REL,
      sha256: sha256(runnerContent),
      mode: runnerMode(repoRoot, runnerContent),
    },
    harnessVersion: pkg.version,
  };
  const registrationContent = JSON.stringify(registration, null, 2) + "\n";
  const existingRegistration = inspectManagedFiles(gitDir, [[REGISTRATION_REL, ""]])[0]!;
  if (existingRegistration.currentContent !== null) {
    const existing = registrationFrom(existingRegistration.currentContent, registrationPathLabel(gitDir));
    if (canonical(existing.repoRoot) !== repoRoot || canonical(existing.gitDir) !== gitDir) {
      throw new Error(`${registrationPathLabel(gitDir)} belongs to another worktree`);
    }
  }
  const registrationTarget: ManagedFileTarget = [REGISTRATION_REL, registrationContent];
  const registrationInspections = inspectManagedFiles(gitDir, [registrationTarget]);
  return {
    repoRoot,
    gitDir,
    codexHome,
    requiresRuntimeRefresh,
    userTargets,
    registrationTarget,
    userInspections,
    registrationInspections,
  };
}

function registrationPathLabel(gitDir: string): string {
  return join(gitDir, REGISTRATION_REL);
}

export function commitCodexLinkedInstall(
  plan: CodexLinkedInstallPlan,
  testHooks: CodexLinkedInstallTestHooks = {},
): void {
  testHooks.beforeUserTransaction?.();
  const userResult = writeManagedFiles(plan.codexHome, plan.userTargets, {
    authorize: (current) => assertInspectionsUnchanged(plan.userInspections, current, "Codex user Hook source"),
  });
  chmodSync(join(plan.codexHome, DISPATCHER_REL), 0o700);
  if (userResult.inspections.find((item) => item.relativePath === USER_HOOKS_REL)?.kind === "missing") {
    chmodSync(join(plan.codexHome, USER_HOOKS_REL), 0o600);
  }

  testHooks.beforeRegistrationTransaction?.();
  writeManagedFiles(plan.gitDir, [plan.registrationTarget], {
    authorize: (current) =>
      assertInspectionsUnchanged(plan.registrationInspections, current, "Codex linked registration source"),
  });
  chmodSync(join(plan.gitDir, REGISTRATION_REL), 0o600);
}

function safeContent(root: string, rel: string, issues: string[]): { content: string | null; mode?: number } {
  try {
    const inspected = inspectManagedFiles(root, [[rel, ""]])[0]!;
    if (inspected.kind === "missing" || inspected.currentContent === null) return { content: null };
    return { content: inspected.currentContent, mode: lstatSync(join(root, rel)).mode & 0o777 };
  } catch (error) {
    issues.push(`${join(root, rel)} is not a safe regular file: ${(error as Error).message}`);
    return { content: null };
  }
}

export function inspectCodexLinkedHooks(repoInput: string): CodexLinkedInspection {
  const issues: string[] = [];
  const artifacts: CodexLinkedInspection["artifacts"] = [];
  if (!isLinkedGitWorktree(repoInput)) return { linked: false, configured: false, issues, artifacts };

  let repoRoot: string;
  let gitDir: string;
  try {
    repoRoot = canonical(gitRoot(repoInput));
    gitDir = canonical(gitAdminDir(repoRoot));
  } catch (error) {
    return { linked: true, configured: false, issues: [(error as Error).message], artifacts };
  }
  const registrationFile = safeContent(gitDir, REGISTRATION_REL, issues);
  if (registrationFile.content === null) {
    issues.push("Codex linked-worktree registration is missing");
    return { linked: true, configured: false, issues, artifacts };
  }

  let registration: CodexLinkedRegistration;
  try {
    registration = registrationFrom(registrationFile.content, registrationPathLabel(gitDir));
  } catch (error) {
    issues.push((error as Error).message);
    return { linked: true, configured: false, issues, artifacts };
  }
  if (registration.repoRoot !== repoRoot || registration.gitDir !== gitDir) issues.push("Codex linked registration belongs to another worktree");
  if (registrationFile.mode !== 0o600) issues.push("Codex linked registration permissions are not 0600");
  artifacts.push({ path: "$GIT_DIR/" + REGISTRATION_REL, content: registrationFile.content, mode: registrationFile.mode });

  const dispatcherFile = safeContent(registration.codexHome, DISPATCHER_REL, issues);
  const expectedDispatcher = installedCodexDispatcherProgram();
  if (dispatcherFile.content !== expectedDispatcher) issues.push("Codex linked dispatcher is missing or changed");
  if (dispatcherFile.mode !== 0o700) issues.push("Codex linked dispatcher permissions are not 0700");
  if (dispatcherFile.content !== null) {
    artifacts.push({ path: "$CODEX_HOOK_SOURCE/" + DISPATCHER_REL, content: dispatcherFile.content, mode: dispatcherFile.mode });
  }

  const userHooksFile = safeContent(registration.codexHome, USER_HOOKS_REL, issues);
  if (userHooksFile.content === null) {
    issues.push("Codex user hooks.json is missing");
  } else {
    try {
      const json = parseObjectJson(userHooksFile.content, join(registration.codexHome, USER_HOOKS_REL));
      const hooks = json.hooks as Record<string, unknown> | undefined;
      const start = Array.isArray(hooks?.SessionStart)
        ? hooks!.SessionStart.find((group) => isExactManagedUserGroup(group, registration.codexHome, "session-start"))
        : undefined;
      const stop = Array.isArray(hooks?.Stop)
        ? hooks!.Stop.find((group) => isExactManagedUserGroup(group, registration.codexHome, "stop"))
        : undefined;
      if (!start || !stop) issues.push("Codex user hooks.json does not contain both exact Harness dispatcher hooks");
      else artifacts.push({ path: "$CODEX_HOOK_SOURCE/hooks.json#harness-kit", content: JSON.stringify({ start, stop }) });
    } catch (error) {
      issues.push((error as Error).message);
    }
  }

  const runnerFile = safeContent(repoRoot, RUNNER_REL, issues);
  if (runnerFile.content === null) issues.push("Codex linked project runner is missing");
  else {
    if (sha256(runnerFile.content) !== registration.runner.sha256) issues.push("Codex linked project runner hash changed");
    if (runnerFile.mode !== registration.runner.mode || ((runnerFile.mode ?? 0) & 0o100) === 0) {
      issues.push("Codex linked project runner mode changed");
    }
  }

  return { linked: true, configured: issues.length === 0, issues, artifacts };
}
