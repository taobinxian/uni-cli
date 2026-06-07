# AI Coding App Workbench

本项目是一个本地 Web 工作台，用来统一查看和操作多种 AI Coding CLI / App 的会话、任务、token 用量和实时输出。默认只监听本机 `127.0.0.1`，适合作为个人电脑上的 agent 控制台。

## 功能概览

- 统一接入 Codex、Claude、Antigravity、Oh My Pi、OpenCode。
- 自动探测各 CLI 的安装路径，也支持通过环境变量显式指定。
- 读取本机历史会话，展示任务状态、工作目录、模型、token 数量和耗时。
- 支持按 App 切换会话，并继续历史会话对话。
- 统一交互控制台：发送 prompt、新建会话、继续会话、停止会话、删除原始 CLI 日志。
- SSE 实时流式输出：agent 思考、输出、工具调用过程中会在页面显示 live 动效。
- 历史消息按页加载，默认只显示最近一屏；可继续向前加载同一 session 的更早消息。
- 支持 markdown、代码块、表格、文件路径、图片预览和图片弹框。
- Token 统计按日 / 周 / 月展示输入、输出、总量，全部使用 token 数量，不使用百分比。
- 高风险操作二次确认：写文件、执行命令、访问网络、发送外部消息、删除文件等。
- 支持亮色 / 暗色模式，左中右布局可拖拽调整，侧边栏可收起。

## 技术栈

- 前端：React + TypeScript + Vite
- 后端：Node.js + TypeScript + Fastify
- 实时通信：SSE
- 数据存储：SQLite
- CLI 控制：child process / PTY 桥接
- 测试：Vitest、Playwright

## 环境要求

- Node.js 20+，推荐使用当前 LTS。
- npm。
- 已登录并可在本机运行你要接入的 CLI，例如 `codex`、`claude`、`agy`、`omp`、`opencode`。

项目会在启动时自动探测常见安装目录，包括 `PATH`、Homebrew、Volta、asdf、mise、nvm/fnm、`~/.local/bin`、`~/.opencode/bin` 等。

## 快速开始

安装依赖：

```bash
npm ci
```

开发模式：

```bash
npm run dev
```

生产构建：

```bash
npm run build
```

前台启动生产服务：

```bash
./scripts/start.sh
# 或
npm run start:local
```

启动后访问：

```text
http://127.0.0.1:8788
```

## 本地部署脚本

项目内置了 3 个脚本，均可通过环境变量覆盖配置。

### 前台启动

```bash
./scripts/start.sh
```

默认会：

- 如果缺少 `node_modules`，执行 `npm ci`
- 执行 `npm run build`
- 使用 `data/workbench.sqlite` 作为数据库
- 前台运行 `npm run start`

常用参数：

```bash
PORT=8790 ./scripts/start.sh
HOST=0.0.0.0 PORT=8788 ./scripts/start.sh
BUILD=0 ./scripts/start.sh
INSTALL=0 ./scripts/start.sh
WORKBENCH_DB=/absolute/path/workbench.sqlite ./scripts/start.sh
```

### 后台部署 / 重启

```bash
./scripts/deploy-local.sh
# 或
npm run deploy:local
```

默认会：

- 安装依赖（如缺少 `node_modules`）
- 重新构建前后端
- 停止上一次由该脚本启动的进程
- 后台启动服务
- 写入 PID 到 `data/workbench.pid`
- 写入日志到 `data/workbench.log`
- 检查 `/api/health`

如果 `127.0.0.1:8788` 已经有一个不是该脚本启动的工作台实例，脚本会停止并提示你先关闭旧进程，或改用其他 `PORT`。

查看日志：

```bash
tail -f data/workbench.log
```

使用自定义端口和数据库：

```bash
PORT=8790 WORKBENCH_DB=/absolute/path/workbench.sqlite ./scripts/deploy-local.sh
```

### 停止后台服务

```bash
./scripts/stop.sh
# 或
npm run stop:local
```

如果你覆盖了 PID 文件位置，停止时也要带同一个变量：

```bash
WORKBENCH_PID_FILE=/absolute/path/workbench.pid ./scripts/stop.sh
```

## CLI 接入配置

自动探测失败时，可以用环境变量显式指定 CLI 路径：

```bash
CODEX_CMD=/opt/homebrew/bin/codex \
CLAUDE_CMD=/opt/homebrew/bin/claude \
ANTIGRAVITY_CMD=/Users/me/.local/bin/agy \
OH_MY_PI_CMD=/opt/homebrew/bin/omp \
OPENCODE_CMD=/Users/me/.opencode/bin/opencode \
./scripts/start.sh
```

