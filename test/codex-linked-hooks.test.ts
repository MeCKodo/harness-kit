import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  commitCodexLinkedInstall,
  isLinkedGitWorktree,
  prepareCodexLinkedInstall,
} from "../src/codex-linked-hooks";

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

function committedRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "hk-codex-linked-main-"));
  git(repo, ["init", "-q", "-b", "main"]);
  mkdirSync(join(repo, ".agents"), { recursive: true });
  writeFileSync(join(repo, ".agents", "manifest.yaml"), "spec: ai-harness/v0\nidentity: { name: linked-test }\n");
  writeFileSync(join(repo, "README.md"), "fixture\n");
  git(repo, ["add", "."]);
  git(repo, [
    "-c",
    "user.name=Harness Kit Test",
    "-c",
    "user.email=harness-kit@example.test",
    "commit",
    "-qm",
    "initial",
  ]);
  return repo;
}

function linkedFixture(): { main: string; linked: string; codexHome: string; runner: string } {
  const main = committedRepo();
  const linked = join(mkdtempSync(join(tmpdir(), "hk-codex-linked-parent-")), "linked");
  git(main, ["worktree", "add", "-q", "-b", `linked-${Date.now()}`, linked, "HEAD"]);
  const codexHome = mkdtempSync(join(tmpdir(), "hk-codex-home-"));
  const runner = `#!/bin/sh
payload=$(cat)
node -e 'const fs=require("node:fs"); fs.writeFileSync(process.env.HARNESS_TEST_RECORD, JSON.stringify({event:process.argv[1],payload:JSON.parse(process.argv[2])}));' "$2" "$payload"
`;
  const runnerPath = join(linked, ".agents", "hooks", "harness-agent-hook.sh");
  mkdirSync(join(linked, ".agents", "hooks"), { recursive: true });
  writeFileSync(runnerPath, runner);
  chmodSync(runnerPath, 0o700);
  return { main, linked, codexHome, runner };
}

function withCodexHome<T>(codexHome: string, run: () => T): T {
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
  }
}

function registrationPath(repo: string): string {
  return join(git(repo, ["rev-parse", "--absolute-git-dir"]), "harness-kit", "codex-linked-dispatch-v1.json");
}

test("detects a standard linked worktree without Orca-specific state", () => {
  const fixture = linkedFixture();
  assert.equal(isLinkedGitWorktree(fixture.main), false);
  assert.equal(isLinkedGitWorktree(fixture.linked), true);
});

test("does not mistake a Git submodule for a linked worktree", () => {
  const child = committedRepo();
  const parent = committedRepo();
  git(parent, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", child, "vendor/child"]);
  assert.equal(isLinkedGitWorktree(join(parent, "vendor", "child")), false);
});

test("Orca installs into the system Codex source home instead of its generated runtime home", () => {
  const fixture = linkedFixture();
  const fakeHome = mkdtempSync(join(tmpdir(), "hk-codex-orca-system-home-"));
  const systemCodexHome = join(fakeHome, ".codex");
  const runtimeCodexHome = mkdtempSync(join(tmpdir(), "hk-codex-orca-runtime-home-"));
  mkdirSync(systemCodexHome, { recursive: true });
  const runtimeBytes = JSON.stringify({ runtimeOwned: true }) + "\n";
  writeFileSync(join(runtimeCodexHome, "hooks.json"), runtimeBytes);
  writeFileSync(
    join(systemCodexHome, "hooks.json"),
    JSON.stringify({ hooks: { SessionStart: [{ _foreign: "system", hooks: [] }], Stop: [] } }) + "\n",
  );

  const plan = prepareCodexLinkedInstall(fixture.linked, fixture.runner, {
    env: {
      ...process.env,
      CODEX_HOME: runtimeCodexHome,
      ORCA_CODEX_HOME: runtimeCodexHome,
      ORCA_WORKTREE_ID: "repo::worktree",
    },
    homeDir: fakeHome,
  });
  assert.equal(plan.codexHome, realpathSync(systemCodexHome));
  assert.equal(plan.requiresRuntimeRefresh, true);
  commitCodexLinkedInstall(plan);

  assert.equal(readFileSync(join(runtimeCodexHome, "hooks.json"), "utf8"), runtimeBytes);
  const sourceHooks = JSON.parse(readFileSync(join(systemCodexHome, "hooks.json"), "utf8"));
  assert.equal(sourceHooks.hooks.SessionStart[0]._foreign, "system");
  assert.equal(sourceHooks.hooks.SessionStart.at(-1)._harnessKit, "codex-linked-dispatch-v1");
  assert.equal(
    JSON.parse(readFileSync(registrationPath(fixture.linked), "utf8")).codexHome,
    realpathSync(systemCodexHome),
  );
});

test("installs one inert user dispatcher and routes only a registered linked worktree", () => {
  const fixture = linkedFixture();
  const foreignStart = { _foreign: true, hooks: [{ type: "command", command: "echo foreign-start" }] };
  writeFileSync(
    join(fixture.codexHome, "hooks.json"),
    JSON.stringify({ hooks: { SessionStart: [foreignStart], Stop: [] }, keep: { exact: true } }, null, 2) + "\n",
  );

  withCodexHome(fixture.codexHome, () => {
    const plan = prepareCodexLinkedInstall(fixture.linked, fixture.runner);
    assert.equal(plan.requiresRuntimeRefresh, false);
    commitCodexLinkedInstall(plan);
    const again = prepareCodexLinkedInstall(fixture.linked, fixture.runner);
    commitCodexLinkedInstall(again);
  });

  const userHooks = JSON.parse(readFileSync(join(fixture.codexHome, "hooks.json"), "utf8"));
  assert.deepEqual(userHooks.keep, { exact: true });
  assert.deepEqual(userHooks.hooks.SessionStart[0], foreignStart);
  assert.equal(userHooks.hooks.SessionStart.filter((group: any) => group._harnessKit === "codex-linked-dispatch-v1").length, 1);
  assert.equal(userHooks.hooks.Stop.filter((group: any) => group._harnessKit === "codex-linked-dispatch-v1").length, 1);

  const dispatcher = join(fixture.codexHome, "harness-kit", "codex-linked-dispatch-v1.cjs");
  assert.ok((statSync(dispatcher).mode & 0o100) !== 0);
  assert.equal(statSync(registrationPath(fixture.linked)).mode & 0o777, 0o600);

  const record = join(mkdtempSync(join(tmpdir(), "hk-codex-record-")), "event.json");
  const payload = { session_id: "linked-session" };
  const routed = spawnSync(process.execPath, [dispatcher, "session-start"], {
    cwd: fixture.linked,
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, HARNESS_TEST_RECORD: record },
  });
  assert.equal(routed.status, 0, routed.stderr);
  assert.deepEqual(JSON.parse(readFileSync(record, "utf8")), { event: "session-start", payload });

  const unregistered = committedRepo();
  const inert = spawnSync(process.execPath, [dispatcher, "session-start"], {
    cwd: unregistered,
    input: JSON.stringify({ session_id: "must-not-run" }),
    encoding: "utf8",
    env: { ...process.env, HARNESS_TEST_RECORD: join(unregistered, "unexpected.json") },
  });
  assert.equal(inert.status, 0, inert.stderr);
  assert.equal(inert.stdout, "");
  assert.equal(existsSync(join(unregistered, "unexpected.json")), false);
});

