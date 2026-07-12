# Codex linked-worktree lifecycle dispatcher

Date: 2026-07-12

Status: approved for implementation

## Problem

Codex CLI 0.144.1 loads project-level `.codex/hooks.json` in an ordinary Git checkout but silently ignores the same file in a linked worktree, where `.git` is a pointer file. The failure reproduces both inside and outside Orca, so this is a generic Codex linked-worktree compatibility gap rather than an Orca-specific repository format.

Orca adds one host boundary: its active `CODEX_HOME` is regenerated for each terminal from the user's system Codex home. Writing the generated runtime makes an install look successful until the next terminal refresh removes it. The linked-worktree protocol remains generic, but its user-Hook source resolver needs a narrow Orca adapter.

This breaks the Harness delivery loop on the environment where it matters most: an Agent can install the project files, but SessionStart does not capture the task base and Stop does not run `run-checks + verify`. Reporting that setup as active would be false.

## Goals

- Make Codex lifecycle validation work in any standard Git linked worktree; keep Git-shape detection host-neutral and isolate Orca handling to user-Hook source selection.
- Keep ordinary repositories on project-level Codex hooks.
- Let the onboarding Agent detect the repository shape and complete the correct installation automatically.
- Require at most one understandable Codex trust confirmation for the machine-level dispatcher; subsequent worktree registrations must not create new Hook commands.
- Keep the dispatcher inert in repositories that Harness has not explicitly registered.
- Preserve existing user-level hooks such as Orca and Otty, and never modify native global/shared Git hooks.
- Continue distinguishing `CONFIGURED`, `ACTIVE`, and `DEGRADED` using durable evidence bound to the exact effective Hook configuration.

## Non-goals

- Patch or fork Codex CLI.
- Change how Orca creates or launches worktrees.
- Bypass Codex Hook trust or write Codex trust hashes.
- Execute Harness for every repository on the machine.
- Install or merge native Git hooks as part of the fallback.
- Add a general-purpose global Hook manager.

## Options considered

### Wait for upstream

This preserves project-only configuration but leaves linked worktrees without automatic validation for an unknown period. It does not meet the release goal.

### Add an Orca-specific Codex launcher

A launcher could inject Hook configuration for Orca terminals, but it would require users to change how Codex starts and would still fail in non-Orca linked worktrees. It solves the wrong boundary.

### Install an allowlisted user-level dispatcher

Install one stable user-level Codex Hook that only dispatches when the current Git worktree contains a private registration written by Harness. This works around the upstream loader defect while retaining project isolation at the registration and evidence layers.

This is the selected approach.

## User experience

The normal onboarding Agent remains the primary interface. It will:

1. Compare the canonical absolute `git-dir` and `git-common-dir`; only different paths describe a linked worktree. A `.git` pointer file alone is insufficient because submodules use one too.
2. In an ordinary checkout, run the existing project-level Codex Hook installation.
3. In a linked worktree, run:

   ```sh
   harness-kit install-hooks --stop --agents codex --allow-user-dispatcher
   ```

4. Explain in plain language that Codex may show one security review for the machine-level Harness dispatcher.
5. Start or request a fresh Codex session, then require `harness-kit evidence` to report `hookActive: true` before calling onboarding complete.

The flag is explicit because the command writes a user-level Codex Hook source, but the Agent chooses it automatically after detecting the linked-worktree condition. The user does not need to understand or compose the command. In Orca, the Agent must start a fresh terminal after installation so the host mirrors that source into its generated runtime.

If the client cannot start a fresh session automatically, onboarding must stop at `CONFIGURED` and provide one exact next action. It must never simulate `hook-event` to manufacture activity.

## Architecture

### Project layer

Harness continues to generate:

- `.agents/hooks/harness-agent-hook.sh`
- `.codex/config.toml`
- `.codex/hooks.json`

Keeping the project files preserves ordinary-checkout support and makes linked worktrees automatically return to the native path after Codex fixes the upstream defect.

### User dispatcher layer

The installer resolves and canonicalizes the user-Hook source. Normally that is `CODEX_HOME`, falling back to `~/.codex`. If an Orca worktree marker is present and canonical `ORCA_CODEX_HOME` equals canonical `CODEX_HOME`, the runtime is derived, so the source is canonical `~/.codex`. This condition never decides whether the repository is a linked worktree; canonical Git admin/common directories remain authoritative. The installer manages under the selected source:

- `$CODEX_HOME/harness-kit/codex-linked-dispatch-v1.cjs`
- one exact SessionStart entry in `$CODEX_HOME/hooks.json`
- one exact Stop entry in `$CODEX_HOME/hooks.json`

The two Hook commands call the same versioned dispatcher with an explicit event. The command shape is stable across registered repositories, so Codex only needs to review it once. A future incompatible dispatcher protocol must use a new versioned filename and therefore earns a new trust review.

The dispatcher is a dependency-free Node 18 CommonJS program. It reads the Hook JSON payload once and preserves it for the project runner, performs cross-platform SHA-256 validation through `node:crypto`, and obtains the current worktree root and Git admin directory with argument-array Git calls. If the current worktree has no Harness registration, it exits successfully without reading the manifest or running project commands.

### Worktree registration

For a linked worktree, activation is controlled by a private registration in its worktree-specific Git admin directory:

```text
$(git rev-parse --git-dir)/harness-kit/codex-linked-dispatch-v1.json
```

The registration is mode `0600` and contains only data:

- schema and dispatcher protocol version;
- canonical worktree root;
- canonical Git admin directory;
- expected project runner relative path;
- exact runner SHA-256 and executable mode;
- Harness package version that generated the runner.

No shell command is accepted from the registration.

Before dispatching, the script verifies:

