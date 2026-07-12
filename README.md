# @erzhe/harness-kit

> 给 Agent 发一句话，让它帮你把仓库变成 AI 友好的。

harness-kit 把仓库的工程知识（这是什么、怎么跑、什么不能破、改东西看哪）沉淀成一份 `.agents/manifest.yaml`，然后自动生成各家 Agent 的入口文件（`AGENTS.md` / `CLAUDE.md`），并用门禁保证它们始终一致。

---

## 最快上手

在**任意仓库**里，把这句话丢给你的 Agent（Cursor / Claude Code / Codex 通用）：

```
Onboard 本仓库到 harness-kit：跑 npx -y @erzhe/harness-kit@latest onboard，然后严格按输出执行。
```

就这一句。Agent 会：

1. 拉取最新版的 onboard skill
2. 扫描你的仓库（读 README、package.json、目录结构…）
3. 盘点已有 `AGENTS.md` / `CLAUDE.md` 及其明确引用的业务文档；原文留在原位置，不按文件夹名搬家
4. 先保存逐字节 legacy 快照，再由另一个 Agent 盲审规则是否完整；明确缺口自动修复并复审，只有语义歧义才找人确认
5. 跑 `sync` / `doctor` / `verify`，补齐真实的 `owns / tests / checks` 影响面
6. 自动识别当前客户端和 Git worktree 形态，安装真正会生效的 Agent SessionStart + Stop 门禁，并用一个新会话留下真实 evidence；原生 Git hooks 只在作用域可证明安全时按需安装

全程走 `npx`，不全局安装 npm 包；你一发新版，所有人下次执行就用上了。唯一的用户级文件例外是 Codex linked-worktree 的显式安全分发器（见下文），因为当前 Codex 不读取该形态下的项目 Hook。

运行要求：Node.js 18 或更高版本。发布前会用打包后的 CLI 在真实 Node 18 上做 `help / doctor / verify` smoke。

---

## 初始化后你得到什么

```
你的仓库/
  AGENTS.md                    ← [生成] 跨工具入口，Agent 每次会话必读
  CLAUDE.md                    ← [生成] Claude Code 入口
  .agents/
    manifest.yaml              ← 你维护的唯一真相源
    knowledge/                 ← Harness 自己新增的知识（不强迫搬入已有业务文档）
    reference.md               ← [生成] 完整命令、环境、原位置知识路径目录
    contracts/                 ← 对外接口的契约基线
    adoption/legacy/           ← 首次接管前的逐字节入口文件快照
    playbooks/                 ← 可复用的工作流（SKILL.md）
    routing.md                 ← [生成] 按改动类型导航：改 UI 看哪、加接口看哪
    modules.md                 ← [生成] 模块卡：每个子系统的职责/入口/坑
```

以后改工程结构 → 编辑 `manifest.yaml` → `harness-kit sync`。`sync` 只重生成确定性文件，不会替你声称“知识已经复核”。业务文档仍在原路径更新；Agent 完成语义审查后再运行 `record-context-review` 留证。

---

## 接入之后：自动防腐烂，人只 review

harness-kit 的长期价值不在首次接入，而在**代码演进时上下文不腐烂**——而且这件事不该靠人记命令：

- **Agent 钩子是交付闭环**：SessionStart 记住任务起点，Stop 让 Claude Code / Cursor / Codex 在结束前真正跑本次改动对应的检查。`doctor` 会显示 `CONFIGURED / ACTIVE / DEGRADED`，避免“文件装了但客户端没执行”被误报成成功。
- **Git 钩子是可选增强**：它可能影响 linked worktree 或覆盖第三方工具，因此默认只在单 worktree、默认 hooks 路径、无外来 hook 时安装；冲突时拒绝写入并给出路径，不自动 merge。
- **漂移了让 Agent 自愈**：知识过期 / 接口契约变了，把仓库丢给 Agent 说一句 `onboard`，它会照 skill 自动考古、改 manifest/knowledge、有据才 accept 契约，最后**产出一份变更清单**。
- **你只做一个动作**：审查那份 diff，批准或打回。生产和更新都交给 Agent，人只 review。

