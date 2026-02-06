/**
 * 飞书机器人 + Cursor CLI 桥接服务
 * 
 * 功能：接收飞书消息，调用 Cursor CLI 处理，返回结果
 * 
 * @author Cursor AI Assistant
 * @version 1.0.0
 */

import { config as dotenvConfig } from 'dotenv';
import * as lark from '@larksuiteoapi/node-sdk';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import screenshot from 'screenshot-desktop';

// 从脚本所在目录加载 .env（确保 launchd 等场景下也能正确读取）
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenvConfig({ path: path.join(__dirname, '.env') });

// ========== 配置 ==========
const config = {
  // 飞书应用凭证（从环境变量读取）
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
  
  // Cursor CLI 工作目录（可选，默认当前目录）
  workDir: process.env.CURSOR_WORK_DIR || process.cwd(),
  
  // 命令超时时间（毫秒），默认 20 分钟
  timeout: parseInt(process.env.CURSOR_TIMEOUT) || 1200000,
  
  // ripgrep 路径（可选，如果已在系统 PATH 中则无需配置）
  ripgrepPath: process.env.RIPGREP_PATH || '',
  
  // 本地 API 服务端口（供 Cursor CLI 调用）
  apiPort: parseInt(process.env.API_PORT) || 3456,
};

// 验证必要配置
if (!config.appId || !config.appSecret) {
  console.error('❌ 错误：请在 .env 文件中配置 FEISHU_APP_ID 和 FEISHU_APP_SECRET');
  process.exit(1);
}

// 如果配置了 ripgrep 路径，添加到 PATH
if (config.ripgrepPath) {
  process.env.PATH = `${config.ripgrepPath};${process.env.PATH}`;
}

// ========== 服务启动时间 ==========
// 用于过滤历史消息，只处理服务启动后的消息
const SERVICE_START_TIME = Date.now();

// ========== 日志文件配置 ==========
const LOG_FILE = path.join(config.workDir, 'cursor-bridge.log');

// 重写 console.log 和 console.error，同时写入文件
const originalLog = console.log;
const originalError = console.error;

function writeLog(level, ...args) {
  const timestamp = new Date().toLocaleString();
  const message = args.map(arg => 
    typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
  ).join(' ');
  const logLine = `[${timestamp}] [${level}] ${message}\n`;
  
  try {
    fs.appendFileSync(LOG_FILE, logLine);
  } catch (e) {
    // 忽略写入错误
  }
}

console.log = (...args) => {
  originalLog(...args);
  writeLog('INFO', ...args);
};

console.error = (...args) => {
  originalError(...args);
  writeLog('ERROR', ...args);
};

// ========== 消息去重缓存 ==========
// 用于防止飞书消息重试导致的重复处理
const processedMessages = new Set();
const MESSAGE_CACHE_TTL = 5 * 60 * 1000; // 缓存 5 分钟

// ========== 活跃任务管理 ==========
// 用于跟踪和管理当前正在执行的任务，支持 stop 命令
const activeTasks = new Map(); // chatId -> { child, prompt, startTime }

// ========== 当前活跃的 chatId ==========
// 用于 HTTP API 接口知道文件发送给哪个聊天
let currentActiveChatId = null;

// ========== 会话管理 ==========
// 用于保持多轮对话的上下文
const chatSessions = new Map(); // chatId -> { conversationId, lastActiveTime }
const SESSION_TTL = 10 * 60 * 60 * 1000; // 会话超时时间：10 小时

// 获取或创建会话
function getSession(chatId) {
  const session = chatSessions.get(chatId);
  if (session) {
    // 检查是否超时
    if (Date.now() - session.lastActiveTime > SESSION_TTL) {
      console.log(`[会话] 会话超时，清除: ${chatId}`);
      chatSessions.delete(chatId);
      return null;
    }
    // 更新活跃时间
    session.lastActiveTime = Date.now();
    return session;
  }
  return null;
}

// 保存会话
function saveSession(chatId, conversationId) {
  chatSessions.set(chatId, {
    conversationId,
    lastActiveTime: Date.now(),
  });
  console.log(`[会话] 保存会话: chatId=${chatId}, conversationId=${conversationId}`);
}

// 清除会话
function clearSession(chatId) {
  const session = chatSessions.get(chatId);
  if (session) {
    chatSessions.delete(chatId);
    console.log(`[会话] 清除会话: ${chatId}`);
    return true;
  }
  return false;
}

// 定期清理过期会话
setInterval(() => {
  const now = Date.now();
  for (const [chatId, session] of chatSessions.entries()) {
    if (now - session.lastActiveTime > SESSION_TTL) {
      chatSessions.delete(chatId);
      console.log(`[会话] 自动清理过期会话: ${chatId}`);
    }
  }
}, 5 * 60 * 1000); // 每 5 分钟检查一次

function isMessageProcessed(messageId) {
  if (processedMessages.has(messageId)) {
    console.log(`[去重] 消息已处理过，跳过: ${messageId}`);
    return true;
  }
  processedMessages.add(messageId);
  
  // 定时清理过期的消息 ID
  setTimeout(() => {
    processedMessages.delete(messageId);
  }, MESSAGE_CACHE_TTL);
  
  return false;
}

