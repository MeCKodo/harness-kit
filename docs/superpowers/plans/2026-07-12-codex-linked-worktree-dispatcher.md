# Codex Linked-Worktree Dispatcher Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Codex SessionStart/Stop lifecycle evidence work in standard Git linked worktrees while keeping onboarding Agent-driven and unregistered repositories inert.

**Architecture:** Ordinary checkouts retain project `.codex` hooks. Linked worktrees add one versioned, user-level Node 18 dispatcher plus a private activation record in the worktree-specific Git admin directory; the record is written last and contains only canonical paths and hashes. Hook status binds evidence to the effective project/user/registration artifacts, while the bundled onboarding skill chooses the correct path automatically.

**Tech Stack:** TypeScript 6, Node.js 18 CommonJS dispatcher, node:test + tsx, Commander, Git argument-array subprocesses, existing transactional managed-file writer.

## Global Constraints

- Support `spec: ai-harness/v0` only.
- Do not hard-code Orca paths, folder names, or environment variables as the worktree detector.
- Never modify Codex trust hashes, native global/shared Git hooks, consumer CI, or consumer business source.
- Preserve foreign user Hook groups and refuse invalid JSON, symlinks, foreign dispatcher files, and concurrent edits.
- A repository without a private linked-worktree registration must be a silent no-op.
- A present but invalid registration must fail closed: SessionStart exits non-zero; Stop emits Codex `decision=block` JSON.
- Only a real fresh SessionStart + Stop evidence record may produce `ACTIVE`.
- Node.js 18 remains the runtime floor and no dependency is added.

---

## File map

