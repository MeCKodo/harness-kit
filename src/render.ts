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
    "This file and everything under `.agents/` are GENERATED from `.agents/manifest.yaml`. " +
      "Do NOT edit them by hand — edit the manifest and run `harness-kit sync`.",
    "",
  );
  L.push("Before you touch code:");
  L.push(
    "1. Post a **Task Brief** in chat: what you'll change, which change-type it is, which layers/files it touches, and how you'll verify.",
  );
  if (m.routing?.length)
    L.push("2. Find your change-type in `.agents/routing.md` and read the files it points to. Do NOT full-repo grep and guess.");
  else L.push("2. Read the relevant files before editing. Do NOT full-repo grep and guess.");
  L.push("");
  L.push("Before you finish:");
  L.push("3. Run `harness-kit verify`. It enforces the invariants below and prints a **GAPS** list of what it cannot check.");
  L.push(
    "4. **Never claim a check you didn't run.** If something is a GAP (packaging, real network, prod upload), say so — don't pretend it passed.",
  );
  L.push(
    "5. If you learned something an agent could not infer from code (a gotcha, a decision, a fix), capture it under `.agents/knowledge/` " +
      "(a journal ADR for decisions). Do NOT record one-off noise or anything already obvious from the code.",
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

  const caps = Object.entries(m.capabilities ?? {});
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

  if (m.environment?.length) {
    L.push("## Environment", "");
    for (const e of m.environment) {
      const flags = [e.required ? "(required)" : "", e.secret ? "(secret — never hardcode/commit)" : ""]
        .filter(Boolean)
        .join(" ");
      L.push(`- \`${e.name}\`${flags ? " " + flags : ""}${e.desc ? ` — ${e.desc}` : ""}`);
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
  L.push("- Domain / conventions / decisions: `.agents/knowledge/`");
  if (m.routing?.length) L.push("- Change-type routing (read before editing): `.agents/routing.md`");
  if (m.modules?.length) L.push("- Module map + common pitfalls: `.agents/modules.md`");
  L.push("- Tooling adoption log (earn heavier tooling): `.agents/adoption.md`");
  if (m.playbooks?.dir) L.push(`- Task playbooks: \`.agents/${m.playbooks.dir}\``);
  L.push("");
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
    if (mod.upstream?.length) L.push(`- Upstream: ${mod.upstream.map(safeStr).join(", ")}`);
    if (mod.downstream?.length) L.push(`- Downstream: ${mod.downstream.map(safeStr).join(", ")}`);
    if (mod.must_know?.length) for (const k of mod.must_know) L.push(`- Must know: ${safeStr(k)}`);
    if (mod.pitfalls?.length) for (const p of mod.pitfalls) L.push(`- Pitfall: ${safeStr(p)}`);
    L.push("");
  }
  return L.join("\n");
}

export function renderClaudeMd(): string {
  // Claude Code reads the first-line @import; keep it first.
  return `@AGENTS.md\n\n${GEN_HEADER()}\n`;
}
