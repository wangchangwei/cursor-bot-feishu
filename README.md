# 飞书 + Cursor CLI 桥接服务

通过飞书机器人远程调用 Cursor AI 助手，实现在手机或其他设备上与 Cursor AI 交互。

## 功能特性

- 📱 通过飞书消息与 Cursor AI 对话
- 🤖 支持代码生成、问答、任务规划等功能
- 🔄 实时流式输出，快速响应
- 🔒 使用飞书企业应用，安全可控

## 系统要求

- Node.js >= 18.0.0
- Cursor IDE（已安装并登录）
- 飞书企业账号（用于创建自建应用）

## 安装步骤

### 1. 安装 Cursor CLI

Cursor CLI 是 Cursor IDE 的命令行工具，需要先安装才能使用本服务。

#### Windows

1. 打开 Cursor IDE
2. 按 `Ctrl+Shift+P` 打开命令面板
3. 输入 `Install 'agent' command` 并执行
4. 验证安装：
   ```powershell
   agent --version
   ```

#### macOS

1. 打开 Cursor IDE
2. 按 `Cmd+Shift+P` 打开命令面板
3. 输入 `Install 'agent' command` 并执行
4. 验证安装：
   ```bash
   agent --version
   ```

#### Linux

1. 打开 Cursor IDE
2. 按 `Ctrl+Shift+P` 打开命令面板
3. 输入 `Install 'agent' command` 并执行
4. 验证安装：
   ```bash
   agent --version
   ```

### 2. 安装 ripgrep（如需要）

Cursor CLI 依赖 ripgrep 进行代码搜索。如果系统中没有安装，需要手动安装。

#### Windows

```powershell
# 使用 winget
winget install BurntSushi.ripgrep.MSVC

# 或使用 scoop
scoop install ripgrep

# 或使用 choco
choco install ripgrep
```

#### macOS

```bash
brew install ripgrep
```

#### Linux (Ubuntu/Debian)

```bash
sudo apt install ripgrep
```

#### Linux (RHEL/CentOS)

```bash
sudo yum install ripgrep
```

验证安装：
```bash
rg --version
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
# Windows: notepad .env
# Linux/macOS: nano .env
```

配置说明：

| 变量 | 必填 | 说明 |
|------|------|------|
| `FEISHU_APP_ID` | ✅ | 飞书应用 App ID |
| `FEISHU_APP_SECRET` | ✅ | 飞书应用 App Secret |
| `CURSOR_WORK_DIR` | ❌ | Cursor 工作目录，默认当前目录 |
| `CURSOR_TIMEOUT` | ❌ | 命令超时时间（毫秒），默认 300000 |
| `RIPGREP_PATH` | ❌ | ripgrep 安装路径，已在 PATH 中则无需配置 |

### 6. 启动服务

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

### 问答模式

只读模式，不执行代码修改：

```
@Cursor AI 助手 /ask 什么是闭包？
```

或使用中文：

```
@Cursor AI 助手 问：如何优化这段代码的性能？
```

### 规划模式

生成任务计划：

```
@Cursor AI 助手 /plan 重构用户认证模块
```

或使用中文：

```
@Cursor AI 助手 规划：实现一个博客系统
```

### 帮助命令

```
@Cursor AI 助手 /help
```

## 常见问题

### Q: 提示 "Could not find ripgrep (rg) binary"

A: 需要安装 ripgrep，参考上方安装步骤。如果已安装但仍报错，请在 `.env` 中配置 `RIPGREP_PATH`。

### Q: 命令执行超时

A: 复杂任务可能需要更长时间，可以增加 `CURSOR_TIMEOUT` 值。

### Q: 飞书消息发送失败

A: 检查以下几点：
1. App ID 和 App Secret 是否正确
2. 应用是否已发布
3. 是否添加了必要的权限

### Q: Cursor CLI 无响应

A: 确保：
1. Cursor IDE 已安装并至少打开过一次
2. 已在 Cursor 中登录账号
3. 已正确安装 agent 命令

## 项目结构

```
cursor-bot/
├── index.js          # 主程序
├── package.json      # 项目配置
├── .env.example      # 环境变量模板
├── .env              # 环境变量（不提交）
└── README.md         # 使用说明
```

## 开发

```bash
# 安装依赖
npm install

# 开发模式运行（自动重启）
npm run dev

# 生产模式运行
npm start
```

## License

MIT
