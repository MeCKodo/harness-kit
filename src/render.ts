import type { Manifest } from "./manifest";
import { GEN_HEADER } from "./util";

/** Safely stringify a manifest value — objects become JSON instead of [object Object]. */
function safeStr(v: unknown): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

/** Generated tool files. Each returns [relPath, content]. Routing/modules only when present. */
export function renderTargets(m: Manifest): Array<[string, string]> {
  const targets: Array<[string, string]> = [
    ["AGENTS.md", renderAgentsMd(m)],
    ["CLAUDE.md", renderClaudeMd()],
    [".agents/reference.md", renderReferenceMd(m)],
  ];
  if (m.routing?.length) targets.push([".agents/routing.md", renderRoutingMd(m)]);
  if (m.modules?.length) targets.push([".agents/modules.md", renderModulesMd(m)]);
  return targets;
}

export function renderAgentsMd(m: Manifest): string {
  const id = m.identity;
  const L: string[] = [];
  L.push(GEN_HEADER(), "");
  L.push(`# ${id.name}`, "");
  if (id.summary) L.push(id.summary, "");

  L.push("## Working agreement (read first)", "");
  L.push(
    "`AGENTS.md`, `CLAUDE.md`, and `.agents/reference.md` are GENERATED from `.agents/manifest.yaml`; " +
      "`.agents/routing.md` / `.agents/modules.md` are generated when those sections are declared. " +
      "Do NOT edit those files by hand — edit the manifest and run `harness-kit sync`. " +
      "Knowledge is hand-authored; `.agents/hooks/` is managed by `harness-kit install-hooks`.",
    "",
  );
  L.push("Before you touch code:");
  L.push(
    "1. Post a **Task Brief** in chat: what you'll change, which change-type it is, which layers/files it touches, and how you'll verify.",
  );
  if (m.routing?.length)
    L.push("2. Find your change-type in `.agents/routing.md` and read the files it points to. Do NOT full-repo grep and guess.");
  else L.push("2. Read the relevant files before editing. Do NOT full-repo grep and guess.");
  if ((m.modules ?? []).some((mod) => (mod.owns?.length ?? 0) > 0) || m.validation)
    L.push("   Prefer `harness-kit task start` before editing so committed work stays in the deliver scope.");
  L.push("");
  const hasImpactMap = (m.modules ?? []).some((mod) => (mod.owns?.length ?? 0) > 0) || !!m.validation;
  L.push("Before you finish:");
  if (hasImpactMap) {
    L.push(
      "3. Run `harness-kit deliver` (impact-driven checks + verify + stamp). Only `status=accepted` (or clean `no-change`) means the task is done. If `needs-work`, fix and re-run — do not claim completion without an accepted stamp.",
    );
    L.push(
      "   Optional: `harness-kit task start` before editing so later commits stay in scope; without it, deliver falls back to the current worktree git diff vs HEAD.",
    );
  } else {
    L.push("3. Run `harness-kit deliver` (or at least `harness-kit verify`). Do not claim completion without a passing stamp/verify.");
  }
  L.push(
    "4. Read `NEXT ACTIONS` (or JSON `nextActions`): complete every `required | agent` action automatically before finishing; ask the user only for a `required | human` decision. Defer `recommended` maintenance during unrelated product work.",
  );
  L.push(
    "5. **Never claim a check you didn't run.** Informational boundaries (packaging, real network, prod upload) are not failures; mention one only when it is relevant to this task.",
  );
  L.push(
    "6. If you learned something an agent could not infer from code (a gotcha, a decision, a fix), update the registered knowledge source in place, " +
      "or add new Harness-owned knowledge under `.agents/knowledge/` (a journal ADR for decisions). Never move/copy an existing repo document just to fit a folder name. " +
      "Do NOT record one-off noise or anything already obvious from the code.",
  );
  L.push("");

  if (id.scope_in?.length || id.scope_out?.length) {
    L.push("## Scope");
    if (id.scope_in?.length) L.push("", "In scope:", ...id.scope_in.map((s) => `- ${safeStr(s)}`));
    if (id.scope_out?.length)
      L.push("", "Out of scope (do NOT modify here):", ...id.scope_out.map((s) => `- ${safeStr(s)}`));
    L.push("");
  }

  if (id.upstream?.length || id.downstream?.length) {
    L.push("## Dependencies");
    if (id.upstream?.length) L.push("", `Upstream: ${id.upstream.map(safeStr).join(", ")}`);
    if (id.downstream?.length) L.push("", `Downstream: ${id.downstream.map(safeStr).join(", ")}`);
    L.push("");
  }

  const allCaps = Object.entries(m.capabilities ?? {});
  const hasExplicitBootstrap = allCaps.some(([, capability]) => capability.bootstrap !== undefined);
  const defaultBootstrap = new Set(["setup", "test", "typecheck", "lint", "build", "verify", "dev"]);
  const caps = allCaps.filter(([verb, capability]) =>
    hasExplicitBootstrap ? capability.bootstrap === true : defaultBootstrap.has(verb),
  );
  if (caps.length) {
    L.push("## Commands", "");
    for (const [verb, c] of caps) {
      const tags = [c.background ? "(long-running)" : "", c.mutating ? "(mutating — confirm first)" : ""]
        .filter(Boolean)
        .join(" ");
      L.push(`- \`${verb}\`: \`${c.run}\`${c.desc ? ` — ${c.desc}` : ""}${tags ? " " + tags : ""}`);
      if (c.example) L.push(`  - example: \`${c.example}\``);
    }
    L.push("");
  }

  if (m.contracts?.length) {
    L.push("## Contracts (breaking changes need a version bump)", "");
    for (const c of m.contracts) {
      L.push(`- ${c.id} [${c.kind}]${c.breaking_needs ? ` (breaking -> ${c.breaking_needs})` : ""}: ${c.desc}`);
    }
    L.push("");
  }

  if (m.invariants?.length) {
    L.push("## Invariants (must hold)", "");
    for (const inv of m.invariants) {
      const how = inv.enforcement ? "enforced" : inv.check ? "checked" : "manual";
      L.push(`- ${inv.rule} [${how}]`);
    }
    L.push("", "Run `harness-kit verify` to check the enforceable ones.", "");
  }

  L.push("## Knowledge & maps (load on demand)", "");
  if (!(m.knowledge?.length) || m.knowledge.some((knowledge) => (knowledge.root ?? "agents") === "agents"))
    L.push("- Harness-owned domain / conventions / decisions: `.agents/knowledge/`");
  if (m.knowledge?.some((knowledge) => knowledge.root === "repo"))
    L.push("- Existing repository documents stay in place; use their exact paths from `.agents/reference.md`");
  if (allCaps.length || m.environment?.length || m.knowledge?.length)
    L.push("- Full commands, environment, and registered knowledge catalog: `.agents/reference.md`");
  if (m.routing?.length) L.push("- Change-type routing (read before editing): `.agents/routing.md`");
  if (m.modules?.length) L.push("- Module map + common pitfalls: `.agents/modules.md`");
  if (hasImpactMap) L.push("- Implement -> verify loop (deep guide): run `harness-kit check-loop`");
  L.push("- Tooling adoption log (earn heavier tooling): `.agents/adoption.md`");
  if (m.playbooks?.dir) L.push(`- Task playbooks: \`.agents/${m.playbooks.dir}\``);
  L.push("");
  return L.join("\n");
}

