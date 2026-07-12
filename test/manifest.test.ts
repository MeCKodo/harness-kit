import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadManifest, validateManifest } from "../src/manifest";
import type { Manifest } from "../src/manifest";

const REPO = fileURLToPath(new URL("..", import.meta.url));

test("a minimal valid manifest produces no errors", () => {
  const m: Manifest = { spec: "ai-harness/v0", identity: { name: "x", summary: "s" } };
  const errs = validateManifest(m).filter((i) => i.level === "error");
  assert.equal(errs.length, 0);
});

test("the repository impact map keeps Codex linked hooks with their focused tests", () => {
  const module = loadManifest(REPO).modules?.find((item) => item.name === "agent-hooks");
  assert.ok(module);
  assert.ok(module.owns?.includes("src/codex-linked-hooks.ts"));
  assert.ok(module.tests?.includes("test/codex-linked-hooks.test.ts"));
  assert.ok(
    module.pitfalls?.some((pitfall) =>
      /Orca.*CODEX_HOME.*生成态.*~\/.codex.*不能补丁运行时 hooks.*trust/.test(pitfall),
    ),
  );
});

test("an unknown manifest spec is rejected instead of being interpreted as v0", () => {
  const m: Manifest = { spec: "ai-harness/v999", identity: { name: "x", summary: "s" } };
  const errors = validateManifest(m)
    .filter((issue) => issue.level === "error")
    .map((issue) => issue.msg);
  assert.ok(errors.some((message) => /不支持.*ai-harness\/v999.*ai-harness\/v0/.test(message)));
});

test("contract ids are restricted to portable filename characters", () => {
  const m: Manifest = {
    spec: "ai-harness/v0",
    identity: { name: "x", summary: "s" },
    contracts: [
      { id: "../../../escape", kind: "api", desc: "escape" },
      { id: ".hidden", kind: "api", desc: "hidden" },
      { id: "has space", kind: "api", desc: "space" },
      { id: "safe.v1_contract-2", kind: "api", desc: "safe" },
      { id: "CON.api", kind: "api", desc: "Windows device name" },
    ],
  };
  const errors = validateManifest(m)
    .filter((issue) => issue.level === "error")
    .map((issue) => issue.msg);
  assert.equal(errors.filter((message) => /contracts\[\d+\]\.id 必须是可移植文件名/.test(message)).length, 4);
  assert.ok(!errors.some((message) => /contracts\[3\]\.id/.test(message)));
});

test("contract ids are unique after ASCII case-folding", () => {
  const m: Manifest = {
    spec: "ai-harness/v0",
    identity: { name: "x", summary: "s" },
    contracts: [
      { id: "API", kind: "api", desc: "upper" },
      { id: "api", kind: "api", desc: "lower" },
    ],
  };
  const errors = validateManifest(m).filter((issue) => issue.level === "error").map((issue) => issue.msg);
  assert.ok(errors.some((message) => /大小写不敏感文件系统上重复: api/.test(message)));
});

test("knowledge root and authority accept repo documents without constraining directory names", () => {
  const m: Manifest = {
    spec: "ai-harness/v0",
    identity: { name: "x", summary: "s" },
    knowledge: [
      { path: "engineering/tribal-notes/api.md", root: "repo", authority: "derived", binds: ["src/api.ts"] },
      { path: "knowledge/policy.md", root: "agents", authority: "policy", binds: ["src/auth.ts"] },
      { path: "README.md", root: "repo", authority: "review" },
    ],
  };
  assert.deepEqual(
    validateManifest(m).filter((issue) => issue.level === "error"),
    [],
  );
});

test("knowledge paths stay inside their declared root and remain unambiguous for review", () => {
  const m: Manifest = {
    spec: "ai-harness/v0",
    identity: { name: "x", summary: "s" },
    knowledge: [
      { root: "repo", path: "../outside.md", binds: ["/tmp/source.ts"] },
      { root: "agents", path: "same.md" },
      { root: "repo", path: "same.md" },
    ],
    modules: [{ name: "escape", role: "invalid", entry: ["../outside.ts"] }],
  };
  const errors = validateManifest(m)
    .filter((issue) => issue.level === "error")
    .map((issue) => issue.msg);
  assert.ok(errors.some((message) => /knowledge.*path.*相对路径|knowledge.*path.*越界/.test(message)));
  assert.ok(errors.some((message) => /binds.*相对路径|binds.*越界/.test(message)));
  assert.ok(errors.some((message) => /knowledge path 重复.*same\.md/.test(message)));
  assert.ok(errors.some((message) => /module.*entry.*相对路径|module.*entry.*越界/.test(message)));
});