```
代码演进 → [hook/CI] verify 红灯，指出哪块过期/哪个契约变了
        → [Agent] 自动修 + 产出变更清单
        → [你] review：批准 or 打回      ← 唯一的人工动作
```

---

## 命令

| 命令 | 作用 |
| --- | --- |
| `harness-kit onboard` | 打印 onboard skill 给 Agent（配合 npx，永远最新、零安装） |
| `harness-kit init` | 铺 `.agents/` 骨架 + 空白 manifest |
| `harness-kit sync` | manifest → 事务生成 AGENTS.md / CLAUDE.md / reference / routing / modules；不刷新知识复核 |
| `harness-kit prepare-adoption` | 在仓外生成私有 blind-audit bundle；包含旧入口、嵌套 AGENTS/CLAUDE 及它们显式引用的文档证据和确定性候选，不改仓内文件 |
| `harness-kit record-adoption-audit` | 把声明的 pass/fail、理由和审计报告 hash 绑定到一版候选 |
| `harness-kit sync --adopt-existing --candidate ... --audit ...` | 首次接管：只有 live legacy、候选、manifest 和 pass receipt 逐字节一致才事务写入 |
| `harness-kit doctor` | 体检：完整性 / 路径引用 / 漂移 / 新鲜度 / 体量预算 |
| `harness-kit verify [--json]` | 门禁：跑不变量 + 契约 + 漂移，列出 GAPS；可输出单个结构化 JSON，失败非 0 退出 |
| `harness-kit accept-contract` | 有意变更接口后，记录新的契约指纹为基线 |
| `harness-kit install-hooks` | 可选装原生 Git hooks；共享 worktree、自定义/全局路径或第三方 hook 时安全拒绝 |
| `harness-kit install-hooks --stop --agents <client>` | 只给实际使用的客户端装生命周期门禁：会话开始记基线，结束前跑 `run-checks` + `verify` |
| `harness-kit install-hooks --stop --agents codex --allow-user-dispatcher` | Codex linked-worktree fallback：保留已有用户 Hook，安装一个惰性分发器并只登记当前 worktree |
| `harness-kit plan-checks` | 只看本次改动会影响哪些模块、该跑什么、还有哪些验证缺口 |
| `harness-kit run-checks` | 真正执行本次改动对应的检查，并保存可追溯证据 |
| `harness-kit evidence` | 查看最近一次验收状态、检查结果和豁免理由 |
| `harness-kit record-context-review` | Agent 完成语义审查后，记录某条知识或模块的内容/来源 hash 与理由 |
| `harness-kit check-loop` | 打印给 Agent 使用的“实现 → 验收 → 修复 → 再验收”指南 |

所有命令都支持 `-C <dir>` 指定目标仓库（默认当前目录）。

首次接管是一个窄状态机，不靠 Agent 记住长说明：`init` 保存将被接管的旧入口 → `prepare-adoption` 在仓外收集原地 guidance 并生成候选 → 独立 Agent 盲审 → `record-adoption-audit` 绑定报告 → 带 candidate/receipt 的 `sync --adopt-existing` 才能写真实入口。manifest、旧入口、snapshot/index、嵌套入口/显式引用文档、候选文件或审计报告任一变化，旧回执立即失效；裸 `--adopt-existing` 不能接管。回执明确写 `assurance: declared`、`independence: unverified`：它能强制顺序和准确字节，不能在没有外部身份系统时伪装证明“审计者一定独立、语义判断一定正确”。

## 实现之后，怎么保证真的验收了

举四个常见场景：

