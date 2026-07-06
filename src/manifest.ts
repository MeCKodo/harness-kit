import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

export interface Capability {
  run: string;
  desc?: string;
  example?: string;
  background?: boolean;
  mutating?: boolean;
}

export interface EnvVar {
  name: string;
  desc?: string;
  required?: boolean;
  secret?: boolean;
}

export interface Contract {
  id: string;
  kind: string;
  desc: string;
  breaking_needs?: string;
  check?: string; // any command; exit 0 = compatible (repo brings its own breaking-change tool)
  snapshot?: string; // command that PRINTS the contract's current fingerprint to stdout; CLI diffs it vs a stored baseline (protocol-agnostic)
  manual_verify?: string; // how to verify by hand when no automatic check exists (honest gap)
}

export interface Enforcement {
  forbid_pattern?: string[];
  forbid_import?: string[];
  require_pattern?: string[];
  path_glob?: string[];
}

export interface Invariant {
  id: string;
  rule: string;
  enforcement?: Enforcement;
  check?: string;
  manual?: boolean;
  llm_judge?: boolean;
}

export interface Knowledge {
  path: string;
  role?: string;
  binds?: string[];
}

/** Change-type routing: tell the agent where to go per kind of change. */
export interface Route {
  when: string; // change type, e.g. "fix a bug", "add an HTTP endpoint"
  read?: string[]; // files/dirs to read first (repo-relative)
  entry?: string[]; // entry points
  dont_assume?: string[]; // gotchas to not guess about
  verify?: string[]; // minimum verification: capability verbs or raw commands
}

/** Module card: the per-module map that agents actually need. */
export interface Module {
  name: string;
  role: string;
  entry: string[]; // entry files (also used for freshness binding)
  upstream?: string[];
  downstream?: string[];
  must_know?: string[];
  pitfalls?: string[]; // common mistakes — the highest-value column
}

export interface Manifest {
  spec: string;
  identity: {
    name: string;
    summary?: string;
    scope_in?: string[];
    scope_out?: string[];
    upstream?: string[];
    downstream?: string[];
  };
  capabilities?: Record<string, Capability>;
  environment?: EnvVar[];
  contracts?: Contract[];
  invariants?: Invariant[];
  knowledge?: Knowledge[];
  routing?: Route[];
  modules?: Module[];
  playbooks?: { dir?: string };
}

export const MANIFEST_REL = ".agents/manifest.yaml";

export function manifestPath(repo: string): string {
  return join(repo, MANIFEST_REL);
}

export function loadManifest(repo: string): Manifest {
  const p = manifestPath(repo);
  if (!existsSync(p)) {
    throw new Error(`未找到 ${MANIFEST_REL}（在 ${repo}）。先跑 \`harness-kit init\`。`);
  }
  return YAML.parse(readFileSync(p, "utf8")) as Manifest;
}

export interface ValidationIssue {
  level: "error" | "warn";
  msg: string;
}

export function validateManifest(m: Manifest): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  /** 检查数组元素是否全为字符串，否则报错。prefix 用于错误信息。 */
  function checkStrArr(arr: unknown[] | undefined, prefix: string): void {
    if (!arr) return;
    for (let i = 0; i < arr.length; i++) {
      if (typeof arr[i] !== "string") {
        issues.push({
          level: "error",
          msg: `${prefix}[${i}] 必须是字符串（当前是 ${typeof arr[i]}）`,
        });
      }
    }
  }

  if (!m.spec) issues.push({ level: "error", msg: "缺少 spec 字段" });
  if (!m.identity?.name) issues.push({ level: "error", msg: "identity.name 必填" });
  if (!m.identity?.summary) issues.push({ level: "warn", msg: "identity.summary 建议填写" });

  // identity 下的字符串数组
  checkStrArr(m.identity?.scope_in as unknown[] | undefined, "identity.scope_in");
  checkStrArr(m.identity?.scope_out as unknown[] | undefined, "identity.scope_out");
  checkStrArr(m.identity?.upstream as unknown[] | undefined, "identity.upstream");
  checkStrArr(m.identity?.downstream as unknown[] | undefined, "identity.downstream");

  for (const [verb, cap] of Object.entries(m.capabilities ?? {})) {
    if (!cap?.run) issues.push({ level: "error", msg: `capabilities.${verb}.run 必填` });
  }

  const seen = new Set<string>();
  for (const inv of m.invariants ?? []) {
    if (!inv.id) {
      issues.push({ level: "error", msg: "存在缺少 id 的 invariant" });
      continue;
    }
    if (seen.has(inv.id)) issues.push({ level: "error", msg: `invariant id 重复: ${inv.id}` });
    seen.add(inv.id);
    if (!inv.enforcement && !inv.check && !inv.manual) {
      issues.push({ level: "warn", msg: `invariant ${inv.id} 既无 enforcement/check 也未标 manual` });
    }
    // enforcement 下的字符串数组
    const pfx = `invariant "${inv.id}" 的 enforcement`;
    checkStrArr(inv.enforcement?.forbid_pattern as unknown[] | undefined, `${pfx}.forbid_pattern`);
    checkStrArr(inv.enforcement?.forbid_import as unknown[] | undefined, `${pfx}.forbid_import`);
    checkStrArr(inv.enforcement?.require_pattern as unknown[] | undefined, `${pfx}.require_pattern`);
    checkStrArr(inv.enforcement?.path_glob as unknown[] | undefined, `${pfx}.path_glob`);
  }

  // knowledge.binds
  for (const k of m.knowledge ?? []) {
    checkStrArr(k.binds as unknown[] | undefined, `knowledge "${k.path}" 的 binds`);
  }

  const capVerbs = new Set(Object.keys(m.capabilities ?? {}));
  for (const r of m.routing ?? []) {
    if (!r.when) issues.push({ level: "error", msg: "存在缺少 when 的 routing 条目" });
    for (const field of ["read", "entry", "dont_assume", "verify"] as const) {
      checkStrArr(r[field] as unknown[] | undefined, `routing "${r.when}" 的 ${field}`);
    }
    for (const v of r.verify ?? []) {
      if (typeof v !== "string") continue; // 上面已报错，跳过语义检查
      // a verify step is either a known capability verb or a raw command (has a space)
      if (!v.includes(" ") && !capVerbs.has(v))
        issues.push({ level: "warn", msg: `routing "${r.when}" 的 verify 引用了未声明的 capability: ${v}` });
    }
  }

  const modSeen = new Set<string>();
  for (const mod of m.modules ?? []) {
    if (!mod.name) {
      issues.push({ level: "error", msg: "存在缺少 name 的 module" });
      continue;
    }
    if (modSeen.has(mod.name)) issues.push({ level: "error", msg: `module name 重复: ${mod.name}` });
    modSeen.add(mod.name);
    if (!mod.entry?.length)
      issues.push({ level: "warn", msg: `module ${mod.name} 未声明 entry（无法做新鲜度绑定）` });
    for (const field of ["entry", "upstream", "downstream", "must_know", "pitfalls"] as const) {
      checkStrArr(mod[field] as unknown[] | undefined, `module "${mod.name}" 的 ${field}`);
    }
  }
  return issues;
}
