# dsh-subagent-zcode

把一次性（one-shot）任务委派给本机已安装的 **ZCode CLI**，用法与内置的 Codex / Claude Code 子智能体提供方一致。

它不是新的 Agent，而是一个**提供方（provider）+ 工具（tool）**的组合：

- `dsh-subagent-zcode` 注册一个名为 `zcode` 的子智能体提供方；
- 配套的 `@deepseek-ai/dsh-tool-subagent` 暴露工具 `subagent_zcode` 给模型调用；
- 每次调用启动一个 ZCode 原生会话执行任务，结束后只把最终文本交回父 Session。

## 前置条件

| 项 | 要求 |
|---|---|
| DeepSeek Harness | **0.2.1-rc.5**（`peerDependencies` 精确钉版，见下方「版本兼容」） |
| ZCode | 已安装，且 `zcode.cjs` 与 `zcode-builtin.json` 可访问 |
| 平台 | 默认路径面向 macOS（`/Applications/ZCode.app`），其他平台需显式配置 `entryPath` |

默认假定 ZCode 安装在标准位置：

```
/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs
/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json
```

## 安装

```bash
dsh plugin --profile <your-profile> add "git+https://github.com/HaikeThreat/dsh-subagent-zcode.git"
```

例如桌面版：

```bash
dsh plugin --profile desktop add "git+https://github.com/HaikeThreat/dsh-subagent-zcode.git"
```

本地开发时可改用链接方式，改代码即时生效：

```bash
dsh plugin --profile desktop add "link:/path/to/dsh-subagent-zcode"
```

装完**必须新开一个会话**——工具在会话启动时绑定，旧会话不会出现 `subagent_zcode`。

## 配置

插件自带一份 `cordis.patch.yml`，会向 profile 插入两条配置：

```yaml
- insert:
    - id: subagent-zcode
      name: 'dsh-subagent-zcode'
      config:
        providerName: zcode
        mode: edit
    - id: tool-subagent-zcode
      name: '@deepseek-ai/dsh-tool-subagent'
      config:
        provider: zcode
        toolName: subagent_zcode
        maxDepth: provider-managed
```

可在你自己 profile 的 `cordis.patch.yml` 里按 `id` 覆盖：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `providerName` | `zcode` | 注册到子智能体服务的名字 |
| `entryPath` | `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs` | ZCode CLI 入口脚本 |
| `nodePath` | 当前进程的 `process.execPath` | 运行入口脚本使用的 Node |
| `providerConfigPath` | `/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json` | ZCode 自带 provider 目录，缺失则 CLI 无法开会话 |
| `mode` | `edit` | 权限模式：`plan` / `build` / `edit` / `guarded` / `yolo` |
| `env` | `{}` | 显式环境变量覆盖（在凭据清理之后应用） |
| `disposeGraceMs` | `5000` | 进程回收的宽限时间 |

### 关于 `mode`

ZCode 在省略 `--mode` 时会**默认回退到 `yolo`**（自动批准一切）。本插件始终显式传 `mode`，就是为了避免这个隐式回退。

- 分享/默认场景建议 `edit`：改动文件时逐步确认；
- `yolo` 会让 ZCode 全自动执行、不做任何审批，请自行评估风险后再开启。

### 非标准安装位置

如果 ZCode 不在 `/Applications`，在 profile 补丁里覆盖两个路径即可：

```yaml
- id: subagent-zcode
  name: 'dsh-subagent-zcode'
  config:
    entryPath: /你的路径/zcode.cjs
    providerConfigPath: /你的路径/zcode-builtin.json
```

路径缺失时委派会直接返回明确错误（提示哪个字段、哪个路径不存在），而不是静默失败。

## 验证

新开会话后，让 Agent 委派一个最小任务：

> 用 subagent_zcode 跑一句「Reply with exactly: OK」，把结果原样告诉我。

返回 `OK` 即链路打通。成功的委派会先返回 `started subagent <id>`，随后完成通知回到上下文。

## 已知限制

- **仅 macOS 标准路径开箱可用**，其他情况需配置 `entryPath`。
- 一次性会话：不继承父上下文、不支持后续追问、无结构化输出、无递归深度控制（`maxDepth: provider-managed`）。
- 不创建 DSH 子 Session，父 Session 只保留任务标识与最终结果。
- 依赖 ZCode CLI 的 `--prompt ... --output-format json` 契约；若 ZCode 变更参数或输出格式，解析可能失效。

## 版本兼容

`peerDependencies` 精确钉在 `@deepseek-ai/dsh-subagent@0.2.1-rc.5`，与 DSH 运行时的兼容闸一致。

- 用在 0.2.1-rc.5：直接装。
- 用在 0.2.2-alpha 线：会被兼容闸拒绝，需要改 peer 版本后重打包（两套实现 API 有差异，不保证可用）。

## License

MIT