- Create `src/codex-linked-hooks.ts`: linked-worktree detection, user-Hook source resolution (including Orca's derived runtime), user Hook rendering, dispatcher source, registration preparation/commit, inspection and fingerprint artifacts.
- Create `test/codex-linked-hooks.test.ts`: focused security, dispatch, idempotency, isolation and tamper tests.
- Modify `src/commands/stop-hooks.ts`: select native project Hook vs linked dispatcher, preserve activation-last ordering, expose the effective install result.
- Modify `src/commands/install-hooks.ts`: carry the explicit fallback permission.
- Modify `src/cli.ts`: add `--allow-user-dispatcher`.
- Modify `src/hook-status.ts`: recognize and fingerprint the effective linked configuration.
- Modify `test/install-hooks.test.ts`, `test/hook-event.test.ts`, `test/verify.test.ts`: CLI/installer/status/lifecycle regression coverage.
- Modify `skills/erzhe-harness-init/SKILL.md`: Agent-owned detection, installation and fresh-session evidence loop.
- Modify `.agents/manifest.yaml`, `README.md`, `SPEC-v0.md`: module ownership, public behavior and security contract.
- Regenerate `.agents/{reference,routing,modules}.md`, `AGENTS.md`, example outputs and `.agents/contracts/cli-interface.snapshot` with repository commands.

---

### Task 1: Build the inert, allowlisted dispatcher core

**Files:**

- Create: `src/codex-linked-hooks.ts`
- Create: `test/codex-linked-hooks.test.ts`
- Reuse: `src/managed-files.ts`, `src/git.ts`, `src/util.ts`

**Interfaces:**

- Produces:

  ```ts
  export const CODEX_LINKED_PROTOCOL = "ai-harness/codex-linked-dispatch/v1";

  export interface CodexLinkedInstallPlan {
    repoRoot: string;
    gitDir: string;
    codexHome: string;
    userTargets: ReadonlyArray<readonly [string, string]>;
    registrationTarget: readonly [string, string];
    userInspections: readonly ManagedFileInspection[];
    registrationInspections: readonly ManagedFileInspection[];
  }

  export interface CodexLinkedInspection {
    linked: boolean;
    configured: boolean;
    issues: string[];
    artifacts: Array<{ path: string; content: string; mode?: number }>;
  }

  export interface CodexLinkedInstallTestHooks {
    beforeUserTransaction?: () => void;
    beforeRegistrationTransaction?: () => void;
  }

  export function isLinkedGitWorktree(repo: string): boolean;
  export function installedCodexDispatcherProgram(): string;
  export function prepareCodexLinkedInstall(repo: string, runnerContent: string): CodexLinkedInstallPlan;
  export function commitCodexLinkedInstall(
    plan: CodexLinkedInstallPlan,
    testHooks?: CodexLinkedInstallTestHooks,
  ): void;
  export function inspectCodexLinkedHooks(repo: string): CodexLinkedInspection;
  ```

- Consumes `inspectManagedFiles` and `writeManagedFiles` for both canonical `CODEX_HOME` and the current absolute Git admin directory; no ad-hoc overwrite path is introduced.

- [ ] **Step 1: Write the linked shape and no-registration tests**

  Create a normal repo plus `git worktree add` fixture and assert:

  ```ts
  assert.equal(isLinkedGitWorktree(main), false);
  assert.equal(isLinkedGitWorktree(linked), true);

  const dispatcher = installedCodexDispatcherProgram();
  const result = spawnSync(process.execPath, [dispatcherPath, "session-start"], {
    cwd: unregisteredRepo,
    input: JSON.stringify({ session_id: "no-op" }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  ```

- [ ] **Step 2: Run the focused test and observe RED**

  Run:

  ```sh
  node --import tsx --test test/codex-linked-hooks.test.ts
  ```

  Expected: FAIL because `src/codex-linked-hooks.ts` does not exist.

- [ ] **Step 3: Implement path resolution and dependency-free dispatcher source**

  The generated CommonJS program must use only `node:fs`, `node:path`, `node:crypto`, and `node:child_process`. Its event handling must have these exact branches:

  ```js
  const event = process.argv[2];
  const payload = fs.readFileSync(0, "utf8");
  const root = git(["rev-parse", "--show-toplevel"]);
  const gitDir = git(["rev-parse", "--absolute-git-dir"]);
  const registration = path.join(gitDir, "harness-kit", "codex-linked-dispatch-v1.json");
  if (!fs.existsSync(registration)) process.exit(0);
  // Parse and validate schema/root/gitDir/runner path/hash/mode.
  // Then spawn bash [runner, "codex", event] with cwd=root and input=payload.
  ```

  `event` accepts only `session-start | stop`. Infrastructure failure uses a single helper that writes actionable stderr + exit `2` for SessionStart and writes `{"decision":"block",...}` + exit `0` for Stop.

- [ ] **Step 4: Add registered dispatch and tamper tests**

  Cover a fake executable project runner that records event and stdin. Then independently mutate each load-bearing fact:

  ```ts
  assert.deepEqual(recorded, {
    event: "session-start",
    payload: { session_id: "linked-1" },
  });

  for (const mutation of ["root", "gitDir", "runnerHash", "runnerMode", "runnerSymlink", "badSchema"]) {
    const result = runDispatcherAfter(mutation, "stop");
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).decision, "block");
  }
  ```

- [ ] **Step 5: Implement installation preparation and activation-last commit**

  `prepareCodexLinkedInstall()` must:

  - resolve/canonicalize `CODEX_HOME` from `process.env.CODEX_HOME ?? join(homedir(), ".codex")`;
  - render two exact managed user Hook commands pointing at the versioned dispatcher;
  - preserve foreign `SessionStart`/`Stop` groups and their order;
  - reject non-object JSON, non-array event shapes, symlink targets and a foreign dispatcher path;
  - render registration JSON with no executable command fields;
  - capture user and registration inspections for compare-and-swap authorization.

  `commitCodexLinkedInstall()` writes user targets first and registration last. Both `writeManagedFiles()` calls authorize against the stored inspections. Set dispatcher mode `0700` and registration mode `0600`.

- [ ] **Step 6: Add preservation, idempotency and concurrent-edit tests**

  Assert that an existing foreign group survives two installs, only one managed group exists per event, and a test-hook edit between prepare/commit produces a non-zero exception while leaving no registration.

- [ ] **Step 7: Run focused tests and typecheck**

  Run:

  ```sh
  node --import tsx --test test/codex-linked-hooks.test.ts
  pnpm typecheck
  ```

  Expected: all tests pass; TypeScript exits `0`.

- [ ] **Step 8: Commit the dispatcher core**

  ```sh
  git add src/codex-linked-hooks.ts test/codex-linked-hooks.test.ts
  git commit -m "feat: add allowlisted Codex worktree dispatcher"
  ```

---

### Task 2: Integrate explicit linked fallback into installation

**Files:**

- Modify: `src/commands/stop-hooks.ts`
- Modify: `src/commands/install-hooks.ts`
- Modify: `src/cli.ts`
- Modify: `test/install-hooks.test.ts`

**Interfaces:**

- Extend `InstallHooksOpts`:

  ```ts
  allowUserDispatcher?: boolean;
  ```

- Replace positional Stop installer options with:

  ```ts
  export interface StopHookInstallOptions {
    force?: boolean;
    allowUserDispatcher?: boolean;
    testHooks?: StopHookInstallTestHooks;
  }

  export function installStopHooks(
    repo: string,
    agents: AgentTool[],
    opts?: StopHookInstallOptions,
  ): number;
  ```

- [ ] **Step 1: Add failing CLI and linked refusal tests**

  Verify a linked repo with Codex selected and no permission returns `1`, writes neither project Hook files nor registration, and prints the exact retry flag. Verify ordinary repos do not install user infrastructure.

  ```ts
  assert.equal(installHooksCmd(linked, { stop: true, agents: ["codex"] }), 1);
  assert.equal(existsSync(join(linked, ".codex", "hooks.json")), false);
  assert.match(output, /--allow-user-dispatcher/);
  ```

- [ ] **Step 2: Run the installer test and observe RED**

  ```sh
  node --import tsx --test test/install-hooks.test.ts
  ```

  Expected: the linked refusal assertion fails because current code returns success with only a warning.

- [ ] **Step 3: Add CLI option and activation-last orchestration**

  Add:

  ```ts
  .option(
    "--allow-user-dispatcher",
    "allow the safe CODEX_HOME dispatcher required by Codex in linked worktrees",
    false,
  )
  ```

  For a linked worktree with Codex selected:

  1. refuse before any write when permission is absent;
  2. prepare external targets before the project transaction;
  3. write the existing project runner/config transaction;
  4. commit user infrastructure and registration last;
  5. report exact managed locations and the one-time `/hooks` trust action.

  Other selected agents remain project-local and install in the same project transaction.

- [ ] **Step 4: Test mixed agents and failure ordering**

  Cover `claude,codex` in a linked worktree, invalid user Hook JSON, a foreign dispatcher, user concurrent edit, project concurrent edit and retry. No failure may produce a registration that activates an incomplete runner.

- [ ] **Step 5: Run installer tests and typecheck**

  ```sh
  node --import tsx --test test/install-hooks.test.ts test/codex-linked-hooks.test.ts
  pnpm typecheck
  ```

  Expected: PASS.

- [ ] **Step 6: Commit installer integration**

  ```sh
  git add src/cli.ts src/commands/install-hooks.ts src/commands/stop-hooks.ts test/install-hooks.test.ts
  git commit -m "feat: install Codex linked-worktree fallback safely"
  ```

---

### Task 3: Bind status and lifecycle evidence to the effective fallback

**Files:**

- Modify: `src/hook-status.ts`
- Modify: `test/install-hooks.test.ts`
- Modify: `test/hook-event.test.ts`
- Modify: `test/verify.test.ts`

**Interfaces:**

- Consume `inspectCodexLinkedHooks(repo)` from Task 1.
- Keep public `agentHookConfigurationFingerprint(repo, agent)` and `inspectAgentHookStatus(repo)` signatures unchanged.

- [ ] **Step 1: Write failing linked status tests**

  Assert:

  ```ts
  assert.deepEqual(inspectAgentHookStatus(linked), {
    state: "configured",
    configuredAgents: ["codex"],
    issues: [],
  });
  ```

  Then record current real lifecycle evidence and expect `active`. Change only an unrelated Otty group in user hooks and expect the fingerprint to remain current. Change the managed dispatcher group, dispatcher bytes, registration or runner and expect `degraded`.

- [ ] **Step 2: Run status tests and observe RED**

  ```sh
  node --import tsx --test test/install-hooks.test.ts test/hook-event.test.ts test/verify.test.ts
  ```

  Expected: linked status is not recognized by the project-only implementation.

- [ ] **Step 3: Select the effective Codex configuration**

  In `inspectAgentHookStatus()`:

  ```ts
  const codex = isLinkedGitWorktree(repo)
    ? inspectCodexLinkedHooks(repo)
    : inspectProjectCodexHooks(repo, issues);
  ```

  Require valid project `.codex` artifacts in both cases for forward compatibility, but for linked worktrees require the dispatcher and registration as the executable path.

  In `agentHookConfigurationFingerprint()`, hash only the exact managed user Hook entries plus dispatcher/registration/project artifacts. Do not hash unrelated foreign user Hook groups.

- [ ] **Step 4: Verify SessionStart/Stop binding**

  Run the generated dispatcher with real `hook-event` against a tiny linked fixture. SessionStart must store the fallback fingerprint; changing registration before Stop must return a block reason containing “configuration changed after SessionStart”.

- [ ] **Step 5: Run focused tests and typecheck**

  ```sh
  node --import tsx --test test/install-hooks.test.ts test/hook-event.test.ts test/verify.test.ts test/codex-linked-hooks.test.ts
  pnpm typecheck
  ```

  Expected: PASS.

- [ ] **Step 6: Commit status integration**

  ```sh
  git add src/hook-status.ts test/install-hooks.test.ts test/hook-event.test.ts test/verify.test.ts
  git commit -m "feat: verify effective Codex worktree hooks"
  ```

---

### Task 4: Make onboarding Agent-owned and update the public contract

**Files:**

- Modify: `skills/erzhe-harness-init/SKILL.md`
- Modify: `.agents/manifest.yaml`
- Modify: `README.md`
- Modify: `SPEC-v0.md`
- Modify: `scripts/cli-interface-snapshot.mjs` only if the snapshot generator needs a command-list change (the expected case is no code change)
- Regenerate: `.agents/contracts/cli-interface.snapshot`, `.agents/reference.md`, `.agents/routing.md`, `.agents/modules.md`, `AGENTS.md`, example generated files
- Test: `test/examples.test.ts`, `test/contracts.test.ts`, `test/render.test.ts`

**Interfaces:**

- Public flag: `install-hooks --allow-user-dispatcher`.
- Onboarding completion predicate: `harness-kit evidence --repo . --json` returns `valid: true`, `hookActive: true`, `hookConfigurationCurrent: true`, `stale: false`.

- [ ] **Step 1: Update the onboarding skill with exact decision logic**

  Replace the unconditional install step with:

  ```sh
  git_dir=$(git rev-parse --absolute-git-dir)
  common_dir=$(git rev-parse --git-common-dir)
  # Agent compares canonical directories; it does not inspect path names.
  harness-kit install-hooks --repo . --stop --agents codex \
    --allow-user-dispatcher   # only for a linked worktree
  ```

  The skill must tell a capable host Agent to create a fresh verification session automatically. If it cannot, it reports `CONFIGURED` plus one exact restart action. It must not ask the user to choose a Hook format or manually call `hook-event`.

- [ ] **Step 2: Update manifest ownership and pitfalls**

  Add `src/codex-linked-hooks.ts` to the `agent-hooks` module ownership and record these durable pitfalls:

  - Codex linked worktrees use the allowlisted user dispatcher until upstream project Hook discovery works.
  - Missing registration is inert; invalid registration blocks.
  - User Hook trust is never written by Harness and evidence remains the activation proof.

- [ ] **Step 3: Update README and SPEC**

  Explain the one-time machine dispatcher in plain language, its explicit permission flag, no-op behavior for unregistered repos, preservation of third-party user hooks and the fresh-evidence completion condition. Replace the current “known GAP only” wording with the implemented fallback while retaining the upstream compatibility note.

- [ ] **Step 4: Regenerate contracts and generated docs**

  Run:

  ```sh
  node scripts/cli-interface-snapshot.mjs > .agents/contracts/cli-interface.snapshot
  pnpm exec tsx src/cli.ts sync --repo .
  ```

  Use the repository's contract acceptance command if verify reports the intentional CLI snapshot change:

  ```sh
  pnpm exec tsx src/cli.ts accept-contract --repo . --id cli-interface
  ```

- [ ] **Step 5: Run documentation and generation tests**

  ```sh
  node --import tsx --test test/examples.test.ts test/contracts.test.ts test/render.test.ts
  pnpm typecheck
  ```

  Expected: PASS, generated files in sync.

- [ ] **Step 6: Commit onboarding and contract changes**

  ```sh
  git add .agents AGENTS.md README.md SPEC-v0.md skills examples scripts test
  git commit -m "docs: automate Codex worktree onboarding"
  ```

---

### Task 5: Produce and prove the release candidate

**Files:**

- Modify only if a regression exposes a defect: files owned by Tasks 1-4.
- Create outside the repository: packed tarball, isolated install directories and JSON evaluation report under `/tmp`.

**Interfaces:**

- Release artifact: `@erzhe/harness-kit@0.3.0` tarball.
- Release report: `/tmp/harness-kit-v03-linked-release-candidate.json`.

- [ ] **Step 1: Run repository impact gates from the task base**

  ```sh
  pnpm exec tsx src/cli.ts run-checks --repo . --base 4b9f833^ --json
  pnpm exec tsx src/cli.ts verify --repo . --json
  pnpm test
  pnpm typecheck
  pnpm build
  ```

  Expected: selected checks pass, zero blocking gaps, verify `ok: true`.

- [ ] **Step 2: Pack and install the exact candidate**

  ```sh
  PACK_DIR=$(mktemp -d /tmp/harness-kit-v03-linked-pack.XXXXXX)
  INSTALL_DIR=$(mktemp -d /tmp/harness-kit-v03-linked-install.XXXXXX)
  pnpm pack --pack-destination "$PACK_DIR"
  npm install --prefix "$INSTALL_DIR" "$PACK_DIR/erzhe-harness-kit-0.3.0.tgz"
  "$INSTALL_DIR/node_modules/.bin/harness-kit" --version
  ```

  Expected: `0.3.0`; package contains `dist`, `skills`, `SPEC-v0.md` and no source/test secrets.

- [ ] **Step 3: Run Node 18 smoke**

  With an actual Node 18 executable, run installed `--help`, `doctor`, and `verify --json` against a tiny fixture. Expected: all commands start successfully; valid fixture verification exits `0`.

- [ ] **Step 4: Real ordinary-repository lifecycle**

  Install the tarball into an isolated ordinary repo, trust the project Hook, run a fresh Codex turn that changes production + test files without manual Harness commands, and assert evidence:

  ```json
  {
    "valid": true,
    "hookActive": true,
    "hookConfigurationCurrent": true,
    "stale": false
  }
  ```

- [ ] **Step 5: Real plain linked-worktree lifecycle**

  Create a standard `git worktree add` fixture, install with `--allow-user-dispatcher`, start a fresh Codex turn, and require the same ACTIVE evidence. Confirm the project-level Hook remains absent from Codex `/hooks` while the managed user dispatcher is present and active.

- [ ] **Step 6: Real Orca linked-worktree lifecycle**

  Install into the system `~/.codex` Hook source while leaving Orca's generated runtime untouched, then use Orca CLI to start a new Codex terminal in an isolated real-project evaluation worktree. Let the Agent make only a safe fixture/document test change, forbid manual Harness commands, wait through Stop, and require ACTIVE evidence. Restore only test-only local CLI overrides afterward.

- [ ] **Step 7: Negative and stale controls**

  In an unregistered repo, prove no Harness validation state is created. In the registered fixture, change one file after valid Stop evidence and require `stale: true`, `valid: false`; restore the fingerprint and confirm the original evidence becomes valid again.

- [ ] **Step 8: Third-party Hook preservation audit**

  Hash and semantically compare all pre-existing system Orca/Otty user Hook groups before and after install, then confirm Orca mirrors them into a fresh runtime. Expected: values and order unchanged; only the two exact Harness groups are added, and the old generated runtime was never patched in place.

- [ ] **Step 9: Review, report and final commit**

  Review the complete diff for shell injection, symlink escape, half-activation, unrelated user-Hook invalidation and misleading ACTIVE claims. Write the `/tmp` report with artifact path/checksum, tests, evidence IDs and honest gaps. Commit any review fixes, then ensure `git status --short` is clean.

  ```sh
  git add -A
  git commit -m "feat: support Codex lifecycle hooks in linked worktrees"
  ```

  Do not publish or push without a separate explicit user instruction.
