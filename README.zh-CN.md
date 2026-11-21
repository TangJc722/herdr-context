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

## Herdr mod

一个给 [Herdr 桌面版](https://herdr.dev/app) 用的侧边面板（已在 Herdr 0.1.16 上检查通过）：
显示当前窗格的上下文（占用、趋势、组成、压缩事件、文件），以及每个订阅的用量，会自动刷新。

```sh
git clone https://github.com/TangJc722/herdr-context && cd herdr-context
node bin/install-mod.js                                   # 把 mod 和命令行工具复制到 ~/.config/herdr-app/mods/herdr-context
herdr-app check ~/.config/herdr-app/mods/herdr-context    # Herdr 官方检查
herdr-app do pane.split --direction right --mod herdr-context   # 打开面板
```

Herdr 自带的 `main` 布局是只读的，不会自动加入新的 mod，所以需要把面板作为窗格打开
（用上面的命令，它会随标签页一起保存；也可以用命令面板里的拆分功能），或者像下面的状态栏小标签那样加到复制出来的布局里。
更新时重新运行 `install-mod.js` 即可；`node bin/install-mod.js --uninstall` 可以卸载。
支持 Windows：npm 以 `.cmd` 包装文件形式安装的命令（claude、codex、quota-axi）也能被找到，并且不经过 shell 直接启动。
同时建议配置 statusLine 采集器（安装脚本会打印出完整的配置行），否则面板只显示 token 数量，不显示百分比。

工作原理：
- mod 不能使用 Node，所以它只负责显示。数据通过 Herdr 的 `exec` 运行打包在一起的命令行工具获取：
  上下文每 15 秒刷新一次（`--list --json --recent 48`），订阅用量每 2 分钟刷新一次（`quota --json`；点刷新按钮时会加上 `--refresh`）。
- 窗格和会话按文件夹匹配：取工作目录与当前窗格相同（或包含它、或在它里面）的最新一个 Claude Code 会话。
  上下文目前只支持 Claude Code，其他 agent 的窗格会显示说明。
- 运行 `herdr-app check` 时，mod 不会运行命令行工具，而是显示内置的示例数据，这样检查能覆盖面板的每个部分。

可选的状态栏小标签（`ctx 62% · codex week 81%`）：先复制一份主布局
（`herdr-app do layout.clone '{"name":"main","as":"my-main"}'`），然后在
`layouts/my-main.json` 里把 `status` 区块改成一行，让小标签显示在 Herdr 自带状态栏的旁边：

```json
{ "id": "status", "type": "row", "size": { "px": 28 }, "children": [
  { "id": "status-main", "type": "block", "content": { "mod": "workspace-status" } },
  { "id": "status-context", "type": "block", "size": { "px": 260 }, "content": { "mod": "herdr-context", "props": { "view": "chip" } } }
] }
```

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

把本机所有订阅列在一起。

```sh
node bin/herdr-context.js quota            # 默认：先用本地数据，再调用 agent 自己的命令
node bin/herdr-context.js quota --refresh  # 忽略缓存，立刻向所有数据源查询
node bin/herdr-context.js quota --passive  # 不启动 claude / codex，只用本地数据
node bin/herdr-context.js quota --direct   # Claude：直接使用本地登录凭证（需手动开启，见下文）
node bin/herdr-context.js quota --json     # 给 Herdr mod 用；--no-axi 不调用 quota-axi
```

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

数据源按成本从低到高依次尝试。本地数据在 5 分钟内都算新鲜，直接使用；
否则调用 agent 自己的命令查询（结果会缓存）：

| 提供方 | 1. 本地数据，零成本 | 2. agent 自己的命令 | 凭证 |
|---|---|---|---|
| Claude | 采集器保存的 statusLine 数据（取所有会话中当前窗口的最高读数） | `claude -p "/usage"`，缓存 5 分钟 | Claude Code 使用自己的登录 |
| Codex | `$CODEX_HOME/sessions/**/rollout-*.jsonl[.zst]` 中最后一个带 `rate_limits` 的 `token_count` 事件 | `codex -s read-only -a never app-server` → JSON-RPC `account/rateLimits/read`，缓存 3 分钟 | Codex 使用（并自行续期）自己的登录 |
| Kiro | — | `kiro-cli chat --no-interactive "/usage" --v2`，解析文本输出，缓存 10 分钟 | 使用 kiro-cli 自己的登录 |
| Cursor、Copilot、Grok 等 | — | 已安装 [`quota-axi`](https://github.com/kunchenguid/quota-axi) 时调用 `quota-axi --json` | 由 quota-axi 读取各 CLI 的登录 |

某个数据源失败时，会继续尝试下一个，并显示失败原因；上面的数据源都没有数据时，quota-axi 也会补上。
重置时间已过的窗口不会被当作当前数据显示，而是标记为 `stale`。

`claude /usage` 查询使用 `--no-session-persistence --tools "" --strict-mcp-config` 运行，
同时禁用 hook 和 Remote Control，并在一个空目录里执行，所以不会写入会话记录，也不会启动 MCP 服务器。
它的文本解析器是按照 CodexBar 对输出格式的描述编写的，**还没有在真实的 Pro/Max 输出上验证过**。
Codex app-server 的通信流程已在 Codex CLI 0.171.0 上验证。

### Claude 直连模式（`--direct`，需手动开启）

读取 Claude Code 的 OAuth access token，直接请求 Anthropic 的用量接口
（`GET https://api.anthropic.com/api/oauth/usage`），和 CodexBar、quota-axi 的做法一样：
数据最新，只需一次 HTTP 请求，返回结构化 JSON。也可以用环境变量 `HERDR_CONTEXT_CLAUDE_DIRECT=1` 开启。

- token 来源依次为：`CLAUDE_CODE_OAUTH_TOKEN`、`~/.claude/.credentials.json`
  （或 `$CLAUDE_CONFIG_DIR` 下的同名文件）、macOS 钥匙串中的 `Claude Code-credentials`（macOS 可能会弹一次授权）。
- **只读**：绝不改写或移动 Claude Code 的凭证。
- **绝不刷新 token**：token 过期时只报告过期，改用其他数据源，让 Claude Code 自己续期登录。
  如果在这里刷新，可能会让 Claude Code 手里的 refresh token 失效，导致它被登出。
- token 只发送给 `api.anthropic.com`，不会打印，也不会缓存；只缓存用量数字（2 分钟）。
- 这个接口没有公开文档，随时可能变化。

Codex 不需要直连模式：它的 app-server 本来就是用 Codex 自己的登录来查询的。

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
src/quota/                 订阅用量：claude（statusLine）、claude-cli（/usage）、claude-direct、
                           codex（日志）、codex-rpc（app-server）、kiro、quota-axi、index（数据源顺序）
src/render.js              文本输出
bin/                       命令行工具、statusLine 采集器、install-mod.js（Herdr mod 安装脚本）
mod/herdr-context/         Herdr mod：main.js（界面）、logic.js（纯逻辑，有测试）、sample.js（检查用的示例数据）
test/                      node --test 测试，使用合成的样本数据和一个模拟的 codex app-server 脚本；
                           main.js 在模拟的 Herdr 模块上实际运行。
                           测试绝不会启动真实的 claude 或 codex。
```

运行 `npm test` 执行全部测试。

## 路线图

1. **Codex 上下文分析**：读取 `~/.codex/sessions/**` 里的事件：`token_count`
   （`info.last_token_usage`、`model_context_window`、`rate_limits.primary/secondary`）
   和 `context_compacted`。需要一份真实样本来确认。
2. **Herdr mod**：侧边面板和状态栏小标签已完成（按文件夹匹配）。下一步：在真实窗口里试用；
   面板支持 Codex 上下文；增量读取日志，避免每次轮询都重新解析整个日志。
3. **订阅用量**：已完成（Claude 的 statusLine / `/usage` / 直连模式，Codex 的日志 / app-server，Kiro，quota-axi）。
   下一步：用真实输出验证 Claude `/usage` 文本和 Kiro；不依赖 quota-axi 支持 Cursor。
4. Cursor 上下文分析：调研它的 CLI 在本地留下了哪些数据。
