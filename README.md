# 飞书 + Cursor CLI 桥接服务

通过飞书机器人远程调用 Cursor AI 助手，实现在手机或其他设备上与 Cursor AI 交互。

## 功能特性

- 📱 通过飞书消息与 Cursor AI 对话
- 🤖 支持代码生成、问答、任务规划等功能
- 📂 **文件发送** - Cursor 生成文件后可自动发送到飞书
- 🔄 实时流式输出，快速响应
- 💬 多轮对话支持，保持上下文
- 📸 远程截图，随时查看服务器屏幕
- ⏹️ 任务控制，支持终止正在执行的任务
- 📋 日志查看，远程查看服务运行日志

## 系统架构

```
飞书消息 → index.js (WebSocket + API :3456)
              ↓
         Cursor CLI (agent --approve-mcps)
              ↓
         MCP Server (send_file_to_feishu)
              ↓
         文件发送到飞书 ✅
```

## 系统要求

- Node.js >= 18.0.0
- Cursor CLI（agent 命令）
- 飞书企业账号（用于创建自建应用）

## 安装步骤

### 1. 安装 Cursor CLI

Cursor CLI 是 Cursor 的命令行工具，独立于 Cursor IDE。

#### 方式一：通过 Cursor IDE 安装

1. 打开 Cursor IDE
2. 按 `Cmd+Shift+P` (macOS) 或 `Ctrl+Shift+P` (Windows/Linux)
3. 输入 `Install 'agent' command` 并执行

#### 方式二：独立安装

```bash
# macOS/Linux
curl -fsSL https://cursor.sh/install-agent.sh | bash

# 验证安装
agent --version
```

### 2. 安装 ripgrep（如需要）

Cursor CLI 依赖 ripgrep 进行代码搜索。

```bash
# macOS
brew install ripgrep

# Ubuntu/Debian
sudo apt install ripgrep

# Windows
winget install BurntSushi.ripgrep.MSVC
```

### 3. 创建飞书企业自建应用

