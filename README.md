# @erzhe/harness-kit

> 给 Agent 发一句话，让它帮你把仓库变成 AI 友好的。

harness-kit 把仓库的工程知识（这是什么、怎么跑、什么不能破、改东西看哪）沉淀成一份 `.agents/manifest.yaml`，然后自动生成各家 Agent 的入口文件（`AGENTS.md` / `CLAUDE.md` / Cursor rules），并用门禁保证它们始终一致。

---

## 最快上手

在**任意仓库**里，把这句话丢给你的 Agent（Cursor / Claude Code / Codex 通用）：

```
Onboard 本仓库到 harness-kit：跑 npx -y @erzhe/harness-kit@latest onboard，然后严格按输出执行。
```

就这一句。Agent 会：

1. 拉取最新版的 onboard skill
2. 扫描你的仓库（读 README、package.json、目录结构…）
3. 逐块跟你确认着填 `.agents/manifest.yaml`
4. 跑 `sync` / `doctor` / `verify` 直到全绿

全程走 `npx`，不往机器上装任何全局东西；你一发新版，所有人下次执行就用上了。

---

## 初始化后你得到什么

```
你的仓库/
  AGENTS.md                    ← [生成] 跨工具入口，Agent 每次会话必读
  CLAUDE.md                    ← [生成] Claude Code 入口
  .cursor/rules/               ← [生成] Cursor 规则
  .agents/
    manifest.yaml              ← 你维护的唯一真相源
    knowledge/                 ← Agent 从代码推不出来的知识（领域、约定、决策）
    contracts/                 ← 对外接口的契约基线
    playbooks/                 ← 可复用的工作流（SKILL.md）
    routing.md                 ← [生成] 按改动类型导航：改 UI 看哪、加接口看哪
    modules.md                 ← [生成] 模块卡：每个子系统的职责/入口/坑
```

以后改工程知识 → 编辑 `manifest.yaml` → `harness-kit sync`。别手改生成物。

---

## 命令

| 命令 | 作用 |
| --- | --- |
| `harness-kit onboard` | 打印 onboard skill 给 Agent（配合 npx，永远最新、零安装） |
| `harness-kit init` | 铺 `.agents/` 骨架 + 空白 manifest |
| `harness-kit sync` | manifest → 生成 AGENTS.md / CLAUDE.md / Cursor rules / routing / modules |
| `harness-kit doctor` | 体检：完整性 / 路径引用 / 漂移 / 新鲜度 / 体量预算 |
| `harness-kit verify` | 门禁：跑不变量 + 契约 + 漂移，列出 GAPS，失败非 0 退出 |
| `harness-kit accept-contract` | 有意变更接口后，记录新的契约指纹为基线 |

所有命令都支持 `-C <dir>` 指定目标仓库（默认当前目录）。

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
.agents/manifest.yaml   (你 + Agent 维护的唯一源)
        │
   harness-kit sync     (确定性生成，勿手改产物)
        ▼
AGENTS.md / CLAUDE.md / .cursor/rules / .agents/routing.md / .agents/modules.md
        │
   harness-kit verify   (门禁：不变量 + 契约 + 漂移)
        ▼
   exit 0 / 非 0  +  诚实的 GAPS 清单
```

- **不变量**：声明式正则 `enforcement`（确定性、无 LLM），或标 `manual`
- **契约**：`snapshot` 打印接口指纹 → CLI 存基线并 diff（协议无关）
- **新鲜度**：知识条目 `binds` 源文件哈希，代码一动就告警
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
