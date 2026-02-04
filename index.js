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

// ========== 处理消息事件 ==========
async function handleMessage(event) {
  const message = event.message;
  const messageId = message.message_id;
  const chatId = message.chat_id;
  const msgType = message.message_type;
  
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
/help - 显示此帮助信息

━━━━━━━━━━━━━━━━━━━━━━
⚙️ 当前配置
━━━━━━━━━━━━━━━━━━━━━━
工作目录：${config.workDir}
超时时间：${config.timeout / 1000} 秒`;
    
    await sendMessage(chatId, helpText);
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