1. 访问 [飞书开放平台](https://open.feishu.cn/app)
2. 点击「创建企业自建应用」
3. 填写应用名称（如：Cursor AI 助手）
4. 记录 `App ID` 和 `App Secret`

#### 配置应用权限

进入应用设置 → 权限管理 → API 权限，添加以下权限：

- `im:message` - 获取与发送单聊、群组消息
- `im:message.group_at_msg` - 接收群聊中 @ 机器人消息事件
- `im:message.p2p_msg` - 接收用户发给机器人的单聊消息
- `im:chat:readonly` - 获取群组信息
- `im:resource` - 上传图片/文件资源

#### 配置事件订阅

进入应用设置 → 事件与回调：

1. 选择「使用长连接接收事件」（推荐）
2. 添加事件：`im.message.receive_v1`（接收消息）

#### 发布应用

1. 进入「版本管理与发布」
2. 创建版本并提交审核
3. 审核通过后发布应用

### 4. 安装项目依赖

```bash
# 克隆项目
git clone http://10.10.10.217/tools/cursor-bot.git
cd cursor-bot

# 安装依赖
npm install
```

### 5. 配置环境变量

```bash
# 复制配置文件模板
cp .env.example .env

# 编辑配置文件
nano .env  # 或使用其他编辑器
```

配置说明：

| 变量 | 必填 | 说明 |
|------|------|------|
| `FEISHU_APP_ID` | ✅ | 飞书应用 App ID |
| `FEISHU_APP_SECRET` | ✅ | 飞书应用 App Secret |
| `CURSOR_WORK_DIR` | ❌ | Cursor 工作目录，默认当前目录 |
| `CURSOR_TIMEOUT` | ❌ | 命令超时时间（毫秒），默认 300000 |
| `API_PORT` | ❌ | 本地 API 端口，默认 3456 |
| `RIPGREP_PATH` | ❌ | ripgrep 安装路径 |

### 6. 配置 MCP Server（文件发送功能）

将飞书文件发送 MCP 添加到 Cursor CLI 配置：

```bash
# 查看当前 MCP 配置
agent mcp list

# 启用飞书文件发送 MCP
agent mcp enable feishu-file-sender
```

或手动编辑 `~/.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "feishu-file-sender": {
      "command": "node",
      "args": ["/path/to/cursor-bot-feishu/mcp-server.js"],
      "env": {
        "FEISHU_API_PORT": "3456",
        "FEISHU_API_HOST": "http://localhost"
      }
    }
  }
}
```

验证 MCP 工具：

```bash
agent mcp list-tools feishu-file-sender
# 输出:
# - send_file_to_feishu (file_path, message)
# - list_files (directory, pattern)
```

### 7. 启动服务

#### 方式一：后台运行（推荐）

```bash
# 启动服务（后台运行）
./service.sh start

# 查看状态
./service.sh status

# 查看日志
./service.sh logs

# 重启服务
./service.sh restart

# 停止服务
./service.sh stop
```

#### 方式二：前台运行

```bash
# 启动服务
npm start

# 或开发模式（自动重启）
npm run dev
```

启动成功后会显示：

```
========================================
🚀 飞书 + Cursor CLI 桥接服务启动中...
========================================
📡 API 服务已启动: http://localhost:3456
✅ WebSocket 长连接已建立
📱 现在可以在飞书中 @机器人 发送消息了
```

## 使用方法

在飞书中 @机器人 或私聊机器人发送消息：

### 基本用法

直接发送消息，AI 将执行代码任务：

```
@Cursor AI 助手 帮我写一个 Python 快速排序算法
```

### 文件发送（核心功能）

让 AI 生成文件并自动发送到飞书：

```
@Cursor AI 助手 帮我生成一个 Python 脚本，然后发送给我
@Cursor AI 助手 画一张流程图并发送到飞书
@Cursor AI 助手 写个 HTML 页面，完成后发我
```

**触发关键词**：消息中包含 `发送`、`发给我`、`给我`、`发我`、`传给我`、`send`、`发到飞书` 时，新生成的文件会自动发送。

### 问答模式

只读模式，不执行代码修改：

```
@Cursor AI 助手 /ask 什么是闭包？
@Cursor AI 助手 问：如何优化这段代码的性能？
```

### 规划模式

生成任务计划：

```
@Cursor AI 助手 /plan 重构用户认证模块
@Cursor AI 助手 规划：实现一个博客系统
```

### 会话管理

支持多轮对话，保持上下文：

```
@Cursor AI 助手 /new      # 开始新会话
@Cursor AI 助手 /session  # 查看会话状态
```

### 文件操作命令

```
@Cursor AI 助手 /ls              # 列出工作目录文件
@Cursor AI 助手 /ls .py          # 搜索 Python 文件
@Cursor AI 助手 /file src/app.js # 手动发送指定文件
```

### 控制命令

```
@Cursor AI 助手 /stop       # 终止当前任务
@Cursor AI 助手 /screenshot # 截取屏幕
@Cursor AI 助手 /log        # 查看最近 10 行日志
@Cursor AI 助手 /log 50     # 查看最近 50 行日志
@Cursor AI 助手 /help       # 显示帮助
```

## MCP 工具说明

本项目提供的 MCP 工具：

| 工具 | 参数 | 说明 |
|------|------|------|
| `send_file_to_feishu` | `file_path`, `message` | 发送文件到飞书聊天 |
| `list_files` | `directory`, `pattern` | 列出目录下的文件 |
| `record_audio` | `duration`, `output_path` | 使用麦克风录制音频 |
| `list_audio_devices` | - | 列出系统音频输入设备 |

Cursor CLI 会根据用户需求自动调用这些工具。

### 录音功能

支持远程录音，自动检测物理麦克风设备：

```
@Cursor AI 助手 录音 10 秒，然后发送给我
@Cursor AI 助手 帮我录一段 30 秒的音频
```

**特性**：
- 自动识别物理麦克风（如 Razer、Blue Yeti、Shure 等）
- 排除虚拟音频设备（Steam、WeMeet、Lark 等）
- 录音完成后可自动发送到飞书

## 项目结构

```
cursor-bot-feishu/
├── index.js              # 主程序（飞书 WebSocket + API 服务）
├── mcp-server.js         # MCP Server（提供文件发送工具）
├── package.json          # 项目配置
├── .env.example          # 环境变量模板
├── .env                  # 环境变量（不提交）
├── service.sh            # 服务管理脚本（启动/停止/重启）
├── cursor-bridge.log     # 运行日志（自动生成）
└── README.md             # 使用说明
```

## 常见问题

### Q: 提示 "Could not find ripgrep (rg) binary"

A: 需要安装 ripgrep，参考上方安装步骤。如果已安装但仍报错，请在 `.env` 中配置 `RIPGREP_PATH`。

### Q: 文件发送失败

A: 检查以下几点：
1. API 服务是否启动（端口 3456）
2. MCP Server 是否启用：`agent mcp list`
3. 文件大小是否超过 30MB

### Q: MCP 工具不可用

A: 执行以下命令：
```bash
agent mcp enable feishu-file-sender
agent mcp list-tools feishu-file-sender
```

### Q: 命令执行超时

A: 复杂任务可能需要更长时间，可以增加 `CURSOR_TIMEOUT` 值。

### Q: 飞书消息发送失败

A: 检查以下几点：
1. App ID 和 App Secret 是否正确
2. 应用是否已发布
3. 是否添加了必要的权限

### Q: 为什么不支持 Docker 部署

A: 本服务的核心功能是通过 `spawn('agent', ...)` 调用宿主机上的 Cursor CLI，Docker 容器无法实现这一点：

1. **Cursor CLI 是本地桌面工具** — `agent` 命令依赖宿主机的 Cursor 登录态和配置，无法在容器内安装和使用
2. **进程隔离** — Docker 容器无法直接 spawn 宿主机上的二进制程序
3. **工作目录不互通** — Cursor CLI 需要访问宿主机的项目文件，容器内的文件系统与宿主机隔离
4. **MCP Server 依赖宿主机** — `mcp-server.js` 需要被宿主机上的 Cursor CLI 通过 stdio 调用，跨容器无法实现

虽然理论上可以通过 HTTP 代理中转来间接调用，但会增加不必要的复杂度和延迟。请直接在本地运行。

## 开发

```bash
# 安装依赖
npm install

# 开发模式运行（自动重启）
npm run dev

# 生产模式运行
npm start

# 单独运行 MCP Server（调试用）
npm run mcp
```

## API 接口

本地 API 服务（默认端口 3456）：

| 接口 | 方法 | 说明 |
|------|------|------|
| `/send-file` | POST | 发送文件到飞书 |
| `/health` | GET | 健康检查 |

**发送文件示例**：

```bash
curl -X POST "http://localhost:3456/send-file" \
  -H "Content-Type: application/json" \
  -d '{"file_path": "output/result.png"}'
```

## License

MIT