test("a present registration fails closed after runner tampering", () => {
  const fixture = linkedFixture();
  withCodexHome(fixture.codexHome, () => {
    commitCodexLinkedInstall(prepareCodexLinkedInstall(fixture.linked, fixture.runner));
  });
  writeFileSync(join(fixture.linked, ".agents", "hooks", "harness-agent-hook.sh"), fixture.runner + "# tampered\n");

  const dispatcher = join(fixture.codexHome, "harness-kit", "codex-linked-dispatch-v1.cjs");
  const stopped = spawnSync(process.execPath, [dispatcher, "stop"], {
    cwd: fixture.linked,
    input: JSON.stringify({ session_id: "tampered" }),
    encoding: "utf8",
  });
  assert.equal(stopped.status, 0);
  assert.equal(JSON.parse(stopped.stdout).decision, "block");
  assert.match(JSON.parse(stopped.stdout).reason, /runner|hash|configuration/i);
});

test("invalid user Hook JSON and foreign dispatcher files are never replaced", () => {
  const fixture = linkedFixture();
  writeFileSync(join(fixture.codexHome, "hooks.json"), "{broken\n");
  assert.throws(
    () => withCodexHome(fixture.codexHome, () => prepareCodexLinkedInstall(fixture.linked, fixture.runner)),
    /valid JSON/i,
  );
  assert.equal(existsSync(registrationPath(fixture.linked)), false);

  writeFileSync(join(fixture.codexHome, "hooks.json"), "{}\n");
  mkdirSync(join(fixture.codexHome, "harness-kit"), { recursive: true });
  const dispatcher = join(fixture.codexHome, "harness-kit", "codex-linked-dispatch-v1.cjs");
  writeFileSync(dispatcher, "console.log('foreign')\n");
  assert.throws(
    () => withCodexHome(fixture.codexHome, () => prepareCodexLinkedInstall(fixture.linked, fixture.runner)),
    /foreign|managed/i,
  );
  assert.equal(readFileSync(dispatcher, "utf8"), "console.log('foreign')\n");
});

test("a concurrent user Hook edit prevents activation and preserves the newer bytes", () => {
  const fixture = linkedFixture();
  const initial = JSON.stringify({ hooks: { SessionStart: [], Stop: [] }, owner: "initial" }) + "\n";
  const concurrent = JSON.stringify({ hooks: { SessionStart: [], Stop: [] }, owner: "concurrent" }) + "\n";
  writeFileSync(join(fixture.codexHome, "hooks.json"), initial);

  withCodexHome(fixture.codexHome, () => {
    const plan = prepareCodexLinkedInstall(fixture.linked, fixture.runner);
    assert.throws(
      () => commitCodexLinkedInstall(plan, {
        beforeUserTransaction: () => writeFileSync(join(fixture.codexHome, "hooks.json"), concurrent),
      }),
      /changed after render|changed after preflight/i,
    );
  });

  assert.equal(readFileSync(join(fixture.codexHome, "hooks.json"), "utf8"), concurrent);
  assert.equal(existsSync(registrationPath(fixture.linked)), false);
});