// ========== 初始化飞书客户端 ==========
const client = new lark.Client({
  appId: config.appId,
  appSecret: config.appSecret,
  disableTokenCache: false,
});

// ========== 调用 Cursor CLI（支持流式回调） ==========
async function callCursorCLI(prompt, mode = 'agent', chatId = null, onStream = null) {
  console.log(`[Cursor CLI] 执行任务: ${prompt.substring(0, 50)}...`);
  console.log(`[Cursor CLI] 模式: ${mode}`);
  console.log(`[Cursor CLI] 工作目录: ${config.workDir}`);
  
  // 获取现有会话（如果有）
  const existingSession = chatId ? getSession(chatId) : null;
  const conversationId = existingSession?.conversationId;
  
  // 构建命令参数
  const args = ['-p', '--force', '--output-format', 'stream-json', '--stream-partial-output', '--approve-mcps'];
  
  // 如果有现有会话，使用 --resume 参数继续对话
  if (conversationId) {
    args.push('--resume', conversationId);
    console.log(`[Cursor CLI] 继续会话: ${conversationId}`);
  } else {
    console.log(`[Cursor CLI] 开始新会话`);
  }
  
  console.log(`[Cursor CLI] 命令: agent ${args.join(' ')}`);
  
  // 清除可能导致问题的环境变量
  const cleanEnv = { ...process.env };
  delete cleanEnv.CURSOR_CLI;
  delete cleanEnv.CURSOR_AGENT;
  
  return new Promise((resolve, reject) => {
    const child = spawn('agent', args, {
      cwd: config.workDir,
      env: cleanEnv,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    
    // 注册活跃任务（用于 stop 命令）
    if (chatId) {
      activeTasks.set(chatId, {
        child,
        prompt: prompt.substring(0, 50),
        startTime: Date.now(),
      });
    }
    
    // 清理任务的辅助函数
    const cleanupTask = () => {
      if (chatId) {
        activeTasks.delete(chatId);
      }
    };
    
    let result = '';
    let accumulatedText = ''; // 累积所有流式 delta 片段
    let newConversationId = null;
    let wasKilled = false;
    
    // 流式更新节流：最快 1.5 秒更新一次卡片
    let lastStreamTime = 0;
    let streamTimer = null;
    let streamUpdatePromise = Promise.resolve(); // 确保更新按顺序执行
    const STREAM_INTERVAL = 1500;
    
    const flushStream = (text) => {
      if (onStream && text) {
        // 链式执行，确保上一次更新完成后再发下一次
        streamUpdatePromise = streamUpdatePromise
          .then(() => onStream(text))
          .catch(() => {}); // 忽略更新失败
        lastStreamTime = Date.now();
      }
    };
    
    const throttledStream = (text) => {
      if (!onStream || !text) return;
      const now = Date.now();
      // 清除上一个定时器
      if (streamTimer) clearTimeout(streamTimer);
      if (now - lastStreamTime >= STREAM_INTERVAL) {
        // 距离上次更新已超过间隔，立即更新
        flushStream(text);
      } else {
        // 还没到间隔，延迟更新（确保最后一次内容也能送达）
        streamTimer = setTimeout(() => flushStream(text), STREAM_INTERVAL - (now - lastStreamTime));
      }
    };
    
    child.stdout.on('data', (data) => {
      const text = data.toString();
      console.log(`[Cursor CLI 输出] ${text.substring(0, 200)}`);
      
      // 解析每一行 JSON
      const lines = text.split('\n').filter(line => line.trim());
      for (const line of lines) {
        try {
          const json = JSON.parse(line);
          
          // 获取会话 ID（用于后续 --resume）
          if (json.conversation_id) {
            newConversationId = json.conversation_id;
            console.log(`[Cursor CLI] 获取到会话ID: ${newConversationId}`);
          }
          
          // 备用：从其他字段获取会话 ID
          if (!newConversationId && json.session_id) {
            newConversationId = json.session_id;
          }
          
          // 获取最终结果
          if (json.type === 'result' && json.result) {
            result = json.result;
            console.log(`[Cursor CLI] 获取到结果: ${result.substring(0, 100)}...`);
          }
          
          // 获取助手消息 + 触发流式回调
          if (json.type === 'assistant' && json.message?.content?.[0]?.text) {
            const chunkText = json.message.content[0].text;
            if (json.timestamp_ms) {
              // 有 timestamp_ms 的是增量 delta 片段，需要累加
              accumulatedText += chunkText;
            } else {
              // 没有 timestamp_ms 的是最终完整文本，直接使用
              accumulatedText = chunkText;
            }
            throttledStream(accumulatedText);
          }
        } catch (e) {
          // 忽略非 JSON 行
        }
      }
    });
    
    child.stderr.on('data', (data) => {
      console.log(`[Cursor CLI 错误] ${data.toString()}`);
    });
    
    child.on('close', async (code) => {
      console.log(`[Cursor CLI] 退出码: ${code}`);
      cleanupTask();
      if (streamTimer) clearTimeout(streamTimer);
      
      // 等待所有流式更新完成，避免和最终更新竞争
      try { await streamUpdatePromise; } catch(e) {}
      
      // 如果是被用户手动终止的
      if (wasKilled) {
        reject(new Error('STOPPED_BY_USER'));
        return;
      }
      
      // 保存会话 ID（用于后续继续对话）
      if (chatId && newConversationId) {
        saveSession(chatId, newConversationId);
      }
      
      // 优先使用 result，否则使用累积的文本
      const finalResult = result || accumulatedText;
      
      if (finalResult) {
        resolve(finalResult);
      } else if (code === 0) {
        resolve('任务完成');
      } else {
        reject(new Error(`命令退出码: ${code}`));
      }
    });
    
    child.on('error', (err) => {
      console.log(`[Cursor CLI] 错误: ${err.message}`);
      cleanupTask();
      if (streamTimer) clearTimeout(streamTimer);
      reject(err);
    });
    
    // 标记进程可被外部终止
    child.markAsKilled = () => {
      wasKilled = true;
    };
    
    // 通过 stdin 发送提示词
    child.stdin.write(prompt);
    child.stdin.end();
    
    // 超时处理
    setTimeout(() => {
      if (!child.killed) {
        child.kill();
        cleanupTask();
        reject(new Error('命令执行超时（20分钟）'));
      }
    }, config.timeout);
  });
}

// ========== 读取日志文件 ==========
function readLogFile(lines = 10) {
  try {
    if (!fs.existsSync(LOG_FILE)) {
      return '日志文件不存在';
    }
    
    const content = fs.readFileSync(LOG_FILE, 'utf-8');
    const allLines = content.split('\n').filter(line => line.trim());
    
    // 获取最后 N 行
    const lastLines = allLines.slice(-lines);
    
    if (lastLines.length === 0) {
      return '日志为空';
    }
    
    return `📋 最近 ${lastLines.length} 行日志：\n\n${lastLines.join('\n')}`;
  } catch (error) {
    return `读取日志失败：${error.message}`;
  }
}

// ========== 停止当前任务 ==========
function stopTask(chatId) {
  const task = activeTasks.get(chatId);
  if (task) {
    console.log(`[Stop] 终止任务: ${task.prompt}...`);
    task.child.markAsKilled?.();
    task.child.kill('SIGTERM');
    
    // 如果 SIGTERM 不起作用，强制 SIGKILL
    setTimeout(() => {
      if (!task.child.killed) {
        task.child.kill('SIGKILL');
      }
    }, 1000);
    
    activeTasks.delete(chatId);
    const duration = Math.round((Date.now() - task.startTime) / 1000);
    return { stopped: true, prompt: task.prompt, duration };
  }
  return { stopped: false };
}

// ========== 解析用户消息 ==========
function parseMessage(text) {
  // 移除 @ 机器人的部分
  const cleanText = text.replace(/@[\w\u4e00-\u9fa5]+/g, '').trim();
  
  // 检测模式关键词
  let mode = 'agent';
  let prompt = cleanText;
  
  if (cleanText.startsWith('/ask ') || cleanText.startsWith('问：') || cleanText.startsWith('问:')) {
    mode = 'ask';
    prompt = cleanText.replace(/^(\/ask\s+|问[：:]\s*)/, '');
  } else if (cleanText.startsWith('/plan ') || cleanText.startsWith('规划：') || cleanText.startsWith('规划:')) {
    mode = 'plan';
    prompt = cleanText.replace(/^(\/plan\s+|规划[：:]\s*)/, '');
  }
  
  return { mode, prompt };
}

// ========== 发送飞书消息 ==========
async function sendMessage(chatId, content, msgType = 'text') {
  try {
    // 截断过长的消息（飞书限制）
    const maxLength = 30000;
    let finalContent = content;
    if (content.length > maxLength) {
      finalContent = content.substring(0, maxLength) + '\n\n... (内容过长，已截断)';
    }
    
    await client.im.message.create({
      params: {
        receive_id_type: 'chat_id',
      },
      data: {
        receive_id: chatId,
        msg_type: msgType,
        content: JSON.stringify({
          text: finalContent,
        }),
      },
    });
    console.log('[飞书] 消息发送成功');
  } catch (error) {
    console.error('[飞书] 消息发送失败:', error.message);
  }
}

// ========== 构建卡片 JSON ==========
function buildCard(content, title = 'Cursor AI 回复', template = 'blue') {
  const maxLength = 30000;
  let finalContent = content;
  if (content.length > maxLength) {
    finalContent = content.substring(0, maxLength) + '\n\n... (内容过长，已截断)';
  }
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: title },
      template,
    },
    elements: [
      { tag: 'markdown', content: finalContent },
    ],
  };
}