- **修旧 bug**：Agent 改了生产代码，却没补回归测试。关键模块配置为 `test_touch: required` 后，结束时会直接拦住，直到补测试；若测试确实不适用，可对这个覆盖缺口留下有范围、有理由的豁免。
- **代码已经 commit**：门禁从会话开始时记住基线，所以不会因为 `HEAD` 前进就误判“没有改动”。
- **客户端 hook 没触发**：手动开始任务时先记下 `git rev-parse HEAD`；若中途已经 commit，用 `run-checks --base <task-start-sha>` 验收。未提供任务起点的手动 `no-change` 不算交付证据。
- **检查根本没跑**：命令不存在、被标成后台任务/有副作用、Git base 无效或 manifest 写坏，都算 `not-verified`，不会再用“跳过”冒充成功。

项目接入时，由 Agent 根据模块风险提议策略，人来 review：默认只是提醒；公共接口、核心逻辑等关键模块再设为强制。每次结果会落到当前 worktree 的私有 Git 状态里，`harness-kit evidence` 随时可查。只有“没补测试 / 模块暂时没测试 / 必需范围未映射”这三类覆盖缺口可豁免；检查没跑、配置写坏、Git 对比失败等系统问题不能绕过。豁免只对当前代码指纹有效，代码一变就失效。

注意：客户端显示“hook 已安装”不等于它真的执行过。`doctor` / `verify --json` 的 Hook 状态会区分：有效配置齐全但尚无新会话证据是 `CONFIGURED`；当前 hook evidence 两道门都过、并且 SessionStart 绑定的完整有效配置指纹仍与现场完全一致，才是 `ACTIVE`；runner 缺失、配置残缺、配置/override/分发器/登记改变、证据失败或 stale 都是 `DEGRADED`。`evidence` JSON 的 `hookActive` 使用同一配置绑定；交付证据本身仍可能有效，但它不会继续替另一版 Hook 配置背书。Codex linked worktree 必须显式使用 `--allow-user-dispatcher`；Cursor 的部分 headless/cloud surface 仍可能不触发生命周期 hooks，CLI 不会伪造成功。

普通 worktree 的 Agent Hook 只写项目内普通文件：runner 与所选客户端配置会先整组预检，再事务写入，最终路径及父目录都不能是软链接。已有 JSON 的 `hooks` 结构无法安全合并、或 runner 属于第三方时，整组拒绝且不留半套文件；`--force` 也不会覆盖第三方 runner。合法的第三方 hook 数组条目会原样保留，只替换与安装器生成的 runner、Agent、事件和失败兜底完整匹配的 Harness 命令；仅仅在注释里出现 marker 不算我们的 Hook。

Codex linked-worktree 是一个受限例外：项目文件仍按上述事务写入，之后才以 compare-and-swap 方式更新 Codex 的**用户 Hook 源配置**，加入两条精确 managed 入口和版本化、兼容 Node 18 的分发器，最后把当前 worktree 的登记以 `0600` 写进其私有 Git admin dir。普通 Codex 的源配置就是当前 `$CODEX_HOME`（未设置时为 `~/.codex`）；Orca 的 `$CODEX_HOME` 是每次创建终端时由 `~/.codex` 派生的运行时副本，因此安装器会自动写 `~/.codex` 源配置，并要求新建一次 Orca Agent 会话让它安全同步。Harness 不改 Orca 的生成脚本、当前运行时文件或 Hook 信任记录。其他用户 Hook 条目的语义内容与相对顺序保持不变；未登记仓库静默不执行，登记存在但路径、权限、runner hash 或配置不一致则 fail closed。未知 JSON、同名外来分发器、并发修改都会让安装失败，且登记最后写入，因此不会留下“看似激活”的半套状态。这不是原生 Git hook，也不会影响其他 worktree 的业务文件。

`evidence` 不是旧绿灯截图：每次读取都会重新核对当前代码，代码一变就标 `stale` 并返回失败。手动执行时，`run-checks` 只会得到 `runChecksValid`；随后对同一代码运行 `verify`，整体 `valid` 才会变成 true。若会话开始时工作区已经有未提交改动，门禁会把这些既有改动也纳入验收范围，并在 evidence 里列出；它保证不漏，不冒充精确的任务归因。

