/**
 * 飞书机器人 + Cursor CLI 桥接服务
 * 
 * 功能：接收飞书消息，调用 Cursor CLI 处理，返回结果
 * 
 * @author Cursor AI Assistant
 * @version 1.0.0
 */

import 'dotenv/config';
import * as lark from '@larksuiteoapi/node-sdk';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import screenshot from 'screenshot-desktop';

// ========== 配置 ==========
const config = {
  // 飞书应用凭证（从环境变量读取）
  appId: process.env.FEISHU_APP_ID,
  appSecret: process.env.FEISHU_APP_SECRET,
  
  // Cursor CLI 工作目录（可选，默认当前目录）
  workDir: process.env.CURSOR_WORK_DIR || process.cwd(),
  
  // 命令超时时间（毫秒），默认 5 分钟
  timeout: parseInt(process.env.CURSOR_TIMEOUT) || 300000,
  
  // ripgrep 路径（可选，如果已在系统 PATH 中则无需配置）
  ripgrepPath: process.env.RIPGREP_PATH || '',
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

// ========== 调用 Cursor CLI ==========
async function callCursorCLI(prompt, mode = 'agent', chatId = null) {
  console.log(`[Cursor CLI] 执行任务: ${prompt.substring(0, 50)}...`);
  console.log(`[Cursor CLI] 模式: ${mode}`);
  console.log(`[Cursor CLI] 工作目录: ${config.workDir}`);
  
  // 构建命令参数
  const args = ['-p', '--force', '--output-format', 'stream-json', '--stream-partial-output'];
  
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
    let lastAssistantMessage = '';
    let wasKilled = false;
    
    child.stdout.on('data', (data) => {
      const text = data.toString();
      console.log(`[Cursor CLI 输出] ${text.substring(0, 200)}`);
      
      // 解析每一行 JSON
      const lines = text.split('\n').filter(line => line.trim());
      for (const line of lines) {
        try {
          const json = JSON.parse(line);
          
          // 获取最终结果
          if (json.type === 'result' && json.result) {
            result = json.result;
            console.log(`[Cursor CLI] 获取到结果: ${result.substring(0, 100)}...`);
          }
          
          // 获取助手消息（备用）
          if (json.type === 'assistant' && json.message?.content?.[0]?.text) {
            lastAssistantMessage = json.message.content[0].text;
          }
        } catch (e) {
          // 忽略非 JSON 行
        }
      }
    });
    
    child.stderr.on('data', (data) => {
      console.log(`[Cursor CLI 错误] ${data.toString()}`);
    });
    
    child.on('close', (code) => {
      console.log(`[Cursor CLI] 退出码: ${code}`);
      cleanupTask();
      
      // 如果是被用户手动终止的
      if (wasKilled) {
        reject(new Error('STOPPED_BY_USER'));
        return;
      }
      
      // 优先使用 result，否则使用最后的助手消息
      const finalResult = result || lastAssistantMessage;
      
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
      reject(err);
    });
    
    // 标记进程可被外部终止
    child.markAsKilled = () => {
      wasKilled = true;
    };
    
    // 通过 stdin 发送纯文本提示词
    child.stdin.write(prompt);
    child.stdin.end();
    
    // 超时处理
    setTimeout(() => {
      if (!child.killed) {
        child.kill();
        cleanupTask();
        reject(new Error('命令执行超时（5分钟）'));
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
🛠️ 控制命令
━━━━━━━━━━━━━━━━━━━━━━
/stop - 终止当前正在执行的任务
/screenshot - 截取屏幕并发送
/log [行数] - 查看日志（默认10行）
/help - 显示此帮助信息

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
  await sendMessage(chatId, `⏳ 正在${modeNames[mode]}中，请稍候...`);
  
  try {
    // 调用 Cursor CLI（传入 chatId 以支持 stop 命令）
    const result = await callCursorCLI(prompt, mode, chatId);
    
    // 发送结果
    await sendMessage(chatId, `✅ ${modeNames[mode]}完成\n\n${result}`);
  } catch (error) {
    console.error('[错误]', error);
    
    // 如果是用户主动停止的，不显示错误
    if (error.message === 'STOPPED_BY_USER') {
      return;
    }
    
    await sendMessage(chatId, `❌ 执行出错：${error.message}`);
  }
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
startWebSocket().catch((error) => {
  console.error('启动失败:', error);
  process.exit(1);
});
