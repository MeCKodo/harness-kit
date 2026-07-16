import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const PACKAGE_VERSION = (JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
  version: string;
}).version;

test("run-checks exposes scoped waiver and evidence options", () => {
  const result = spawnSync(TSX, [CLI, "run-checks", "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--where <scope>/);
  assert.match(result.stdout, /--session <token>/);
});

test("deliver and task-start are public finish-gate commands", () => {
  const deliver = spawnSync(TSX, [CLI, "deliver", "--help"], { encoding: "utf8" });
  assert.equal(deliver.status, 0);
  assert.match(deliver.stdout, /run-checks \+ verify → stamp|run-checks \+ verify/);
  assert.match(deliver.stdout, /--base <ref>/);

  const taskStart = spawnSync(TSX, [CLI, "task-start", "--help"], { encoding: "utf8" });
  assert.equal(taskStart.status, 0);
  assert.match(taskStart.stdout, /task-start base|base SHA|current HEAD/i);
});

test("doctor and verify expose an explicit details view without changing JSON mode", () => {
  const doctor = spawnSync(TSX, [CLI, "doctor", "--help"], { encoding: "utf8" });
  assert.equal(doctor.status, 0);
  assert.match(doctor.stdout, /--details/);

  const verify = spawnSync(TSX, [CLI, "verify", "--help"], { encoding: "utf8" });
  assert.equal(verify.status, 0);
  assert.match(verify.stdout, /--details/);
  assert.match(verify.stdout, /--json/);
});

test("upgrade exposes read-only and machine-readable modes", () => {
  const result = spawnSync(TSX, [CLI, "upgrade", "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--check/);
  assert.match(result.stdout, /--json/);
});

test("record-context-review exposes an explicit Agent review contract", () => {
  const result = spawnSync(TSX, [CLI, "record-context-review", "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--path <knowledge-path>/);
  assert.match(result.stdout, /--module <name>/);
  assert.match(result.stdout, /--reason <text>/);
  assert.match(result.stdout, /--session <token>/);
});

test("adoption and native Git hooks expose explicit evidence/scope acknowledgements", () => {
  const sync = spawnSync(TSX, [CLI, "sync", "--help"], { encoding: "utf8" });
  assert.equal(sync.status, 0);
  assert.match(sync.stdout, /--adopt-existing/);
  assert.match(sync.stdout, /--candidate <dir>/);
  assert.match(sync.stdout, /--audit <receipt>/);

  const prepare = spawnSync(TSX, [CLI, "prepare-adoption", "--help"], { encoding: "utf8" });
  assert.equal(prepare.status, 0);
  assert.match(prepare.stdout, /--out <dir>/);

  const audit = spawnSync(TSX, [CLI, "record-adoption-audit", "--help"], { encoding: "utf8" });
  assert.equal(audit.status, 0);
  assert.match(audit.stdout, /--verdict <pass\|fail>/);
  assert.match(audit.stdout, /--report <file>/);
  assert.match(audit.stdout, /--reason <text>/);

  const hooks = spawnSync(TSX, [CLI, "install-hooks", "--help"], { encoding: "utf8" });
  assert.equal(hooks.status, 0);
  assert.match(hooks.stdout, /--allow-shared-git-hooks/);
  assert.match(hooks.stdout, /--allow-user-dispatcher/);
});

test("install-hooks rejects unknown agent names instead of silently writing a config", () => {
  const result = spawnSync(TSX, [CLI, "install-hooks", "--stop", "--agents", "claude,unknown"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid --agents value/);
});

test("init refusal is a real nonzero failure, not a successful-looking error", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-cli-init-existing-"));
  mkdirSync(join(repo, ".agents"), { recursive: true });
  writeFileSync(join(repo, ".agents/manifest.yaml"), "spec: ai-harness/v0\nidentity: { name: existing }\n");
  const result = spawnSync(TSX, [CLI, "init", "--repo", repo], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /已存在/);
});

test("init preflights every scaffold target and refuses with zero writes", () => {
  const scaffold = [
    ".agents/manifest.yaml",
    ".agents/harness.lock.json",
    ".agents/knowledge/domain.md",
    ".agents/knowledge/conventions.md",
    ".agents/knowledge/journal/.gitkeep",
    ".agents/playbooks/.gitkeep",
    ".agents/adoption.md",
  ];
  for (const occupied of scaffold) {
    const repo = mkdtempSync(join(tmpdir(), "hk-cli-init-scaffold-"));
    mkdirSync(join(repo, dirname(occupied)), { recursive: true });
    writeFileSync(join(repo, occupied), `existing ${occupied}\n`);

    const result = spawnSync(TSX, [CLI, "init", "--repo", repo], { encoding: "utf8" });
    assert.equal(result.status, 1, occupied);
    assert.match(result.stdout, /init scaffold.*已存在/, occupied);
    assert.equal(readFileSync(join(repo, occupied), "utf8"), `existing ${occupied}\n`);
    for (const target of scaffold) assert.equal(existsSync(join(repo, target)), target === occupied, `${occupied}: ${target}`);
    assert.equal(existsSync(join(repo, ".agents/adoption/legacy-index.json")), false, occupied);
  }
});

test("init --force still snapshots legacy entry bytes before replacing scaffold files", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-cli-init-force-"));
  writeFileSync(join(repo, "AGENTS.md"), "# Existing project rules\n");
  mkdirSync(join(repo, ".agents/knowledge"), { recursive: true });
  writeFileSync(join(repo, ".agents/knowledge/domain.md"), "old scaffold\n");

  const result = spawnSync(TSX, [CLI, "init", "--repo", repo, "--name", "forced", "--force"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(readFileSync(join(repo, ".agents/adoption/legacy/AGENTS.md.pre-harness"), "utf8"), "# Existing project rules\n");
  assert.match(readFileSync(join(repo, ".agents/knowledge/domain.md"), "utf8"), /forced — domain/);
  assert.deepEqual(JSON.parse(readFileSync(join(repo, ".agents/harness.lock.json"), "utf8")), {
    schema: "ai-harness/upgrade-state/v1",
    package: "@erzhe/harness-kit",
    version: PACKAGE_VERSION,
    manifestSpec: "ai-harness/v0",
    appliedMigrations: ["upgrade-state-v1"],
  });
});

test("the real CLI blocks an implicit manual no-change result", () => {
  const repo = mkdtempSync(join(tmpdir(), "hk-cli-no-change-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  mkdirSync(join(repo, ".agents"), { recursive: true });
  writeFileSync(join(repo, ".agents", "manifest.yaml"), "spec: ai-harness/v0\nidentity: { name: fixture, summary: fixture }\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.name=Harness Test", "-c", "user.email=harness@example.test", "commit", "-qm", "initial"], {
    cwd: repo,
  });

  const result = spawnSync(TSX, [CLI, "run-checks", "--repo", repo, "--json"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.ok(JSON.parse(result.stdout).gaps.some((gap: { kind: string }) => gap.kind === "manual-base-required"));
});