// ========== 发送 Markdown 消息卡片（返回 message_id） ==========
async function sendMarkdownCard(chatId, content, title = 'Cursor AI 回复', template = 'blue') {
  try {
    const card = buildCard(content, title, template);
    const resp = await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: JSON.stringify(card),
      },
    });
    // 飞书 SDK 响应可能嵌套在 data 中
    const messageId = resp?.message_id || resp?.data?.message_id || null;
    console.log(`[飞书] Markdown 卡片发送成功 (message_id: ${messageId})`);
    if (!messageId) {
      console.log(`[飞书] 响应结构: ${JSON.stringify(resp).substring(0, 500)}`);
    }
    return messageId;
  } catch (error) {
    console.error('[飞书] Markdown 卡片发送失败:', error.message);
    console.log('[飞书] 尝试降级为纯文本发送...');
    await sendMessage(chatId, content);
    return null;
  }
}

// ========== 更新已有的 Markdown 卡片（流式更新） ==========
async function updateMarkdownCard(messageId, content, title = 'Cursor AI 回复', template = 'blue') {
  if (!messageId) return;
  try {
    const card = buildCard(content, title, template);
    await client.im.message.patch({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify(card),
      },
    });
  } catch (error) {
    console.error('[飞书] 卡片更新失败:', error.message);
  }
}

