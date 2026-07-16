import { printSkill } from "../skill";

const SKILL_REL = "skills/harness-check-loop/SKILL.md";

const META = `<!-- harness-kit check-loop -->
You are an AI agent implementing a requirement or fixing a bug in the CURRENT repo.
Follow the loop below. Run every harness-kit command through
\`npx -y @erzhe/harness-kit@latest <cmd>\` unless a local build is available.
Primary finish gate: \`harness-kit deliver\` (scope → run-checks + verify → stamp).
Optional Stop hooks only check that stamp; they must not demand a new session.
Use \`evidence\` to inspect the durable stamp.

---

`;

export function checkLoopCmd(): number {
  return printSkill(SKILL_REL, META);
}
