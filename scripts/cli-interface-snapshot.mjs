import { spawnSync } from "node:child_process";

const commands = [
  null,
  "init",
  "prepare-adoption",
  "record-adoption-audit",
  "sync",
  "upgrade",
  "doctor",
  "verify",
  "task",
  "task-start",
  "deliver",
  "plan-checks",
  "run-checks",
  "evidence",
  "record-context-review",
  "accept-contract",
  "install-hooks",
  "onboard",
  "check-loop",
];

for (const [index, command] of commands.entries()) {
  const args = ["--import", "tsx", "src/cli.ts", ...(command ? [command] : []), "--help"];
  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || `failed to render ${command ?? "root"} help\n`);
    process.exit(result.status ?? 1);
  }
  const stableHelp = result.stdout.trimEnd();
  process.stdout.write(`## ${command ?? "root"}\n${stableHelp}${index === commands.length - 1 ? "\n" : "\n\n"}`);
}