/** Full catalog kept out of the bootstrap budget. */
export function renderReferenceMd(m: Manifest): string {
  const L: string[] = [GEN_HEADER(), "", "# Harness reference", ""];
  const caps = Object.entries(m.capabilities ?? {});
  if (caps.length) {
    L.push("## Commands", "");
    for (const [verb, capability] of caps) {
      const tags = [
        capability.bootstrap ? "(bootstrap)" : "",
        capability.background ? "(long-running)" : "",
        capability.mutating ? "(mutating — confirm first)" : "",
      ]
        .filter(Boolean)
        .join(" ");
      L.push(`- \`${verb}\`: \`${capability.run}\`${capability.desc ? ` — ${capability.desc}` : ""}${tags ? ` ${tags}` : ""}`);
      if (capability.example) L.push(`  - example: \`${capability.example}\``);
    }
    L.push("");
  }
  if (m.environment?.length) {
    L.push("## Environment", "");
    for (const variable of m.environment) {
      const flags = [variable.required ? "(required)" : "", variable.secret ? "(secret — never hardcode/commit)" : ""]
        .filter(Boolean)
        .join(" ");
      L.push(`- \`${variable.name}\`${flags ? ` ${flags}` : ""}${variable.desc ? ` — ${variable.desc}` : ""}`);
    }
    L.push("");
  }
  if (m.knowledge?.length) {
    L.push("## Registered knowledge", "");
    for (const knowledge of m.knowledge) {
      const path = knowledge.root === "repo" ? knowledge.path : `.agents/${knowledge.path}`;
      const tags = [knowledge.role ? `role=${knowledge.role}` : "", knowledge.authority ? `authority=${knowledge.authority}` : ""]
        .filter(Boolean)
        .join(", ");
      L.push(`- \`${path}\`${tags ? ` (${tags})` : ""}`);
    }
    L.push("");
  }
  return L.join("\n");
}

