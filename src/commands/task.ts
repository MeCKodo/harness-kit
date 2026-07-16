import { readTaskRecord, startTaskRecord } from "../delivery";
import { err, info, ok } from "../util";

export interface TaskStartOpts {
  base?: string;
  note?: string;
  json?: boolean;
}

export function taskStartCmd(repo: string, opts: TaskStartOpts = {}): number {
  try {
    const record = startTaskRecord({ repo, baseSha: opts.base, note: opts.note });
    if (opts.json) {
      process.stdout.write(JSON.stringify(record, null, 2) + "\n");
    } else {
      ok(`task started at base ${record.baseSha}`);
      if (record.note) info(`note: ${record.note}`);
      info("run harness-kit deliver when ready to accept this task's changes");
    }
    return 0;
  } catch (error) {
    err(`task start failed: ${(error as Error).message}`);
    return 1;
  }
}

export function taskStatusCmd(repo: string, opts: { json?: boolean } = {}): number {
  const record = readTaskRecord(repo);
  if (opts.json) {
    process.stdout.write(JSON.stringify({ schema: "ai-harness/task-status/v1", found: !!record, task: record }, null, 2) + "\n");
    return record ? 0 : 1;
  }
  if (!record) {
    err("no active task record for this worktree");
    info("run: harness-kit task start --repo .");
    info("without a task base, deliver falls back to worktree diff vs HEAD");
    return 1;
  }
  ok(`active task base ${record.baseSha}`);
  info(`created: ${record.createdAt}`);
  if (record.note) info(`note: ${record.note}`);
  return 0;
}
