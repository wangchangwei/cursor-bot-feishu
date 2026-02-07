#!/usr/bin/env node
/**
 * 飞书文件发送 MCP Server
 * 
 * 提供 send_file_to_feishu 工具，让 Cursor 可以直接发送文件到飞书
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import path from 'path';
import { spawn, execSync } from 'child_process';

// 配置
const API_PORT = process.env.FEISHU_API_PORT || 3456;
const API_HOST = process.env.FEISHU_API_HOST || 'http://localhost';

// 创建 MCP Server
const server = new Server(
  {
    name: 'feishu-file-sender',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// 列出可用工具
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'send_file_to_feishu',
        description: '将本地文件发送到飞书聊天。当用户要求你生成文件并发送时，使用此工具。支持图片、文档、代码等各类文件，大小限制 30MB。',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: '要发送的文件路径（相对路径或绝对路径）',
            },
            message: {
              type: 'string',
              description: '可选，发送文件时附带的说明文字',
            },
          },
          required: ['file_path'],
        },
      },
      {
        name: 'list_files',
        description: '列出工作目录下的文件，帮助确认文件是否存在',
        inputSchema: {
          type: 'object',
          properties: {
            directory: {
              type: 'string',
              description: '要列出的目录路径，默认为当前工作目录',
            },
            pattern: {
              type: 'string',
              description: '可选，文件名过滤关键词',
            },
          },
        },
      },
      {
        name: 'record_audio',
        description: '使用麦克风录制音频。录制完成后返回文件路径，可配合 send_file_to_feishu 发送给用户。',
        inputSchema: {
          type: 'object',
          properties: {
            duration: {
              type: 'number',
              description: '录音时长（秒），默认 10 秒，最长 300 秒',
            },
            output_path: {
              type: 'string',
              description: '输出文件路径，默认为 recording_<timestamp>.wav',
            },
          },
        },
      },
      {
        name: 'list_audio_devices',
        description: '列出系统可用的音频输入设备（麦克风）',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'capture_photo',
        description: '使用摄像头拍摄一张照片。拍照完成后返回文件路径，可配合 send_file_to_feishu 发送给用户。',
        inputSchema: {
          type: 'object',
          properties: {
            output_path: {
              type: 'string',
              description: '输出文件路径，默认为 photo_<timestamp>.jpg',
            },
            device_name: {
              type: 'string',
              description: '可选，指定摄像头设备名称。不指定则自动选择第一个可用摄像头',
            },
          },
        },
      },
      {
        name: 'list_video_devices',
        description: '列出系统可用的视频输入设备（摄像头）',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ],
  };
});

// 处理工具调用
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'send_file_to_feishu') {
    const filePath = args.file_path;
    const message = args.message || '';

    if (!filePath) {
      return {
        content: [{ type: 'text', text: '错误：缺少 file_path 参数' }],
        isError: true,
      };
    }

    try {
      // 检查文件是否存在
      const absolutePath = path.isAbsolute(filePath) 
        ? filePath 
        : path.join(process.cwd(), filePath);
      
      if (!fs.existsSync(absolutePath)) {
        return {
          content: [{ type: 'text', text: `错误：文件不存在 - ${absolutePath}` }],
          isError: true,
        };
      }

      // 调用本地 API 发送文件
      const response = await fetch(`${API_HOST}:${API_PORT}/send-file`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          file_path: absolutePath,
          message: message,
        }),
      });

      const result = await response.json();

      if (result.success) {
        return {
          content: [{
            type: 'text',
            text: `✅ 文件发送成功！\n文件名: ${result.fileName}\n大小: ${formatFileSize(result.fileSize)}`,
          }],
        };
      } else {
        return {
          content: [{ type: 'text', text: `❌ 发送失败: ${result.error}` }],
          isError: true,
        };
      }
    } catch (error) {
      return {
        content: [{ type: 'text', text: `❌ 发送失败: ${error.message}` }],
        isError: true,
      };
    }
  }

  if (name === 'list_files') {
    const directory = args.directory || process.cwd();
    const pattern = args.pattern || '';

    try {
      const files = listFilesRecursive(directory, pattern);
      
      if (files.length === 0) {
        return {
          content: [{ type: 'text', text: pattern ? `未找到匹配 "${pattern}" 的文件` : '目录为空' }],
        };
      }

      const fileList = files.slice(0, 30).map(f => 
        `${f.path} (${formatFileSize(f.size)})`
      ).join('\n');

      return {
        content: [{
          type: 'text',
          text: `找到 ${files.length} 个文件${pattern ? ` (匹配: ${pattern})` : ''}:\n\n${fileList}${files.length > 30 ? `\n\n... 还有 ${files.length - 30} 个文件` : ''}`,
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `错误: ${error.message}` }],
        isError: true,
      };
    }
  }

  if (name === 'record_audio') {
    let duration = args.duration || 10;
    if (duration > 300) duration = 300;
    if (duration < 1) duration = 1;
    
    const timestamp = Date.now();
    const outputPath = args.output_path || path.join(process.cwd(), `recording_${timestamp}.wav`);
    const absolutePath = path.isAbsolute(outputPath) ? outputPath : path.join(process.cwd(), outputPath);

    try {
      // 获取麦克风设备列表，找到真正的麦克风
      const micDevice = findMicrophoneDevice();
      
      console.error(`[录音] 开始录音: ${duration}秒, 设备: ${micDevice}, 输出: ${absolutePath}`);
      
      // 使用 ffmpeg 录音
      await new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', [
          '-f', 'avfoundation',
          '-i', `:${micDevice}`,  // 只录制音频
          '-t', String(duration),
          '-acodec', 'pcm_s16le',  // WAV 格式
          '-ar', '44100',  // 采样率
          '-ac', '1',  // 单声道
          '-y',  // 覆盖输出文件
          absolutePath
        ], {
          stdio: ['pipe', 'pipe', 'pipe']
        });

        let stderr = '';
        ffmpeg.stderr.on('data', (data) => {
          stderr += data.toString();
          console.error(`[ffmpeg] ${data.toString()}`);
        });

        ffmpeg.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`ffmpeg 退出码: ${code}\n${stderr}`));
          }
        });

        ffmpeg.on('error', reject);
      });

      // 检查文件是否生成
      if (!fs.existsSync(absolutePath)) {
        throw new Error('录音文件未生成');
      }

      const stats = fs.statSync(absolutePath);
      
      return {
        content: [{
          type: 'text',
          text: `✅ 录音完成！\n文件路径: ${absolutePath}\n时长: ${duration} 秒\n大小: ${formatFileSize(stats.size)}\n\n可以使用 send_file_to_feishu 工具将此文件发送给用户。`,
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `❌ 录音失败: ${error.message}` }],
        isError: true,
      };
    }
  }

  if (name === 'list_audio_devices') {
    try {
      const devices = getAudioDevices();
      return {
        content: [{
          type: 'text',
          text: `音频输入设备列表:\n\n${devices.map(d => `[${d.index}] ${d.name}`).join('\n')}`,
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `获取设备列表失败: ${error.message}` }],
        isError: true,
      };
    }
  }

  if (name === 'capture_photo') {
    const timestamp = Date.now();
    const outputPath = args.output_path || path.join(process.cwd(), `photo_${timestamp}.jpg`);
    const absolutePath = path.isAbsolute(outputPath) ? outputPath : path.join(process.cwd(), outputPath);
    const deviceName = args.device_name || null;

    try {
      // 获取摄像头设备
      const devices = getVideoDevices();
      if (devices.length === 0) {
        throw new Error('未检测到摄像头设备，请确认摄像头已连接且 ffmpeg 已安装');
      }

      // 选择设备
      let selectedDevice = devices[0];
      if (deviceName) {
        const found = devices.find(d => d.name.toLowerCase().includes(deviceName.toLowerCase()));
        if (found) {
          selectedDevice = found;
        } else {
          console.error(`[拍照] 未找到匹配 "${deviceName}" 的设备，使用默认设备: ${devices[0].name}`);
        }
      }

      console.error(`[拍照] 使用设备: ${selectedDevice.name}, 输出: ${absolutePath}`);

      // 使用 ffmpeg 从摄像头捕获一帧
      await new Promise((resolve, reject) => {
        let ffmpegArgs;
        if (process.platform === 'win32') {
          ffmpegArgs = [
            '-f', 'dshow',
            '-i', `video=${selectedDevice.name}`,
            '-frames:v', '1',
            '-q:v', '2',
            '-y',
            absolutePath,
          ];
        } else {
          ffmpegArgs = [
            '-f', 'avfoundation',
            '-i', `${selectedDevice.index}:none`,
            '-frames:v', '1',
            '-q:v', '2',
            '-y',
            absolutePath,
          ];
        }

        const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
          stdio: ['pipe', 'pipe', 'pipe'],
        });

        let stderr = '';
        ffmpeg.stderr.on('data', (data) => {
          stderr += data.toString();
          console.error(`[ffmpeg] ${data.toString()}`);
        });

        ffmpeg.on('close', (code) => {
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`ffmpeg 退出码: ${code}\n${stderr.slice(-500)}`));
          }
        });

        ffmpeg.on('error', (err) => {
          reject(new Error(`无法启动 ffmpeg: ${err.message}`));
        });

        // 超时 15 秒
        setTimeout(() => {
          ffmpeg.kill('SIGKILL');
          reject(new Error('拍照超时（15秒），请检查摄像头是否正常'));
        }, 15000);
      });

      if (!fs.existsSync(absolutePath)) {
        throw new Error('照片文件未生成');
      }

      const stats = fs.statSync(absolutePath);

      return {
        content: [{
          type: 'text',
          text: `✅ 拍照完成！\n文件路径: ${absolutePath}\n大小: ${formatFileSize(stats.size)}\n设备: ${selectedDevice.name}\n\n可以使用 send_file_to_feishu 工具将此照片发送给用户。`,
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `❌ 拍照失败: ${error.message}` }],
        isError: true,
      };
    }
  }

  if (name === 'list_video_devices') {
    try {
      const devices = getVideoDevices();
      if (devices.length === 0) {
        return {
          content: [{ type: 'text', text: '未检测到视频输入设备。请确认摄像头已连接且 ffmpeg 已安装。' }],
        };
      }
      return {
        content: [{
          type: 'text',
          text: `视频输入设备列表:\n\n${devices.map(d => `[${d.index}] ${d.name}`).join('\n')}`,
        }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: `获取设备列表失败: ${error.message}` }],
        isError: true,
      };
    }
  }

  return {
    content: [{ type: 'text', text: `未知工具: ${name}` }],
    isError: true,
  };
});

// 辅助函数：格式化文件大小
function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

// 辅助函数：获取视频设备列表
function getVideoDevices() {
  try {
    let output;
    if (process.platform === 'win32') {
      output = execSync('ffmpeg -list_devices true -f dshow -i dummy 2>&1 || exit 0', {
        encoding: 'utf-8',
        timeout: 10000,
        shell: true,
      });
    } else {
      output = execSync('ffmpeg -f avfoundation -list_devices true -i "" 2>&1 || true', {
        encoding: 'utf-8',
        timeout: 10000,
      });
    }

    const devices = [];
    const lines = output.split('\n');

    if (process.platform === 'win32') {
      // Windows dshow: 兼容新旧版 ffmpeg
      // 新版: [dshow @ ...] "DeviceName" (video)
      // 旧版: [dshow @ ...] DirectShow video devices: 然后逐行列出
      let inVideoSection = false;

      for (const line of lines) {
        // 方式1: 直接匹配带 (video) 后缀的设备行
        const videoMatch = line.match(/"([^"]+)"\s*\(video\)/);
        if (videoMatch) {
          devices.push({ index: devices.length, name: videoMatch[1] });
          continue;
        }

        // 方式2: 旧版 ffmpeg 带 section header
        if (line.includes('DirectShow video devices')) {
          inVideoSection = true;
          continue;
        }
        if (line.includes('DirectShow audio devices')) {
          inVideoSection = false;
          continue;
        }
        if (inVideoSection) {
          const match = line.match(/"([^"]+)"/);
          if (match && !line.includes('Alternative name')) {
            devices.push({ index: devices.length, name: match[1] });
          }
        }
      }
    } else {
      // macOS avfoundation
      let inVideoSection = false;
      for (const line of lines) {
        if (line.includes('AVFoundation video devices:')) {
          inVideoSection = true;
          continue;
        }
        if (line.includes('AVFoundation audio devices:')) {
          inVideoSection = false;
          continue;
        }
        if (inVideoSection) {
          const match = line.match(/\[(\d+)\]\s+(.+)/);
          if (match) {
            devices.push({ index: parseInt(match[1]), name: match[2].trim() });
          }
        }
      }
    }

    return devices;
  } catch (error) {
    console.error('获取视频设备失败:', error.message);
    return [];
  }
}

// 辅助函数：获取音频设备列表
function getAudioDevices() {
  try {
    const output = execSync('ffmpeg -f avfoundation -list_devices true -i "" 2>&1 || true', {
      encoding: 'utf-8',
      timeout: 5000,
    });
    
    const devices = [];
    const lines = output.split('\n');
    let inAudioSection = false;
    
    for (const line of lines) {
      if (line.includes('AVFoundation audio devices:')) {
        inAudioSection = true;
        continue;
      }
      if (inAudioSection) {
        const match = line.match(/\[(\d+)\]\s+(.+)/);
        if (match) {
          devices.push({
            index: parseInt(match[1]),
            name: match[2].trim(),
          });
        }
      }
    }
    
    return devices;
  } catch (error) {
    console.error('获取音频设备失败:', error.message);
    return [];
  }
}

// 辅助函数：找到真正的麦克风设备
function findMicrophoneDevice() {
  const devices = getAudioDevices();
  
  // 优先级1：物理麦克风品牌关键词（最高优先级）
  const physicalMicKeywords = ['seiren', 'razer', 'blue yeti', 'shure', 'rode', 'audio-technica', 'hyperx'];
  
  // 优先级2：一般麦克风关键词
  const micKeywords = ['microphone', 'mic', 'input', '麦克风'];
  
  // 排除关键词（虚拟设备和输出设备）
  const excludeKeywords = ['speaker', 'output', 'streaming', 'virtual', 'wemeet', 'lark'];
  
  // 第一轮：找物理麦克风
  for (const device of devices) {
    const nameLower = device.name.toLowerCase();
    if (physicalMicKeywords.some(kw => nameLower.includes(kw))) {
      console.error(`[录音] 找到物理麦克风: [${device.index}] ${device.name}`);
      return device.index;
    }
  }
  
  // 第二轮：找一般麦克风（排除虚拟设备）
  for (const device of devices) {
    const nameLower = device.name.toLowerCase();
    
    // 排除虚拟设备和输出设备
    if (excludeKeywords.some(kw => nameLower.includes(kw))) {
      continue;
    }
    
    // 选择包含麦克风关键词的设备
    if (micKeywords.some(kw => nameLower.includes(kw))) {
      console.error(`[录音] 找到麦克风设备: [${device.index}] ${device.name}`);
      return device.index;
    }
  }
  
  // 第三轮：选择第一个非虚拟、非输出的设备
  for (const device of devices) {
    const nameLower = device.name.toLowerCase();
    if (!excludeKeywords.some(kw => nameLower.includes(kw))) {
      console.error(`[录音] 使用备选设备: [${device.index}] ${device.name}`);
      return device.index;
    }
  }
  
  // 最后兜底：使用默认设备 0
  console.error('[录音] 使用默认设备: 0');
  return 0;
}

// 辅助函数：递归列出文件
function listFilesRecursive(dirPath, pattern = '', depth = 0) {
  const files = [];
  if (depth > 3) return files;

  try {
    const items = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const item of items) {
      if (item.name.startsWith('.') || item.name === 'node_modules') {
        continue;
      }

      const fullPath = path.join(dirPath, item.name);

      if (item.isFile()) {
        if (!pattern || item.name.toLowerCase().includes(pattern.toLowerCase())) {
          const stats = fs.statSync(fullPath);
          files.push({
            name: item.name,
            path: fullPath,
            size: stats.size,
          });
        }
      } else if (item.isDirectory()) {
        files.push(...listFilesRecursive(fullPath, pattern, depth + 1));
      }
    }
  } catch (e) {
    // 忽略无法读取的目录
  }

  return files;
}

// 启动服务器
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('飞书文件发送 MCP Server 已启动');
}

main().catch(console.error);