/** .agents/routing.md — per change-type navigation. On-demand, not size-budgeted. */
export function renderRoutingMd(m: Manifest): string {
  const L: string[] = [];
  L.push(GEN_HEADER(), "");
  L.push("# Change routing", "");
  L.push("Find the change-type that matches your task and follow that row before editing.", "");
  for (const r of m.routing ?? []) {
    L.push(`## ${r.when}`);
    if (r.read?.length) L.push(`- Read first: ${r.read.map((s) => `\`${safeStr(s)}\``).join(", ")}`);
    if (r.entry?.length) L.push(`- Entry points: ${r.entry.map((s) => `\`${safeStr(s)}\``).join(", ")}`);
    if (r.dont_assume?.length) for (const d of r.dont_assume) L.push(`- Do NOT assume: ${safeStr(d)}`);
    if (r.verify?.length) L.push(`- Minimum verification: ${r.verify.map((s) => `\`${safeStr(s)}\``).join(", ")}`);
    L.push("");
  }
  return L.join("\n");
}

/** .agents/modules.md — module cards. On-demand, not size-budgeted. */
export function renderModulesMd(m: Manifest): string {
  const L: string[] = [];
  L.push(GEN_HEADER(), "");
  L.push("# Module map", "");
  for (const mod of m.modules ?? []) {
    L.push(`## ${mod.name} — ${mod.role}`);
    if (mod.entry?.length) L.push(`- Entry: ${mod.entry.map((s) => `\`${safeStr(s)}\``).join(", ")}`);
    if (mod.owns?.length) L.push(`- Owns (prod): ${mod.owns.map((s) => `\`${safeStr(s)}\``).join(", ")}`);
    if (mod.tests?.length) L.push(`- Tests: ${mod.tests.map((s) => `\`${safeStr(s)}\``).join(", ")}`);
    if (mod.checks?.length) L.push(`- Checks: ${mod.checks.map((s) => `\`${safeStr(s)}\``).join(", ")}`);
    if (mod.gates?.length) L.push(`- Validation gates: ${mod.gates.map((s) => `\`${safeStr(s)}\``).join(", ")}`);
    if (mod.test_touch) L.push(`- Test touch: \`${safeStr(mod.test_touch)}\``);
    if (mod.playbook) L.push(`- Playbook: \`${safeStr(mod.playbook)}\``);
    if (mod.upstream?.length) L.push(`- Upstream: ${mod.upstream.map(safeStr).join(", ")}`);
    if (mod.downstream?.length) L.push(`- Downstream: ${mod.downstream.map(safeStr).join(", ")}`);
    if (mod.must_know?.length) for (const k of mod.must_know) L.push(`- Must know: ${safeStr(k)}`);
    if (mod.pitfalls?.length) for (const p of mod.pitfalls) L.push(`- Pitfall: ${safeStr(p)}`);
    L.push("");
  }
  if (m.validation?.gates && Object.keys(m.validation.gates).length) {
    L.push("# Validation gates", "");
    L.push("Project-defined mandatory proof obligations. Profiles may replace ordinary module checks, but they cannot bypass these gates.", "");
    for (const [id, gate] of Object.entries(m.validation.gates)) {
      L.push(`## ${safeStr(id)}${gate.desc ? ` — ${safeStr(gate.desc)}` : ""}`);
      L.push(`- Mandatory checks: ${gate.checks.map((check) => `\`${safeStr(check)}\``).join(", ")}`);
      if (gate.acceptance) {
        L.push(`- Acceptance tests: ${gate.acceptance.tests.map((test) => `\`${safeStr(test)}\``).join(", ")}`);
        L.push(`- Acceptance test touch: \`${safeStr(gate.acceptance.test_touch)}\``);
      }
      L.push("");
    }
  }
  return L.join("\n");
}

export function renderClaudeMd(): string {
  // Claude Code reads the first-line @import; keep it first.
  return `@AGENTS.md\n\n${GEN_HEADER()}\n`;
}