// ========== 上传图片到飞书 ==========
async function uploadImage(imagePath) {
  try {
    console.log(`[飞书] 上传图片: ${imagePath}`);
    
    const imageBuffer = fs.readFileSync(imagePath);
    
    const response = await client.im.image.create({
      data: {
        image_type: 'message',
        image: imageBuffer,
      },
    });
    
    if (response.image_key) {
      console.log(`[飞书] 图片上传成功: ${response.image_key}`);
      return response.image_key;
    } else {
      throw new Error('上传图片未返回 image_key');
    }
  } catch (error) {
    console.error('[飞书] 图片上传失败:', error.message);
    throw error;
  }
}

// ========== 上传文件到飞书 ==========
async function uploadFile(filePath) {
  try {
    console.log(`[飞书] 上传文件: ${filePath}`);
    
    // 检查文件是否存在
    if (!fs.existsSync(filePath)) {
      throw new Error(`文件不存在: ${filePath}`);
    }
    
    const fileBuffer = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    const fileStats = fs.statSync(filePath);
    
    // 根据文件扩展名确定文件类型
    const ext = path.extname(filePath).toLowerCase();
    let fileType = 'stream'; // 默认为二进制流
    
    // 飞书支持的文件类型: opus, mp4, pdf, doc, xls, ppt, stream
    const typeMap = {
      '.pdf': 'pdf',
      '.doc': 'doc',
      '.docx': 'doc',
      '.xls': 'xls',
      '.xlsx': 'xls',
      '.ppt': 'ppt',
      '.pptx': 'ppt',
      '.mp4': 'mp4',
      '.opus': 'opus',
    };
    
    fileType = typeMap[ext] || 'stream';
    
    const response = await client.im.file.create({
      data: {
        file_type: fileType,
        file_name: fileName,
        file: fileBuffer,
      },
    });
    
    if (response.file_key) {
      console.log(`[飞书] 文件上传成功: ${response.file_key}`);
      return {
        file_key: response.file_key,
        file_name: fileName,
        file_size: fileStats.size,
      };
    } else {
      throw new Error('上传文件未返回 file_key');
    }
  } catch (error) {
    console.error('[飞书] 文件上传失败:', error.message);
    throw error;
  }
}

// ========== 发送文件消息 ==========
async function sendFile(chatId, fileKey, fileName) {
  try {
    await client.im.message.create({
      params: {
        receive_id_type: 'chat_id',
      },
      data: {
        receive_id: chatId,
        msg_type: 'file',
        content: JSON.stringify({
          file_key: fileKey,
        }),
      },
    });
    console.log(`[飞书] 文件消息发送成功: ${fileName}`);
  } catch (error) {
    console.error('[飞书] 文件消息发送失败:', error.message);
    throw error;
  }
}

// ========== 发送本地文件到飞书 ==========
async function sendLocalFile(chatId, filePath) {
  try {
    // 处理相对路径
    let absolutePath = filePath;
    if (!path.isAbsolute(filePath)) {
      absolutePath = path.join(config.workDir, filePath);
    }
    
    console.log(`[文件] 准备发送文件: ${absolutePath}`);
    
    // 检查文件是否存在
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`文件不存在: ${absolutePath}`);
    }
    
    // 获取文件信息
    const fileStats = fs.statSync(absolutePath);
    const fileName = path.basename(absolutePath);
    
    // 检查文件大小（飞书限制 30MB）
    const maxSize = 30 * 1024 * 1024; // 30MB
    if (fileStats.size > maxSize) {
      throw new Error(`文件过大（${(fileStats.size / 1024 / 1024).toFixed(2)}MB），飞书限制 30MB`);
    }
    
    // 上传文件
    const { file_key, file_size } = await uploadFile(absolutePath);
    
    // 发送文件消息
    await sendFile(chatId, file_key, fileName);
    
    return {
      success: true,
      fileName,
      fileSize: file_size,
    };
  } catch (error) {
    console.error('[文件] 发送失败:', error.message);
    throw error;
  }
}

