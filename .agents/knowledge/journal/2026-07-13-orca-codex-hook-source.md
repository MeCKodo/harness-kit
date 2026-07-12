# Orca Codex Hook source is the system home

Date: 2026-07-13

## Decision

When Harness runs inside an Orca-managed Codex terminal, the active `CODEX_HOME` is a generated runtime directory rather than the durable user source. If `ORCA_WORKTREE_ID` is present and canonical `ORCA_CODEX_HOME` equals canonical `CODEX_HOME`, linked-worktree dispatcher installation writes to canonical `~/.codex` and records that source path in the worktree registration.

Linked-worktree detection itself remains host-neutral and compares canonical Git admin and common directories. Orca environment variables only select the user Hook source after the repository has already been identified as linked.

## Why

Orca creates a fresh runtime Hook configuration by merging non-Orca groups from the system Codex home with its own managed groups. Directly changing the generated runtime is temporary and disappears when the next terminal is created. Writing the durable source lets Orca use its normal merge path and preserves existing system user Hook groups.

## Safety boundary

Harness must not patch Orca's management scripts, generated runtime Hook files, or private Hook trust records. Installation still uses compare-and-swap, preserves foreign groups and writes the per-worktree registration last. A new Orca Agent session plus `evidence --json` is required before reporting `ACTIVE`.
