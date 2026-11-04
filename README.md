# dsh-subagent-zcode

把一次性（one-shot）任务委派给本机已安装的 **ZCode CLI**。

ZCode 既不在 DeepSeek Harness 内置的子智能体列表里，也不被 Claude Code 原生支持。本仓库提供**两种独立接入方式**，两者共用同一套 ZCode 调用契约，但产物不同：

| 方式 | 宿主 | 产物 | 版本约束 |
|---|---|---|---|
| **DSH 插件** | DeepSeek Harness | npm 包（`lib/` + `cordis.patch.yml`） | 绑定 DSH 运行时（peer 精确钉版） |
| **MCP server** | Claude Code、Cursor 等任意 MCP 客户端 | 单文件 `mcp/server.mjs` | 无，只依赖本机 Node |

> 「版本兼容」一节**只适用于 DSH 插件**。
> 两种方式都**与模型无关**：委派出去的会话使用 ZCode 自己的认证、provider 与模型设置，和宿主侧（DSH / Claude Code）配置的模型没有任何关系。

## 前置条件：ZCode

两种方式都要求本机已安装 ZCode。默认假定标准位置：

```
/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs
/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json
```

**非标准位置**：DSH 版通过 `entryPath` / `providerConfigPath` 配置（见下文）；MCP 版需要改 `mcp/server.mjs` 顶部的 `APP_ROOT` 常量。

---

## 方式一：DSH 插件

安装后注册一个名为 `zcode` 的子智能体提供方，并通过 `@deepseek-ai/dsh-tool-subagent` 暴露工具 `subagent_zcode`。

### 安装

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

### 配置

插件自带 `cordis.patch.yml`，向 profile 插入两条配置：

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

- 默认 `edit`：写工作区文件不需要批准，但不能执行命令；
- `plan` 只分析不写文件；`build` 写入需要批准（无审批人时会失败）；`guarded` 普通调用放行、危险命令需批准；
- `yolo` 跳过权限提示、可执行命令 —— 请自行评估风险后再开启。

### 验证

新开会话后让 Agent 委派一个最小任务：

> 用 subagent_zcode 跑一句「Reply with exactly: OK」，把结果原样告诉我。

成功的委派会先返回 `started subagent <id>`，随后完成通知回到上下文。

---

## 方式二：MCP server

`mcp/server.mjs` 是一个零依赖的 stdio MCP server，只暴露一个工具 `delegate`。适用于任何支持 MCP 的客户端。

### 挂载（Claude Code）

```bash
claude mcp add zcode -- node /path/to/dsh-subagent-zcode/mcp/server.mjs
```

或直接写进 `~/.claude.json`：

```json
{
  "mcpServers": {
    "zcode": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/dsh-subagent-zcode/mcp/server.mjs"]
    }
  }
}
```

模型侧看到的工具名是 `mcp__zcode__delegate`。

### 参数

| 参数 | 必填 | 说明 |
|---|---|---|
| `prompt` | 是 | 完整、自包含的任务描述 —— 子会话看不到当前对话 |
| `cwd` | 否 | 子任务工作目录，默认取 server 进程的 cwd |
| `mode` | 否 | `plan` / `build` / `edit` / `guarded` / `yolo`，默认 `edit` |
| `timeout_ms` | 否 | 整次委派的墙钟上限，默认 `300000` |

返回内容 = 最终答案 + 一行元信息（session / model / tokens / mode）。

### 验证

```bash
printf '%s\n' \
 '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}' \
 '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
 '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
 | node mcp/server.mjs
```

应返回 `serverInfo: {name:"zcode"}` 与 `tools: [{name:"delegate"}]`。

---

## 已知限制（两种方式共有）

- **一次性会话**：不继承父上下文、不支持后续追问、无结构化输出、无递归深度控制。
- **只回传最终文本**：子会话内部的工具调用、stderr、diff 都不会返回，因此无法判断它是"算出来的"还是"跑命令得出来的"。做严格冒烟测试时，建议选一个不可能猜对的题（如"返回当前目录下 .md 文件数量"）。
- 默认路径面向 macOS 的 `/Applications/ZCode.app`，其他位置需显式配置（见上）。
- 依赖 ZCode CLI 的 `--prompt ... --output-format json` 契约；若 ZCode 变更参数或输出格式，解析可能失效。

## 版本兼容（仅 DSH 插件）

`peerDependencies` 精确钉在 `@deepseek-ai/dsh-subagent@0.2.1-rc.5`，与 DSH 运行时的兼容闸一致。

- 用在 0.2.1-rc.5：直接装。
- 用在 0.2.2-alpha 线：会被兼容闸拒绝，需要改 peer 版本后重打包（两套实现 API 有差异，不保证可用）。

**MCP 方式不受此限制**，与 DSH 版本无关。

## License

MIT