// ========== 列出工作目录下的文件 ==========
function listFiles(dirPath = config.workDir, pattern = '') {
  try {
    const files = [];
    const items = fs.readdirSync(dirPath, { withFileTypes: true });
    
    for (const item of items) {
      // 跳过隐藏文件和 node_modules
      if (item.name.startsWith('.') || item.name === 'node_modules') {
        continue;
      }
      
      const fullPath = path.join(dirPath, item.name);
      const relativePath = path.relative(config.workDir, fullPath);
      
      if (item.isFile()) {
        // 如果有 pattern，检查文件名是否匹配
        if (!pattern || item.name.toLowerCase().includes(pattern.toLowerCase())) {
          const stats = fs.statSync(fullPath);
          files.push({
            name: item.name,
            path: relativePath,
            size: stats.size,
            mtime: stats.mtime,
          });
        }
      } else if (item.isDirectory()) {
        // 递归扫描子目录（限制深度为 3）
        const depth = relativePath.split(path.sep).length;
        if (depth < 3) {
          files.push(...listFiles(fullPath, pattern));
        }
      }
    }
    
    // 按修改时间倒序排列
    files.sort((a, b) => b.mtime - a.mtime);
    
    return files;
  } catch (error) {
    console.error('[文件列表] 错误:', error.message);
    return [];
  }
}

// ========== 格式化文件大小 ==========
function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

// ========== 获取目录下所有文件的快照 ==========
function getFileSnapshot(dirPath = config.workDir) {
  const snapshot = new Map();
  
  function scanDir(dir, depth = 0) {
    if (depth > 3) return; // 限制递归深度
    
    try {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      
      for (const item of items) {
        // 跳过隐藏文件和 node_modules
        if (item.name.startsWith('.') || item.name === 'node_modules') {
          continue;
        }
        
        const fullPath = path.join(dir, item.name);
        
        if (item.isFile()) {
          try {
            const stats = fs.statSync(fullPath);
            snapshot.set(fullPath, {
              size: stats.size,
              mtime: stats.mtimeMs,
            });
          } catch (e) {
            // 忽略无法读取的文件
          }
        } else if (item.isDirectory()) {
          scanDir(fullPath, depth + 1);
        }
      }
    } catch (e) {
      // 忽略无法读取的目录
    }
  }
  
  scanDir(dirPath);
  return snapshot;
}

// ========== 比较文件快照，找出新建和修改的文件 ==========
function compareSnapshots(before, after) {
  const newFiles = [];
  const modifiedFiles = [];
  
  for (const [filePath, afterInfo] of after.entries()) {
    const beforeInfo = before.get(filePath);
    const relativePath = path.relative(config.workDir, filePath);
    
    if (!beforeInfo) {
      // 新文件
      newFiles.push({
        path: relativePath,
        fullPath: filePath,
        size: afterInfo.size,
      });
    } else if (afterInfo.mtime > beforeInfo.mtime || afterInfo.size !== beforeInfo.size) {
      // 修改的文件
      modifiedFiles.push({
        path: relativePath,
        fullPath: filePath,
        size: afterInfo.size,
      });
    }
  }
  
  return { newFiles, modifiedFiles };
}

// ========== 发送图片消息 ==========
async function sendImage(chatId, imageKey) {
  try {
    await client.im.message.create({
      params: {
        receive_id_type: 'chat_id',
      },
      data: {
        receive_id: chatId,
        msg_type: 'image',
        content: JSON.stringify({
          image_key: imageKey,
        }),
      },
    });
    console.log('[飞书] 图片消息发送成功');
  } catch (error) {
    console.error('[飞书] 图片消息发送失败:', error.message);
    throw error;
  }
}

// ========== 截图并发送 ==========
async function captureAndSendScreenshot(chatId) {
  const tempPath = path.join(process.env.TEMP || '/tmp', `screenshot_${Date.now()}.png`);
  
  try {
    console.log('[截图] 开始截取屏幕...');
    
    // 截取屏幕
    await screenshot({ filename: tempPath, format: 'png' });
    console.log(`[截图] 截图保存到: ${tempPath}`);
    
    // 上传图片
    const imageKey = await uploadImage(tempPath);
    
    // 发送图片
    await sendImage(chatId, imageKey);
    
    return true;
  } catch (error) {
    console.error('[截图] 失败:', error.message);
    throw error;
  } finally {
    // 清理临时文件
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
        console.log('[截图] 临时文件已清理');
      }
    } catch (e) {
      // 忽略清理错误
    }
  }
}

