# herdr-context

[English](README.md) | **简体中文**

看清编程 agent 的上下文窗口里装了什么、这些内容从哪来，以及每个订阅还剩多少额度。
目前先做数据层和命令行工具，接下来在此基础上做 [Herdr](https://herdr.dev) mod。

上下文分析支持 **Claude Code**、**Codex** 和 **Antigravity**（`agy`）。
订阅用量支持 Claude、Codex、Antigravity、Kiro，并可通过 quota-axi 覆盖 Cursor、Copilot 等。

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

给 [Herdr 桌面版](https://herdr.dev/app) 用（已在 Herdr 0.1.16 上检查通过）：
**状态栏上的小标签**（`ctx 62% · codex week 81%`：当前窗格的上下文占用，以及用量最高的订阅窗口），
点击它可以打开或收起**右侧边栏里的 Context 面板**，和 Files、Changes 放在一起。
面板显示当前窗格的上下文（占用、趋势、组成、压缩事件、文件）以及每个订阅的用量，会自动刷新。

```sh
git clone https://github.com/TangJc722/herdr-context && cd herdr-context
node bin/install-mod.js                                   # 安装 mod、命令行工具和 main-context 布局
herdr-app check ~/.config/herdr-app/mods/herdr-context    # Herdr 官方检查
```

Herdr 自带的布局是只读的，所以安装脚本会另外生成一个布局 `main-context`：
以你当前 Herdr 版本的 `main` 布局为基础，在状态栏旁边加上小标签，在右侧边栏加入第三个面板 Context。
如果 `herdr-app` 在 PATH 里，安装脚本会自动切换过去；否则按 ctrl-shift-l
（或运行 `herdr-app do layout.switch --name main-context`）切换。你的其他布局不会被改动，用同样的方法可以切回去。
和 Files、Changes 一样，标签栏会按工作区记住 Context 面板是否打开。

更新时重新运行 `install-mod.js`（会根据当前的 `main` 重新生成 `main-context`）；
`--no-layout` 不生成布局；`--uninstall` 会删除 mod 和这个布局。
不使用这个布局时，可以把面板作为窗格打开：
`herdr-app do pane.split --direction right --mod herdr-context`。
支持 Windows：npm 以 `.cmd` 包装文件形式安装的命令（claude、codex、quota-axi）也能被找到，并且不经过 shell 直接启动。
百分比开箱即用（窗口大小来自日志或 Claude Code 自带的模型表）；statusLine 采集器是可选的，见下文。

工作原理：
- mod 不能使用 Node，所以它只负责显示。数据通过 Herdr 的 `exec` 运行打包在一起的命令行工具获取：
  上下文每 15 秒刷新一次（`match --json --panes …`），订阅用量每 2 分钟刷新一次（`quota --json`；点刷新按钮时会加上 `--refresh`）。
- 每个 agent 窗格都对应到它自己的会话（`herdr-context match`），因为同一个文件夹里常常有好几个会话：
  - Claude Code 会把终端标题设为会话标题，同一个标题也会写进日志（`ai-title` / `custom-title` 记录），
    所以标题能对上的窗格就精确对应到那个会话。
  - Codex 的终端标题是"会话名 | 项目名"（会话名最多 48 个字符，项目名是 git 根目录的文件夹名）。
    会话名、文件夹和日志路径取自 Codex 自己的数据库（`$CODEX_HOME/state_<n>.sqlite`，
    通过 Node 自带的 `node:sqlite` 只读打开），并和日志、`session_index.jsonl` 的扫描结果合并；
    Windows 的 `\\?\C:\...` 形式路径会被规范化。
    在上级文件夹里启动的窗格会缩小到项目自己的文件夹（优先于其中的 worktree 或子文件夹）。
    桌面应用 / IDE 或 `codex exec` 创建的会话可能后来在终端里被恢复，所以会按会话名匹配，
    但不会只凭文件夹被选中；子 agent 线程会被跳过。
    Codex 压缩过的旧日志（`.jsonl.zst`）也能找到，即使数据库里记录的还是 `.jsonl`。
  - Antigravity（`agy`）不设置终端标题。正在运行的 agy 会一直打开当前会话的 `presence/<id>.lock`
    （在 Windows 上检测），据此把窗格对应到这个会话（"live"）；否则取 agy 在这个文件夹里最近打开的会话
    （`cache/last_conversations.json`），并标明是推测。
  - 都对不上时：取窗格所在文件夹（或它的上下级文件夹）里最新的、没被别的窗格占用、标题也不属于别的窗口的会话。
    这时面板会提示这个文件夹还有其他会话；用 `/rename` 给会话命名就能精确对应。
    鼠标悬停在卡片上的文件夹名（或"没有会话"的提示）上，可以看到对应的日志文件、匹配方式、
    Herdr 报告的窗格标题，以及每个数据源各找到了多少个会话。
  - 文件夹和标题信息按文件大小缓存（`~/.cache/herdr-context/session-meta.json`），轮询时只读新增的部分。
  焦点在面板本身时，显示这个标签页里最近聚焦过的终端。没有 agent 的窗格不会借用别人的会话，
  而是列出这个工作区里的 Claude Code 和 Codex agent（点击可跳转过去）；工作区里有多个 agent 时也会显示这个列表。
  其他 agent 的窗格会显示暂不支持的说明；还没有成功请求的会话（比如登录过期）也会直接说明。
- 支持英文和简体中文：点面板右上角的 中/EN 按钮切换（保存在 Herdr 的共享状态里，面板和状态栏小标签一起切换，重启后保留）。
  通用的专业名词在两种语言里都保持英文：tokens、cache、agent、System Prompt、ctx。
- Claude 的重置时间（如 "Nov 22, 2:20am (Asia/Shanghai)"）按本地时间解析，和其他提供方一样显示为相对时间（"2 小时 5 分后"）。
- 版面：agent 卡片（占用、进度条、最近 48 次请求的小柱状图），组成拆分（一条叠加色条加图例），最近的文件，
  然后每个有数据的订阅一张卡片；没配置好的提供方合并成一行（悬停查看详情）。
- 运行 `herdr-app check` 时，mod 不会运行命令行工具，而是显示内置的示例数据（面板和小标签都会显示），这样检查能覆盖每个部分。

## 使用方法

需要 Node 18 及以上版本，没有任何依赖。

```sh
node bin/herdr-context.js                 # 最近一个会话
node bin/herdr-context.js --list          # 最近的会话列表（Claude Code 和 Codex）
node bin/herdr-context.js --agent codex   # 只看一种 agent（claude | codex）
node bin/herdr-context.js --session 1dea  # 按会话 ID 前缀查找
node bin/herdr-context.js --cwd ~/work/api
node bin/herdr-context.js --json          # 给 Herdr mod 或脚本用的 JSON 输出
node bin/herdr-context.js match --panes '[{"pane":"p1","agent":"claude","cwd":"/work/api","title":"✳ Fix login"}]'
```

### 上下文窗口大小

百分比 = 上下文 token 数 ÷ 模型的上下文窗口大小。窗口大小的来源：

- **Codex** 直接写在日志里（`model_context_window`）。百分比用的是 Codex 自己的公式：
  分子分母都去掉 12k 的固定提示词（`(tokens − 12k) / (window − 12k)`），所以和 Codex 底栏显示的一致。
- **Claude Code** 的日志里没有，所以按可靠程度依次取：`HERDR_CONTEXT_WINDOW`；statusLine 数据（见下文）；
  出现过超过 200k 的请求（只有 1M 窗口才可能）；否则用 Claude Code 自带的模型表
  （从 Claude Code 程序里读出来的：Opus 4.7 及以后、Sonnet 5 及以后、Haiku 5.5 和 Fable 系列是 1M，更早的是 200k）。
  模型表唯一会判断错的情况：较早的 200k 模型加了 `[1m]` 后缀运行，并且上下文还没超过 200k。配置采集器可以解决这个问题。

### statusLine 采集器（可选）

Claude Code 会把准确的窗口大小、它自己算的百分比以及 5 小时 / 7 天额度传给 statusLine 命令。
注册我们的采集器就能用上这些数据（它不输出任何内容，也不会影响状态栏）：

```json
// ~/.claude/settings.json
{ "statusLine": { "type": "command", "command": "node /path/to/herdr-context/bin/claude-statusline-collector.js" } }
```

如果你已经有自己的状态栏脚本，可以串在后面继续使用：`... claude-statusline-collector.js --then '~/.claude/statusline.sh'`。
采集到的数据保存在 `~/.cache/herdr-context/claude-statusline/<session>.json`。
不配置也完全可以用：窗口大小取自模型表，Claude 的额度通过 `claude -p "/usage"` 获取。

## 订阅用量：`herdr-context quota`

把本机所有订阅列在一起。

```sh
node bin/herdr-context.js quota            # 默认：先用本地数据，再调用 agent 自己的命令
node bin/herdr-context.js quota --refresh  # 忽略缓存，立刻向所有数据源查询
node bin/herdr-context.js quota --passive  # 不启动 claude / codex / agy，只用本地数据
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
  agy     Gemini week     ░░░░░░░░░░░░   3% used (resets in 6d 20h)
          Claude/GPT week ░░░░░░░░░░░░   0% used (resets in 6d 23h)
          via agy /usage · as of 2026-11-21 14:35Z
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
| Antigravity | — | 在一个空目录里运行 `agy -p "/usage" --output-format json`，缓存 10 分钟 | 使用 agy 自己的 Google 登录 |
| Cursor、Copilot、Grok 等 | — | 已安装 [`quota-axi`](https://github.com/kunchenguid/quota-axi) 时调用 `quota-axi --json` | 由 quota-axi 读取各 CLI 的登录 |

某个数据源失败时，会继续尝试下一个，并显示失败原因；上面的数据源都没有数据时，quota-axi 也会补上。
重置时间已过的窗口不会被当作当前数据显示，而是标记为 `stale`。
套餐标签（`[pro]`、`[plus]` 等）：Codex 和 Kiro 随用量数据一起返回；Claude 的从 Claude Code 自己的配置里读取
（`~/.claude.json` 或 `$CLAUDE_CONFIG_DIR` 下同名文件里的 `oauthAccount.organizationType`），这个文件里没有登录凭证。

`claude /usage` 查询使用 `--no-session-persistence --tools "" --strict-mcp-config` 运行，
同时禁用 hook 和 Remote Control，并在一个空目录里执行，所以不会写入会话记录，也不会启动 MCP 服务器。
它的解析器按"每项额度一行"的格式解析（`Current week (all models): 47% used · resets Nov 25, 9am`），
这个格式取自 Claude Code 2.1.330 自身的输出代码；**还没有在真实的 Pro/Max 输出上验证过**。
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

Antigravity：`/usage` 是 agy 自己的命令。在打印模式下它直接在本地返回结果
（不调用模型、不消耗 token、不保存会话），每个模型组（Gemini；Claude 和 GPT）各一个每周额度，以剩余比例表示。
每次大约 10 秒，所以结果会缓存；`--passive` 只显示之前的结果。查询失败时（网络、登录）沿用上一次的结果，并注明原因。
`agy` 不在 PATH 里时（在 agy 安装之前就已启动的程序，比如 Herdr，用的还是旧的 PATH），会去它的安装目录
`%LOCALAPPDATA%\agy\bin` 找。已在 2026 年 11 月的 agy CLI 上验证。不使用 Antigravity 的内部额度接口。

## 每个数字从哪里来

| 数据 | 来源 | 可信度 |
|---|---|---|
| 上下文 token 数、趋势 | `~/.claude/projects/*/<session>.jsonl` 中最近一次请求的 `input + cache_read + cache_creation` | 实测 |
| token 总量、缓存命中率 | `message.usage`，**每个 requestId 只计一次**（一次响应在日志里会拆成多条记录） | 实测 |
| 压缩事件 | `system` / `compact_boundary` 记录（`compactMetadata.preTokens`）加上下一次请求的大小 | 实测 |
| 成本 | Claude Code 自己的 `cost-state` 记录（最后一次保存的值，可能略有滞后） | Claude Code 报告 |
| 窗口大小 | statusLine 数据，否则用 Claude Code 的模型表（见上文） | 官方 / 模型表 |
| 占用百分比（Claude Code 自己算的）、5 小时 / 7 天额度 | statusLine 数据 | 官方数据，可能缺失 |
| 组成拆分（按类别） | 实测总量，按估算的文本大小拆分（约 4 个字符 1 个 token，中日韩文字 1 个字 1 个 token） | **估算** |
| 系统提示与工具定义 | 有内部 `prompt_snapshot` 记录时据此拆分，否则合并为一个"system+tools"块 | **估算** |
| 文件、工具、子 agent | `tool_use` 块；`<session>/subagents/*.jsonl` | 实测 |

日志格式是 Claude Code 内部使用的，不同版本之间可能变化。遇到未知的记录类型或损坏的行，只计数并显示，不会导致程序出错。
已在 Claude Code 2.1.330 上验证。

Codex（`$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]`），依据 codex-rs 源码里的 rollout 和 protocol 类型：

| 数据 | 来源 | 可信度 |
|---|---|---|
| 上下文 token 数、窗口大小、趋势 | `event_msg` / `token_count`：`info.last_token_usage.total_tokens`（Codex 自己就是这样计算窗口占用的）和 `info.model_context_window`；没有新用量的重复事件会被跳过 | 实测 |
| token 总量、缓存命中率 | `info.total_token_usage`（`input_tokens` 已包含 `cached_input_tokens`） | 实测 |
| 压缩事件 | `compacted` 记录；压缩前后的大小取自前后相邻的 `token_count` | 实测 |
| 组成拆分 | 最近一次压缩以来的 `response_item` 消息、工具调用和工具输出，方法和 Claude Code 相同；Codex 自己注入的指令和环境信息算作"注入内容" | **估算** |
| 文件 | `apply_patch`（修改 / 新增），shell 命令里的 `cat`、`sed -n`、`head`、`tail`、`nl`（读取） | 实测，读取是按命令推断的 |

子 agent 线程（`session_meta` 里有 `parent_thread_id`）不会出现在列表里。
还没有用真实的 Codex 日志验证过：如果数字看起来不对，请发一份 `--json` 输出给我们。

Antigravity（`~/.gemini/antigravity-cli`，或 `AGY_DATA_DIR`），已在 2026 年 11 月的 agy CLI 上验证：

| 数据 | 来源 | 可信度 |
|---|---|---|
| 会话列表、文件夹 | `conversation_summaries.db`（SQLite，只读）；子会话不计入 | 实测 |
| token 总量、趋势（备用） | `brain/<id>/.system_generated/logs/transcript.jsonl`：每个模型步骤的 `input_tokens` + `cache_read_tokens` | 实测 |
| 上下文 token 数、窗口大小 | agy 自己的统计，在 `conversations/<id>.db` 的 `gen_metadata` 里（protobuf 字段 1.9.10：token 数和上限，比如 Gemini 3.8 Flash 是 256k）；没有时用最后一次请求的大小，不显示百分比 | 按字段解码，没有公开的结构定义 |
| 组成拆分 | transcript 里的各个步骤（你的消息、回复、`tool_calls`、工具结果），和 Codex 一样按估算的文本大小拆分；第一次请求减去当时已有的对话算作"system + tools"；API 错误步骤不计入 | **估算** |
| 文件、工具 | `tool_calls` 里的工具名；文件取自 `read_file` / `write_file` / `edit_file` 的路径参数 | 实测 |

## 目录结构

```
src/jsonl-tail.js          增量读取 JSONL，按字节处理，不会截断多字节字符（用于实时轮询）
src/claude/session.js      把日志记录汇总成摘要（纯函数，不读写文件）
src/claude/load.js         单个会话 + 子 agent + statusLine → 快照
src/claude/statusline.js   statusLine 数据的保存、读取和规范化
src/claude/discover.js     查找会话日志
src/claude/models.js       每个 Claude 模型的上下文窗口大小（来自 Claude Code 的模型表）
src/codex/                 Codex rollout 日志 → 相同结构的快照
src/agy/                   Antigravity CLI 会话 → 相同结构的快照
src/match.js               把每个 Herdr 窗格对应到它自己的会话（终端标题、正在打开的会话、文件夹）
src/quota/                 订阅用量：claude（statusLine）、claude-cli（/usage）、claude-direct、
                           codex（日志）、codex-rpc（app-server）、kiro、agy（/usage）、quota-axi、index（数据源顺序）
src/herdr-layout.js        根据 Herdr 的 main 布局生成 main-context 布局
src/render.js              文本输出
bin/                       命令行工具、statusLine 采集器、install-mod.js（Herdr mod 安装脚本）
mod/herdr-context/         Herdr mod：main.js（界面）、logic.js（纯逻辑，有测试）、sample.js（检查用的示例数据）
test/                      node --test 测试，使用合成的样本数据和一个模拟的 codex app-server 脚本；
                           main.js 在模拟的 Herdr 模块上实际运行。
                           测试绝不会启动真实的 claude、codex 或 agy。
```

运行 `npm test` 执行全部测试。

## 路线图

1. **Codex 上下文分析**：已完成。下一步：用真实的 rollout 日志确认。
2. **Herdr mod**：状态栏小标签 + 右侧边栏的 Context 面板（main-context 布局）。
   下一步：增量读取日志，避免每次轮询都重新解析整个日志。
3. **订阅用量**：已完成（Claude 的 statusLine / `/usage` / 直连模式，Codex 的日志 / app-server，Antigravity 的 `/usage`，Kiro，quota-axi）。
   下一步：用真实输出验证 Claude `/usage` 文本和 Kiro；不依赖 quota-axi 支持 Cursor。
4. Cursor 上下文分析：调研它的 CLI 在本地留下了哪些数据。
5. **Antigravity 上下文分析**：已完成（token 数、窗口大小、组成拆分、文件、工具、窗格匹配）。
   下一步：遇到新的工具名时补上；识别 shell 命令里的读文件操作。