test("knowledge root, authority, and invariant allow_empty are type checked", () => {
  const m = {
    spec: "ai-harness/v0",
    identity: { name: "x", summary: "s" },
    knowledge: [{ path: "README.md", root: "somewhere", authority: "truthy" }],
    invariants: [{ id: "absence", rule: "file stays absent", enforcement: { forbid_pattern: ["bad"], allow_empty: "yes" } }],
  } as unknown as Manifest;
  const errors = validateManifest(m)
    .filter((issue) => issue.level === "error")
    .map((issue) => issue.msg);
  assert.ok(errors.some((message) => /knowledge.*root.*agents\/repo/.test(message)));
  assert.ok(errors.some((message) => /knowledge.*authority.*derived\/policy\/review/.test(message)));
  assert.ok(errors.some((message) => /allow_empty.*布尔值/.test(message)));
});

test("negated globs fail with an actionable positive-glob diagnostic", () => {
  const m: Manifest = {
    spec: "ai-harness/v0",
    identity: { name: "x", summary: "s" },
    invariants: [{ id: "safe", rule: "safe", enforcement: { forbid_pattern: ["bad"], path_glob: ["src/**", "!src/test/**"] } }],
    modules: [{ name: "core", role: "core", entry: ["src/index.ts"], owns: ["!src/generated/**"] }],
    validation: { required_coverage: ["!test/**"] },
  };
  const errors = validateManifest(m)
    .filter((issue) => issue.level === "error")
    .map((issue) => issue.msg);
  assert.equal(errors.filter((message) => /不支持 ! 否定 glob/.test(message)).length, 3);
});

test("oversized path_glob is rejected during manifest validation before matcher execution", () => {
  const m: Manifest = {
    spec: "ai-harness/v0",
    identity: { name: "x", summary: "s" },
    invariants: [
      { id: "oversized", rule: "must not reach fast-glob", enforcement: { forbid_pattern: ["bad"], path_glob: ["a".repeat(70_000)] } },
    ],
  };
  const errors = validateManifest(m)
    .filter((issue) => issue.level === "error")
    .map((issue) => issue.msg);
  assert.ok(errors.some((message) => /path_glob\[0\].*过长.*4096.*安全编译/.test(message)));
});

test("missing spec and identity.name are reported as errors", () => {
  const m = { identity: {} } as unknown as Manifest;
  const errs = validateManifest(m)
    .filter((i) => i.level === "error")
    .map((i) => i.msg);
  assert.ok(errs.some((e) => /spec/.test(e)));
  assert.ok(errs.some((e) => /identity\.name/.test(e)));
});

test("duplicate invariant id is an error", () => {
  const m: Manifest = {
    spec: "ai-harness/v0",
    identity: { name: "x", summary: "s" },
    invariants: [
      { id: "dup", rule: "r1", manual: true },
      { id: "dup", rule: "r2", manual: true },
    ],
  };
  const errs = validateManifest(m)
    .filter((i) => i.level === "error")
    .map((i) => i.msg);
  assert.ok(errs.some((e) => /重复: dup/.test(e)));
});

test("routing verify referencing an unknown capability warns", () => {
  const m: Manifest = {
    spec: "ai-harness/v0",
    identity: { name: "x", summary: "s" },
    routing: [{ when: "fix", verify: ["nonexistent"] }],
  };
  const warns = validateManifest(m)
    .filter((i) => i.level === "warn")
    .map((i) => i.msg);
  assert.ok(warns.some((w) => /未声明的 capability/.test(w)));
});

test("module.checks must reference a declared capability (error)", () => {
  const m: Manifest = {
    spec: "ai-harness/v0",
    identity: { name: "x", summary: "s" },
    capabilities: { test: { run: "t" } },
    modules: [{ name: "a", role: "r", entry: ["src/a.ts"], checks: ["test", "ghost"] }],
  };
  const errs = validateManifest(m)
    .filter((i) => i.level === "error")
    .map((i) => i.msg);
  assert.ok(errs.some((e) => /ghost/.test(e) && /capability/.test(e)));
});