- the registration is a regular file in the current worktree Git admin directory;
- the current canonical root and Git admin directory match the registration;
- `.agents/manifest.yaml` and the runner are regular, non-symlink project files;
- the runner remains inside the current worktree;
- the runner content hash and executable mode match the registration.

An absent registration means “not a Harness worktree” and is a no-op. A present but invalid registration means infrastructure drift: SessionStart fails and Stop emits Codex's blocking JSON protocol.

### Safe installation

Without `--allow-user-dispatcher`, selecting Codex in a linked worktree fails with an actionable message instead of knowingly installing an ineffective configuration.

With the flag, installation follows an activation-last sequence:

1. Preflight all project files, the selected user-Hook source `hooks.json`, the dispatcher target, and the worktree registration target. Reject symlinked targets, invalid JSON, unknown Hook structures, foreign dispatcher files, or paths escaping their approved roots.
2. Install or refresh the versioned dispatcher and merge the two exact managed entries into user `hooks.json`. Existing foreign Hook groups keep their values and original order; Harness never replaces or normalizes their commands.
3. Write the project runner and project client files through the existing project transaction.
4. Re-authorize all captured source bytes to detect concurrent edits.
5. Write the worktree registration last with atomic rename. Only this final write activates dispatch for the worktree.

Failure before the last step can leave reusable but inert user infrastructure; it cannot activate a half-installed project. Every step is idempotent, and a retry repairs the inert state. A concurrent change to user hooks causes a non-zero refusal rather than overwrite or guessed merge.

New user infrastructure uses private directories and restrictive file modes. Existing user file modes are preserved where possible. The installer never edits `config.toml` trust state, Orca's managed runtime files, or Orca's management scripts. A fresh Orca terminal performs the normal source-to-runtime mirror.

The worktree registration is automatically removed with its Git admin directory when Git removes that worktree. The shared dispatcher intentionally remains as reusable, inert machine infrastructure; with no registrations it only performs the Git/registration existence check and exits. Its managed paths and manual removal instructions are printed after first installation.

## Hook status and evidence binding

In an ordinary checkout, Codex configuration status continues to use the project Hook pair.

In a linked worktree, Codex is structurally configured only when all of these are valid:

- managed project runner;
- project `.codex` files;
- exact managed user Hook entries;
- exact versioned dispatcher;
- current worktree registration.

The effective Codex Hook fingerprint binds:

- the project runner bytes and mode;
- the managed user Hook entries, but not unrelated third-party user Hook entries;
- dispatcher bytes and mode;
- registration bytes;
- project `.codex` files for forward compatibility and drift visibility.

Unrelated Orca/Otty Hook edits must not make Harness evidence stale. Any Harness dispatcher, registration, runner, or project configuration change must require a fresh SessionStart + Stop lifecycle before status can return to `ACTIVE`.

## Error handling

- Missing fallback permission in a linked worktree: fail installation with the exact retry command.
- Invalid or symlinked user-Hook source `hooks.json`: refuse all fallback writes.
- Foreign file at the dispatcher path: refuse even with `--force`.
- Invalid existing user Hook JSON shape: preserve it and refuse to guess.
- Runner or registration tampered after installation: fail closed during lifecycle and report `DEGRADED`.
- No registration in another repository: silent success and no Harness execution.
- Codex trust not granted: remain `CONFIGURED`; evidence is the only activation proof.

## Onboarding intelligence

The bundled onboarding skill must treat setup as an Agent-owned workflow:

- inspect Git shape rather than infer linked-worktree status from directory names or Orca environment variables;
- when Orca identifies its generated runtime, install into the system Codex source and require a fresh terminal instead of patching the runtime;
- select the fallback only for Codex linked worktrees;
- preserve and report existing user Hook entries;
- never ask the user to decide between technical Hook formats;
- explain the one-time Codex trust screen in one sentence;
- create a fresh verification Agent session when the host supports it;
- use `evidence --json` as the completion condition;
- report `CONFIGURED`, not success, if a fresh lifecycle cannot be observed.

## Verification strategy

### Focused automated tests

- linked-worktree detection compares canonical Git admin/common directories, does not depend on Orca variables, and does not mistake a submodule for a linked worktree;
- Orca source selection leaves the generated runtime untouched, preserves system user Hook groups, and records the system source in the worktree registration;
- linked Codex install without the explicit flag fails without registration;
- dispatcher installation preserves existing user Hook entries and is idempotent;
- invalid JSON, symlink targets, foreign dispatcher files, and concurrent edits fail closed;
- registrations are isolated per linked worktree Git admin directory;
- unregistered repositories are no-ops;
- registered SessionStart/Stop payloads reach the exact project runner;
- root, runner hash, mode, and registration tampering block execution;
- Hook status and configuration fingerprints use the effective linked-worktree path;
- ordinary project-level Codex behavior remains unchanged.

### Release regression

The release candidate must pass:

1. repository unit tests and typecheck;
2. production bundle and package-content checks;
3. installed tarball smoke on the supported Node floor;
4. a real ordinary-repository Codex lifecycle producing `ACTIVE` evidence;
5. a real plain Git linked-worktree lifecycle producing `ACTIVE` evidence;
6. a real Orca-managed linked-worktree lifecycle producing `ACTIVE` evidence;
7. a negative control proving an unregistered repository does not execute Harness;
8. a stale-evidence probe after a post-validation code edit;
9. preservation checks showing pre-existing Orca/Otty user Hook entries are unchanged.

No release-ready claim is allowed while any lifecycle scenario lacks real evidence.

## Release boundary

This work produces a committed release candidate and a locally installable package. Publishing to the registry remains a separate explicit action. The candidate report must list package path, checksum, exact tests run, real lifecycle evidence, preserved user Hook hashes, and any remaining non-blocking gaps.