// ========== 处理消息事件 ==========
async function handleMessage(event) {
  const message = event.message;
  const messageId = message.message_id;
  const chatId = message.chat_id;
  const msgType = message.message_type;
  const createTime = parseInt(message.create_time); // 消息创建时间（毫秒时间戳）
  
  // 过滤历史消息：只处理服务启动后的消息
  if (createTime < SERVICE_START_TIME) {
    console.log(`[跳过] 历史消息，创建时间: ${new Date(createTime).toLocaleString()}, 服务启动: ${new Date(SERVICE_START_TIME).toLocaleString()}`);
    return;
  }
  
  // 消息去重：防止飞书重试机制导致重复处理
  if (isMessageProcessed(messageId)) {
    return;
  }
  
  // 只处理文本消息
  if (msgType !== 'text') {
    await sendMessage(chatId, '目前只支持文本消息哦~');
    return;
  }
  
  // 解析消息内容
  const content = JSON.parse(message.content);
  const text = content.text || '';
  
  console.log(`[收到消息] ${text} (ID: ${messageId})`);
  
  // Stop 命令 - 终止当前任务
  if (text.includes('/stop') || text === '停止' || text === '终止') {
    const result = stopTask(chatId);
    if (result.stopped) {
      await sendMessage(chatId, `⏹️ 已终止任务\n\n任务：${result.prompt}...\n运行时长：${result.duration} 秒`);
    } else {
      await sendMessage(chatId, '当前没有正在执行的任务');
    }
    return;
  }
  
  // New 命令 - 开始新会话
  if (text.includes('/new') || text === '新会话' || text === '新对话') {
    const hadSession = clearSession(chatId);
    if (hadSession) {
      await sendMessage(chatId, '🔄 已清除当前会话，下次提问将开始新的对话');
    } else {
      await sendMessage(chatId, '当前没有活跃的会话');
    }
    return;
  }
  
  // Session 命令 - 查看当前会话状态
  if (text.includes('/session') || text === '会话状态') {
    const session = getSession(chatId);
    if (session) {
      const activeMs = Date.now() - session.lastActiveTime;
      const remainMs = SESSION_TTL - activeMs;
      // 智能显示时间（超过60分钟显示小时）
      const formatTime = (ms) => {
        const minutes = Math.round(ms / 60000);
        if (minutes >= 60) {
          const hours = Math.floor(minutes / 60);
          const mins = minutes % 60;
          return mins > 0 ? `${hours} 小时 ${mins} 分钟` : `${hours} 小时`;
        }
        return `${minutes} 分钟`;
      };
      await sendMessage(chatId, `📝 当前会话状态\n\n会话ID: ${session.conversationId.substring(0, 20)}...\n上次活跃: ${formatTime(activeMs)}前\n剩余时间: ${formatTime(remainMs)}\n\n发送 /new 可开始新会话`);
    } else {
      await sendMessage(chatId, '当前没有活跃的会话，下次提问将开始新对话');
    }
    return;
  }
  
  // Help 命令 - 帮助信息
  if (text.includes('/help') || text === '帮助') {
    const helpText = `🤖 Cursor AI 助手使用说明

━━━━━━━━━━━━━━━━━━━━━━
📝 执行模式（默认）
━━━━━━━━━━━━━━━━━━━━━━
直接发送消息，AI 将执行代码任务
例：帮我写一个 Python 计算器

━━━━━━━━━━━━━━━━━━━━━━
❓ 问答模式（只读）
━━━━━━━━━━━━━━━━━━━━━━
/ask 你的问题
或：问：你的问题

━━━━━━━━━━━━━━━━━━━━━━
📋 规划模式
━━━━━━━━━━━━━━━━━━━━━━
/plan 你的任务
或：规划：你的任务

━━━━━━━━━━━━━━━━━━━━━━
💬 会话管理
━━━━━━━━━━━━━━━━━━━━━━
会话自动保持，支持多轮对话
/new - 开始新会话（清除上下文）
/session - 查看当前会话状态
会话超时：${SESSION_TTL / 3600000} 小时无活动自动清除

━━━━━━━━━━━━━━━━━━━━━━
🛠️ 控制命令
━━━━━━━━━━━━━━━━━━━━━━
/stop - 终止当前正在执行的任务
/screenshot - 截取屏幕并发送
/log [行数] - 查看日志（默认10行）
/help - 显示此帮助信息

━━━━━━━━━━━━━━━━━━━━━━
📂 文件操作
━━━━━━━━━━━━━━━━━━━━━━
/ls [关键词] - 列出工作目录文件
/file <路径> - 发送指定文件到飞书
例: /file src/index.js

━━━━━━━━━━━━━━━━━━━━━━
⚙️ 当前配置
━━━━━━━━━━━━━━━━━━━━━━
工作目录：${config.workDir}
超时时间：${config.timeout / 1000} 秒`;
    
    await sendMessage(chatId, helpText);
    return;
  }
  
  // Screenshot 命令 - 截图并发送
  if (text.includes('/screenshot') || text === '截图' || text === '截屏') {
    await sendMessage(chatId, '📸 正在截取屏幕...');
    try {
      await captureAndSendScreenshot(chatId);
    } catch (error) {
      await sendMessage(chatId, `❌ 截图失败：${error.message}`);
    }
    return;
  }
  
  // Log 命令 - 查看日志
  if (text.startsWith('/log') || text === '日志') {
    // 解析行数参数，默认 10 行
    let lines = 10;
    const match = text.match(/\/log\s+(\d+)/);
    if (match) {
      lines = parseInt(match[1], 10);
      // 限制最大行数，防止消息过长
      if (lines > 200) {
        lines = 200;
      }
    }
    
    const logContent = readLogFile(lines);
    await sendMessage(chatId, logContent);
    return;
  }
  
  // File 命令 - 发送文件
  if (text.startsWith('/file ') || text.startsWith('发送文件 ') || text.startsWith('发文件 ')) {
    const filePath = text.replace(/^(\/file\s+|发送文件\s+|发文件\s+)/, '').trim();
    
    if (!filePath) {
      await sendMessage(chatId, '请指定文件路径\n\n用法: /file <文件路径>\n例如: /file src/index.js\n\n提示: 使用 /ls 命令查看可用文件');
      return;
    }
    
    await sendMessage(chatId, `📤 正在发送文件: ${filePath}`);
    
    try {
      const result = await sendLocalFile(chatId, filePath);
      await sendMessage(chatId, `✅ 文件发送成功\n\n文件名: ${result.fileName}\n大小: ${formatFileSize(result.fileSize)}`);
    } catch (error) {
      await sendMessage(chatId, `❌ 文件发送失败: ${error.message}`);
    }
    return;
  }
  
  // Ls 命令 - 列出文件
  if (text.startsWith('/ls') || text === '文件列表' || text === '列出文件') {
    // 解析搜索参数
    const match = text.match(/^\/ls\s+(.+)/);
    const pattern = match ? match[1].trim() : '';
    
    const files = listFiles(config.workDir, pattern);
    
    if (files.length === 0) {
      await sendMessage(chatId, pattern 
        ? `未找到匹配 "${pattern}" 的文件`
        : '工作目录下没有文件');
      return;
    }
    
    // 只显示前 20 个文件
    const displayFiles = files.slice(0, 20);
    
    let fileList = `📁 工作目录文件${pattern ? ` (搜索: ${pattern})` : ''}\n\n`;
    fileList += displayFiles.map((f, i) => {
      const sizeStr = formatFileSize(f.size);
      const timeStr = new Date(f.mtime).toLocaleString('zh-CN', { 
        month: '2-digit', 
        day: '2-digit', 
        hour: '2-digit', 
        minute: '2-digit' 
      });
      return `${i + 1}. ${f.path}\n   ${sizeStr} | ${timeStr}`;
    }).join('\n\n');
    
    if (files.length > 20) {
      fileList += `\n\n... 还有 ${files.length - 20} 个文件`;
    }
    
    fileList += '\n\n💡 使用 /file <路径> 发送文件';
    
    await sendMessage(chatId, fileList);
    return;
  }
  
  // 解析消息
  const { mode, prompt } = parseMessage(text);
  
  if (!prompt) {
    await sendMessage(chatId, '请输入您的问题或任务~');
    return;
  }
  
  // 发送处理中提示
  const modeNames = {
    agent: '执行',
    ask: '查询',
    plan: '规划',
  };
  
  // 检查是否有现有会话
  const existingSession = getSession(chatId);
  const sessionHint = existingSession ? '（继续对话）' : '（新会话）';
  
  // 发送初始流式卡片（替代"请稍候"）
  const streamingTitle = `⏳ ${modeNames[mode]}中${sessionHint}...`;
  const streamCardId = await sendMarkdownCard(chatId, '思考中...', streamingTitle, 'wathet');
  
  // 设置当前活跃的 chatId（供 API 接口使用）
  currentActiveChatId = chatId;
  
  // 执行前获取文件快照（用于检测新生成的文件）
  const beforeSnapshot = getFileSnapshot();
  
  try {
    // 流式回调：实时更新飞书卡片（返回 Promise 以支持链式等待）
    const onStream = (text) => {
      return updateMarkdownCard(streamCardId, text, streamingTitle, 'wathet');
    };
    
    // 调用 Cursor CLI（传入 chatId 以支持 stop 命令 + 流式回调）
    const result = await callCursorCLI(prompt, mode, chatId, onStream);
    
    // 执行后获取文件快照
    const afterSnapshot = getFileSnapshot();
    const { newFiles, modifiedFiles } = compareSnapshots(beforeSnapshot, afterSnapshot);
    
    // 最终更新卡片为完成状态
    const cardTitle = `✅ ${modeNames[mode]}完成`;
    await updateMarkdownCard(streamCardId, result, cardTitle, 'green');
    
    // 检查用户是否要求发送文件
    const wantsSendFile = /发送|发给我|给我|发我|传给我|send|发到飞书/.test(prompt);
    
    // 如果有新建的文件
    if (newFiles.length > 0) {
      // 如果用户要求发送文件，自动发送新建的文件
      if (wantsSendFile) {
        await sendMessage(chatId, `📤 正在发送 ${newFiles.length} 个新文件...`);
        
        let successCount = 0;
        let failedFiles = [];
        
        for (const file of newFiles.slice(0, 5)) { // 最多发送 5 个文件
          try {
            await sendLocalFile(chatId, file.fullPath);
            successCount++;
          } catch (error) {
            failedFiles.push({ name: file.path, error: error.message });
          }
        }
        
        if (successCount > 0) {
          let notice = `✅ 成功发送 ${successCount} 个文件`;
          if (newFiles.length > 5) {
            notice += `\n\n还有 ${newFiles.length - 5} 个文件未发送，使用 /ls 查看`;
          }
          if (failedFiles.length > 0) {
            notice += `\n\n❌ ${failedFiles.length} 个文件发送失败`;
          }
          await sendMessage(chatId, notice);
        } else if (failedFiles.length > 0) {
          await sendMessage(chatId, `❌ 文件发送失败: ${failedFiles[0].error}`);
        }
      } else {
        // 不需要发送，只提示有新文件
        let fileNotice = '📂 **检测到新文件**\n\n';
        newFiles.slice(0, 10).forEach(f => {
          fileNotice += `• ${f.path} (${formatFileSize(f.size)})\n`;
        });
        if (newFiles.length > 10) {
          fileNotice += `\n... 还有 ${newFiles.length - 10} 个文件\n`;
        }
        fileNotice += '\n💡 发送 `/file <路径>` 获取文件';
        
        await sendMarkdownCard(chatId, fileNotice, '📂 新文件');
      }
    }
  } catch (error) {
    console.error('[错误]', error);
    
    // 如果是用户主动停止的，不显示错误
    if (error.message === 'STOPPED_BY_USER') {
      return;
    }
    
    await sendMessage(chatId, `❌ 执行出错：${error.message}`);
  }
}