test("validation checksets/defaults must reference declared capabilities (error)", () => {
  const m: Manifest = {
    spec: "ai-harness/v0",
    identity: { name: "x", summary: "s" },
    capabilities: { test: { run: "t" } },
    validation: {
      checksets: { ui: { checks: ["test", "phantom"] } },
      defaults: { no_match: ["nope"], always: ["test"] },
    },
  };
  const errs = validateManifest(m)
    .filter((i) => i.level === "error")
    .map((i) => i.msg);
  assert.ok(errs.some((e) => /phantom/.test(e)));
  assert.ok(errs.some((e) => /nope/.test(e)));
});

test("a validation checkset must declare its checks array", () => {
  const m = {
    spec: "ai-harness/v0",
    identity: { name: "x", summary: "s" },
    validation: { checksets: { full: {} } },
  } as unknown as Manifest;
  const errors = validateManifest(m)
    .filter((issue) => issue.level === "error")
    .map((issue) => issue.msg);
  assert.ok(errors.some((message) => /checksets\.full\.checks.*必填/.test(message)));
});

test("a non-array where an array is expected is an error (Array.isArray guard)", () => {
  const m = {
    spec: "ai-harness/v0",
    identity: { name: "x", summary: "s" },
    modules: [{ name: "a", role: "r", entry: ["src/a.ts"], owns: "src/**" }],
  } as unknown as Manifest;
  const errs = validateManifest(m)
    .filter((i) => i.level === "error")
    .map((i) => i.msg);
  assert.ok(errs.some((e) => /owns/.test(e) && /数组/.test(e)));
});

test("a non-object manifest root is rejected without throwing", () => {
  const errs = validateManifest(null as unknown as Manifest).filter((issue) => issue.level === "error");
  assert.match(errs[0]?.msg ?? "", /根节点/);
});

test("test-touch policy and required coverage shapes are validated", () => {
  const m = {
    spec: "ai-harness/v0",
    identity: { name: "x" },
    modules: [{ name: "a", role: "r", entry: ["src/a.ts"], test_touch: "sometimes" }],
    validation: { policies: { test_touch_default: "always" }, required_coverage: "src/**" },
  } as unknown as Manifest;
  const errors = validateManifest(m)
    .filter((issue) => issue.level === "error")
    .map((issue) => issue.msg);
  assert.ok(errors.some((message) => /test_touch/.test(message)));
  assert.ok(errors.some((message) => /required_coverage/.test(message)));
});

test("numeric routing.verify and module.checks report schema errors instead of throwing", () => {
  const m = {
    spec: "ai-harness/v0",
    identity: { name: "x" },
    routing: [{ when: "fix", verify: 1 }],
    modules: [{ name: "a", role: "r", entry: ["src/a.ts"], checks: 1 }],
  } as unknown as Manifest;
  const errors = validateManifest(m)
    .filter((issue) => issue.level === "error")
    .map((issue) => issue.msg);
  assert.ok(errors.some((message) => /routing.*verify/.test(message)));
  assert.ok(errors.some((message) => /module.*checks/.test(message)));
});

test("invariant execution controls reject quoted booleans and ambiguous manual checks", () => {
  const m = {
    spec: "ai-harness/v0",
    identity: { name: "x", summary: "s" },
    invariants: [
      { id: "quoted", rule: "must run", manual: "false", enforcement: { forbid_pattern: ["bad"] } },
      { id: "ambiguous", rule: "choose one mode", manual: true, check: "true" },
    ],
  } as unknown as Manifest;
  const errors = validateManifest(m)
    .filter((issue) => issue.level === "error")
    .map((issue) => issue.msg);
  assert.ok(errors.some((message) => /quoted\.manual.*布尔值/.test(message)));
  assert.ok(errors.some((message) => /ambiguous.*同时声明/.test(message)));
});

test("invalid invariant regular expressions are rejected before verify executes them", () => {
  const m: Manifest = {
    spec: "ai-harness/v0",
    identity: { name: "x", summary: "s" },
    invariants: [{ id: "broken-rx", rule: "must compile", enforcement: { forbid_pattern: ["["] } }],
  };
  const errors = validateManifest(m)
    .filter((issue) => issue.level === "error")
    .map((issue) => issue.msg);
  assert.ok(errors.some((message) => /broken-rx.*forbid_pattern.*正则/.test(message)));
});

test("module.name must be a non-empty string", () => {
  const m = {
    spec: "ai-harness/v0",
    identity: { name: "x", summary: "s" },
    modules: [{ name: 42, role: "r", entry: ["src/a.ts"] }],
  } as unknown as Manifest;
  const errors = validateManifest(m)
    .filter((issue) => issue.level === "error")
    .map((issue) => issue.msg);
  assert.ok(errors.some((message) => /module\.name.*字符串/.test(message)));
});
