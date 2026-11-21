# herdr-context

[English](README.md) | **简体中文**

看清编程 agent 的上下文窗口里装了什么、这些内容从哪来，以及每个订阅还剩多少额度。
目前先做数据层和命令行工具，接下来在此基础上做 [Herdr](https://herdr.dev) mod。

上下文分析目前支持 **Claude Code**（下一步是 Codex，见路线图）。
订阅用量支持 Claude、Codex、Kiro，并可通过 quota-axi 覆盖 Cursor、Copilot 等。

```
claude · 1dea6540 · ~/work/api (main) · claude-opus-5-5 · v2.1.330
  Context   █████░░░░░░░░░░░░░░░░░░░ 200k / 1.00M (20%)
  Trend     ▁▁▁▂▂▂▃▃▃▄▄▄▅▅▅▆▆▆▇▇▇███  41 requests
  Tokens    in 101 · cache read 5.56M · cache write 110k · out 70k (thinking 20k) · cache hit 98%
  Cost      $2.73 (Claude Code's last saved total, all models incl. background)
  Limits    5h 37% (resets in 2h 0m) · 7d 12% (resets in 4d 15h)
  Compacted never
  Makeup    tool definitions 33% · tool results 29% · replies 17% · tool calls 12% · injected 7% · system prompt 2% · your messages 1%  (estimated split)
  Heaviest tool definitions  Artifact 14k · mcp__remote__create_environment 3.6k · …
  Files     10 changed, 0 read — src/claude/session.js ✎7, src/render.js ✎5, …
  Tools     WebSearch 19 · Bash 15 · Edit 13 · Write 11
  Subagents a6428b59 (2 req, peak 6.0k)
```

（命令行输出目前只有英文。）

## 使用方法

需要 Node 18 及以上版本，没有任何依赖。

```sh
node bin/herdr-context.js                 # 最近一个会话
node bin/herdr-context.js --list          # 最近的会话列表
node bin/herdr-context.js --session 1dea  # 按会话 ID 前缀查找
node bin/herdr-context.js --cwd ~/work/api
node bin/herdr-context.js --json          # 给 Herdr mod 或脚本用的 JSON 输出
```

### 上下文窗口大小和订阅额度（推荐配置）

会话日志里没有记录上下文窗口大小，也没有 5 小时和 7 天的额度。
Claude Code 会把这两项数据传给它的 statusLine 命令，所以需要注册我们的采集器
（它不输出任何内容，也不会影响状态栏）：

```json
// ~/.claude/settings.json
{ "statusLine": { "type": "command", "command": "node /path/to/herdr-context/bin/claude-statusline-collector.js" } }
```

如果你已经有自己的状态栏脚本，可以串在后面继续使用：`... claude-statusline-collector.js --then '~/.claude/statusline.sh'`。
采集到的数据保存在 `~/.cache/herdr-context/claude-statusline/<session>.json`。
不配置采集器的话，只显示 token 数量，不显示百分比（也可以用 `HERDR_CONTEXT_WINDOW` 环境变量手动指定窗口大小）。

## 订阅用量：`herdr-context quota`

把本机所有订阅列在一起（`--json` 给 mod 用，`--refresh` 跳过 Kiro 的缓存，`--no-axi` 不调用 quota-axi）：

```
Subscription usage
  claude  5h     ████░░░░░░░░  37% used (resets in 2h 6m)
          week   █████████░░░  72% used ! (resets in 4d 3h)
          via claude-statusline · as of 2026-11-21 14:35Z
  codex   5h     ███░░░░░░░░░  22% used (resets in 3h 30m) [plus]
          week   ███████████░  91% used ‼ (resets in 1d 5h)
          via codex-rollout · as of 2026-11-21 14:35Z
  kiro    month  █████░░░░░░░  41% used (resets in 9d 9h) · 820.5 of 2000 credits [KIRO PRO]
          bonus  █░░░░░░░░░░░  12% used (expires in 19d 23h) · 12 of 100 bonus credits
          via kiro-cli · as of 2026-11-21 14:35Z
  cursor  month  █████░░░░░░░  45% used (resets in 8d 23h) [pro]
          via quota-axi · as of 2026-11-21 14:35Z
```

| 提供方 | 数据来源 | 凭证 / 联网 |
|---|---|---|
| Claude | 采集器保存的 statusLine 数据；取所有会话中当前窗口的最高读数 | 不需要 |
| Codex | `$CODEX_HOME/sessions/**/rollout-*.jsonl[.zst]` 中最后一个带 `rate_limits` 的 `token_count` 事件 | 不需要 |
| Kiro | 运行 `kiro-cli chat --no-interactive "/usage" --v2` 并解析文本输出，缓存 10 分钟 | 使用 kiro-cli 自己的登录 |
| Cursor、Copilot、Grok 等 | 已安装 [`quota-axi`](https://github.com/kunchenguid/quota-axi) 时调用 `quota-axi --json` | 由 quota-axi 读取各 CLI 的登录 |

优先使用本地数据源；本地没有数据时，再用 quota-axi 补上。重置时间已过的窗口不会被当作当前数据显示，而是标记为 `stale`。

Kiro 的注意事项：它没有公开的 API，输出格式一旦变化，解析就会失效；每次查询都会启动一次非交互式对话，kiro-cli 会为此留下一个空会话记录。
解析器是按照 CodexBar 文档里的输出格式编写的，**还没有在真实的 kiro-cli 上验证过**。

## 每个数字从哪里来

| 数据 | 来源 | 可信度 |
|---|---|---|
| 上下文 token 数、趋势 | `~/.claude/projects/*/<session>.jsonl` 中最近一次请求的 `input + cache_read + cache_creation` | 实测 |
| token 总量、缓存命中率 | `message.usage`，**每个 requestId 只计一次**（一次响应在日志里会拆成多条记录） | 实测 |
| 压缩事件 | `system` / `compact_boundary` 记录（`compactMetadata.preTokens`）加上下一次请求的大小 | 实测 |
| 成本 | Claude Code 自己的 `cost-state` 记录（最后一次保存的值，可能略有滞后） | Claude Code 报告 |
| 窗口大小、占用百分比、5 小时 / 7 天额度 | statusLine 数据 | 官方数据，可能缺失 |
| 组成拆分（按类别） | 实测总量，按估算的文本大小拆分（约 4 个字符 1 个 token，中日韩文字 1 个字 1 个 token） | **估算** |
| 系统提示与工具定义 | 有内部 `prompt_snapshot` 记录时据此拆分，否则合并为一个"system+tools"块 | **估算** |
| 文件、工具、子 agent | `tool_use` 块；`<session>/subagents/*.jsonl` | 实测 |

日志格式是 Claude Code 内部使用的，不同版本之间可能变化。遇到未知的记录类型或损坏的行，只计数并显示，不会导致程序出错。
已在 Claude Code 2.1.330 上验证。

## 目录结构

```
src/jsonl-tail.js          增量读取 JSONL，按字节处理，不会截断多字节字符（用于实时轮询）
src/claude/session.js      把日志记录汇总成摘要（纯函数，不读写文件）
src/claude/load.js         单个会话 + 子 agent + statusLine → 快照
src/claude/statusline.js   statusLine 数据的保存、读取和规范化
src/claude/discover.js     查找会话日志
src/quota/                 订阅用量：claude、codex、kiro、quota-axi，以及合并逻辑 index
src/render.js              文本输出
bin/                       命令行工具和 statusLine 采集器
test/                      node --test 测试，使用合成的样本数据
```

运行 `npm test` 执行全部测试。

## 路线图

1. **Codex 上下文分析**：读取 `~/.codex/sessions/**` 里的事件：`token_count`
   （`info.last_token_usage`、`model_context_window`、`rate_limits.primary/secondary`）
   和 `context_compacted`。需要一份真实样本来确认。
2. **Herdr mod**：状态栏小标签（当前窗格的上下文占用百分比）+ 侧边面板；按工作目录或进程把会话对应到窗格。
3. **订阅用量**：已完成（Claude、Codex、Kiro、quota-axi）。下一步：用真实输出验证 Kiro 和 Codex；不依赖 quota-axi 支持 Cursor。
4. Cursor 上下文分析：调研它的 CLI 在本地留下了哪些数据。