// ========== HTTP API 服务器 ==========
// 提供给 Cursor CLI 调用的文件发送接口
function startApiServer() {
  const server = http.createServer(async (req, res) => {
    // 设置 CORS 头
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    // 处理 OPTIONS 预检请求
    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }
    
    // 只处理 POST /send-file
    if (req.method === 'POST' && req.url === '/send-file') {
      let body = '';
      
      req.on('data', chunk => {
        body += chunk.toString();
      });
      
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          const filePath = data.file_path;
          
          if (!filePath) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: '缺少 file_path 参数' }));
            return;
          }
          
          if (!currentActiveChatId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: '没有活跃的聊天会话' }));
            return;
          }
          
          console.log(`[API] 收到文件发送请求: ${filePath} -> ${currentActiveChatId}`);
          
          // 发送文件
          const result = await sendLocalFile(currentActiveChatId, filePath);
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ 
            success: true, 
            message: '文件发送成功',
            fileName: result.fileName,
            fileSize: result.fileSize,
          }));
          
          console.log(`[API] 文件发送成功: ${result.fileName}`);
        } catch (error) {
          console.error(`[API] 文件发送失败:`, error.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: error.message }));
        }
      });
    } 
    // 健康检查接口
    else if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ 
        status: 'ok', 
        activeChatId: currentActiveChatId,
        workDir: config.workDir,
      }));
    }
    // 其他请求返回 404
    else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
    }
  });
  
  server.listen(config.apiPort, '127.0.0.1', () => {
    console.log(`📡 API 服务已启动: http://localhost:${config.apiPort}`);
    console.log(`   - POST /send-file - 发送文件到飞书`);
    console.log(`   - GET /health - 健康检查`);
  });
  
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`❌ 端口 ${config.apiPort} 已被占用，请修改 API_PORT 环境变量`);
    } else {
      console.error(`❌ API 服务启动失败:`, err.message);
    }
  });
  
  return server;
}