测试文件按最终工作树状态判断：只有新增或修改才满足 `test_touch`，哪怕先暂存修改、随后又删除，也不会被当成“补过测试”。改动指纹还包含可执行位与 submodule 当前提交/脏状态，避免代码内容没变时误沿用旧证据。自动 checks 最多共享 7 分钟，随后 `verify` 最多 2 分钟，确保在客户端 10 分钟 hook 上限前仍能返回明确的拦截结果；超时本身就是失败。

### 已有业务文档不用搬家

`knowledge.path` 不是固定目录规则。它可以指向 `.agents/` 内由 Harness 新建的知识，也可以登记仓库里任何已有相对路径：

```yaml
knowledge:
  - root: repo
    path: engineering/tribal-notes/api.md   # 文件夹名完全由业务仓库决定
    role: api
    authority: derived
    binds: [src/api/router.ts]
  - root: agents                           # 默认值
    path: knowledge/security-policy.md
    authority: policy
    binds: [src/auth/index.ts]
```

`root: repo` 只表示“从仓库根解析”，不是把 `docs/`、`knowledge/`、`context/` 三个名字写死；CLI 也不会复制这些文件。`authority: derived` 表示文档应跟代码事实同步，`policy` 表示文档约束代码，`review` 表示两边需要 Agent 做语义核对。三种都必须先分析，再由 Agent 运行 `record-context-review --path ... --reason ...`；命令只保存证据，不会替 Agent 做判断。

---

## 它解决什么问题

传统工程化（脚手架 / lint / CI）是**面向人、面向过去**的。Agent 需要的是显式、结构化、可机器消费的知识：

- **这是什么** → `identity`（name / summary / scope）
- **怎么跑** → `capabilities`（setup / build / test / dev…）
- **什么绝不能破** → `invariants`（声明式正则门禁）+ `contracts`（接口指纹基线）
- **改东西看哪** → `routing`（按改动类型导航）+ `modules`（模块卡）
- **哪些验证不了** → `GAPS`（诚实标注，绝不谎报）

harness-kit 把这些沉淀进 manifest，再确定性地生成与校验。

---

## 工作原理

```
.agents/manifest.yaml ──sync──> Agent 入口 / 路由 / 模块图
          │
          └── 本次 diff ──plan-checks──> 影响模块 + checks + gaps
                                      │
                                      └──run-checks + verify──> evidence / 继续修
```

- **不变量**：声明式正则 `enforcement`（确定性、无 LLM），或标 `manual`
- **契约**：`snapshot` 打印接口指纹 → CLI 存基线并 diff（协议无关）
- **新鲜度**：知识条目可登记任意 repo 内相对路径；`authority` 决定语义责任，Agent 审查后记录内容与 `binds` hash，任何一侧变化都会失效
- **GAPS**：打包 / 真网络 / 生产上传等本地验证不了的，显式列出

---

## 让 Agent 自动触发（可选）

上面的"最快上手"是**显式调用**——你每次说"onboard 本仓库"，Agent 才会做。如果你想让某个 Agent **自动识别**"该给仓库接 harness-kit"，可以把 skill 软链进它的 skill 目录：

```bash
# Cursor
ln -sf "$(npm root -g)/@erzhe/harness-kit/skills/erzhe-harness-init" ~/.cursor/skills/

# Claude Code
ln -sf "$(npm root -g)/@erzhe/harness-kit/skills/erzhe-harness-init" ~/.claude/skills/
```

这样当用户说"给这个仓库配置 harness"时，Agent 会自动找到并执行这个 skill。

---

## 开发

```bash
pnpm install
pnpm typecheck          # tsc --noEmit
pnpm test               # node:test + tsx
pnpm build              # esbuild → dist/harness-kit.cjs
pnpm exec tsx src/cli.ts verify --repo .   # 自托管验证
```

## 文档

- [`SPEC-v0.md`](SPEC-v0.md) — manifest schema + 生成/校验契约

## License

MIT © [MeCKodo (二哲)](https://erzhe.me/)
