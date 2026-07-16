---
name: harness-check-loop
description: 在已接入 harness-kit 的仓库里实现需求 / 修 bug 时的「实现 → deliver 验收」闭环。一条 deliver 跑影响面检查 + verify + stamp。
---

# harness-check-loop

目标：**证明这次改动真的交付了**，不是只写完代码。

## 一条命令

```bash
harness-kit deliver --repo .
```

内部固定：解析改动范围 → `run-checks`（影响面 / gates）→ `verify` → 稳定指纹 → **stamp**。

| deliver status | 含义 |
|---|---|
| `accepted` | 可向用户宣布完成 |
| `needs-work` | 按输出修，再跑 deliver |
| `no-change` | 工作区无待验改动（干净） |

**没有 `accepted`（或干净 `no-change`）就不要说做完了。**

## 改动范围怎么定

1. `harness-kit task start` 或 `--base <sha>` → 任务范围（含之后 commit）
2. SessionStart（若装了 Hook）会自动 `task start`
3. 都没有 → **降级为当前工作区 git diff（相对 HEAD）**，对这些文件跑测

不要默认拿 origin/main 乱算范围。

## 闭环步骤

1. （推荐）`harness-kit task start --repo .`
2. 按 routing / modules 实现；生产代码同步补测试 / gate acceptance
3. `harness-kit deliver --repo .`
4. `needs-work` → 修失败与 blocking gap → 再 deliver
5. `harness-kit evidence --repo .` 看 stamp；`stale` 则回到 3

## 与 Hook 的关系

- **Stop Hook 默认 thin**：没有匹配 stamp 就 block，并提示跑 `deliver`（不要求新开会话）
- `HARNESS_KIT_STOP_MODE=execute` 时 Stop 内直接重跑验收（兼容旧行为）
- **没装 Hook 也能闭环**：靠 AGENTS 协议 + deliver；Git/CI 再兜底
- 不要把 `hookActive` 当成交付成功标准

## 红线

- ❌ 没跑 `deliver` 就说做完了
- ❌ 为消 gap 造假测试或无意义 waiver
- ❌ 用 profile 绕过 validation gate
- ❌ 因「没 SessionStart」去开新会话——那是旧 bug，已修

## 细节命令（通常不必手动拼）

- `plan-checks` — 只算不跑
- `run-checks` — 底层检查（deliver 会调）
- `verify` — 不变量 / 漂移（deliver 会调）