// ========== 启动长连接 ==========
async function startWebSocket() {
  console.log('========================================');
  console.log('🚀 飞书 + Cursor CLI 桥接服务启动中...');
  console.log('========================================');
  console.log(`App ID: ${config.appId.substring(0, 8)}...`);
  console.log(`工作目录: ${config.workDir}`);
  console.log(`启动时间: ${new Date(SERVICE_START_TIME).toLocaleString()}`);
  console.log(`历史消息: 将被自动过滤`);
  console.log('');
  
  // 创建 WebSocket 客户端
  const wsClient = new lark.WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
    loggerLevel: lark.LoggerLevel.info,
  });
  
  // 注册消息事件处理器
  wsClient.start({
    eventDispatcher: new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        try {
          await handleMessage(data);
        } catch (error) {
          console.error('[事件处理错误]', error);
        }
      },
    }),
  });
  
  console.log('✅ WebSocket 长连接已建立');
  console.log('📱 现在可以在飞书中 @机器人 发送消息了');
  console.log('');
  console.log('按 Ctrl+C 停止服务');
}

// ========== 主入口 ==========
// 启动 API 服务器（供 Cursor CLI 调用）
startApiServer();

// 启动飞书 WebSocket 连接
startWebSocket().catch((error) => {
  console.error('启动失败:', error);
  process.exit(1);
});