支持的主要变量：

| 变量 | 说明 |
| --- | --- |
| `CODEX_CMD` | Codex CLI 路径或命令名 |
| `CLAUDE_CMD` | Claude CLI 路径或命令名 |
| `ANTIGRAVITY_CMD` | Antigravity CLI 路径或命令名，默认尝试 `agy` / `antigravity` |
| `ANTIGRAVITY_LOG_DIR` | Antigravity 历史日志目录 |
| `OH_MY_PI_CMD` | Oh My Pi CLI 路径或命令名，默认尝试 `omp` / `oh-my-pi` / `oh-my-opencode` |
| `OH_MY_PI_SESSION_DIR` | Oh My Pi 会话目录，默认 `~/.omp/agent/sessions` |
| `OPENCODE_CMD` | OpenCode CLI 路径或命令名 |
| `OPENCODE_DB` | OpenCode SQLite 数据库路径，默认 `~/.local/share/opencode/opencode.db` |
| `WORKBENCH_DB` | 工作台自己的 SQLite 数据库路径 |
| `WORKBENCH_PYTHON` | PTY 桥接使用的 Python 命令，默认 `python3` |
| `WORKBENCH_TERM` | PTY 环境变量 `TERM`，默认 `xterm-256color` |
| `WORKBENCH_SSE_HISTORY_INTERVAL_MS` | 轮询历史日志并推送 SSE 的间隔，默认 `900` |
| `WORKBENCH_SSE_TYPE_INTERVAL_MS` | SSE 打字效果 chunk 间隔，默认 `14` |

## 历史数据来源

- Codex：`~/.codex/session_index.jsonl`、`~/.codex/logs_2.sqlite`、`~/.codex/sessions/**/*.jsonl`、`~/.codex/archived_sessions/**/*.jsonl`
- Claude：`~/.claude/transcripts/**/*.jsonl`
- Antigravity：配置的 `ANTIGRAVITY_LOG_DIR` 以及可发现的 app / CLI 日志
- Oh My Pi：默认 `~/.omp/agent/sessions`
- OpenCode：默认 `~/.local/share/opencode/opencode.db`

删除会话时，工作台会尽量删除对应 CLI 的原始日志文件；如果某个 App 使用共享 history 文件，则只移除当前会话记录或标记删除，具体结果会在弹框里显示。

## 页面使用说明

1. 打开 `http://127.0.0.1:8788`。
2. 左侧选择 App：Codex / Claude / Antigravity / Oh My Pi / OpenCode。
3. 在会话列表中选择一个历史会话，或点击“新会话”并选择工作目录。
4. 在底部输入框发送 prompt。
5. Agent 输出会在中间对话区实时流式显示。
6. 对话区顶部可加载更早历史；历史全部加载后可收起回最近 6 条。
7. 右侧面板显示当前会话、文件、事件、确认队列等信息，可收起给中间对话区留空间。

## 常用命令

```bash
npm run dev          # 开发模式
npm run build        # 构建生产包
npm run start        # 启动已构建产物
npm run test         # 单元/集成测试
npm run typecheck    # TypeScript 类型检查
```

脚本命令：

```bash
./scripts/start.sh         # 前台启动
./scripts/deploy-local.sh  # 后台部署或重启
./scripts/stop.sh          # 停止后台服务
npm run start:local        # 同 ./scripts/start.sh
npm run deploy:local       # 同 ./scripts/deploy-local.sh
npm run stop:local         # 同 ./scripts/stop.sh
```

## 安全说明

- 前端不会直接执行 shell，所有 CLI 控制都通过后端 adapter。
- 新建会话必须选择存在且可访问的绝对工作目录。
- 高风险 prompt 会进入二次确认流程。
- 本项目默认只绑定 `127.0.0.1`，如果设置 `HOST=0.0.0.0`，请自行确认网络访问风险。

## 故障排查

CLI 显示未连接：

```bash
which codex
which claude
which agy
which omp
which opencode
```

如果命令不在 PATH 中，使用对应环境变量指定绝对路径。

端口占用：

```bash
PORT=8790 ./scripts/start.sh
```

后台服务日志：

```bash
tail -f data/workbench.log
```

健康检查：

```bash
curl http://127.0.0.1:8788/api/health
```
