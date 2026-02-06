#!/bin/bash
# ==========================================
# 飞书 + Cursor CLI 桥接服务管理脚本
# 用法: ./service.sh {start|stop|restart|status|logs}
# ==========================================

APP_NAME="feishu-cursor-bridge"
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$APP_DIR/.service.pid"
LOG_FILE="$APP_DIR/service.log"
ENTRY="index.js"

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

# 获取运行中的 PID
get_pid() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      echo "$pid"
      return 0
    fi
    # PID 文件存在但进程已死，清理
    rm -f "$PID_FILE"
  fi
  return 1
}

start() {
  local pid
  if pid=$(get_pid); then
    echo -e "${YELLOW}⚠ 服务已在运行中 (PID: $pid)${NC}"
    return 1
  fi

  echo -e "${GREEN}🚀 启动 $APP_NAME ...${NC}"

  # 后台运行，caffeinate -s 阻止系统休眠以保持网络连接
  nohup caffeinate -s node "$APP_DIR/$ENTRY" >> "$LOG_FILE" 2>&1 &
  local new_pid=$!

  # 等待一小段时间确认进程存活
  sleep 2
  if kill -0 "$new_pid" 2>/dev/null; then
    echo "$new_pid" > "$PID_FILE"
    echo -e "${GREEN}✅ 服务已启动 (PID: $new_pid)${NC}"
    echo -e "   日志文件: $LOG_FILE"
    echo -e "   查看日志: ./service.sh logs"
  else
    echo -e "${RED}❌ 服务启动失败，请检查日志: $LOG_FILE${NC}"
    tail -20 "$LOG_FILE"
    return 1
  fi
}

stop() {
  local pid
  if ! pid=$(get_pid); then
    echo -e "${YELLOW}⚠ 服务未运行${NC}"
    return 0
  fi

  echo -e "${YELLOW}⏹ 停止服务 (PID: $pid) ...${NC}"
  kill "$pid" 2>/dev/null

  # 等待进程退出，最多 10 秒
  local count=0
  while kill -0 "$pid" 2>/dev/null && [ $count -lt 10 ]; do
    sleep 1
    count=$((count + 1))
  done

  # 如果还没退出，强制杀掉
  if kill -0 "$pid" 2>/dev/null; then
    echo -e "${RED}强制终止进程...${NC}"
    kill -9 "$pid" 2>/dev/null
    sleep 1
  fi

  rm -f "$PID_FILE"
  echo -e "${GREEN}✅ 服务已停止${NC}"
}

restart() {
  echo -e "${YELLOW}🔄 重启 $APP_NAME ...${NC}"
  stop
  sleep 1
  start
}

status() {
  local pid
  if pid=$(get_pid); then
    local uptime
    uptime=$(ps -o etime= -p "$pid" 2>/dev/null | xargs)
    echo -e "${GREEN}✅ 服务运行中${NC}"
    echo "   PID:      $pid"
    echo "   运行时长: $uptime"
    echo "   日志文件: $LOG_FILE"
  else
    echo -e "${RED}⏹ 服务未运行${NC}"
  fi
}

logs() {
  if [ ! -f "$LOG_FILE" ]; then
    echo -e "${YELLOW}⚠ 日志文件不存在${NC}"
    return 1
  fi
  # 默认显示最近 50 行，支持传入行数参数
  local lines=${1:-50}
  echo -e "${GREEN}📋 最近 ${lines} 行日志 ($LOG_FILE):${NC}"
  echo "----------------------------------------"
  tail -n "$lines" "$LOG_FILE"
}

# 主入口
case "${1}" in
  start)
    start
    ;;
  stop)
    stop
    ;;
  restart)
    restart
    ;;
  status)
    status
    ;;
  logs)
    logs "$2"
    ;;
  *)
    echo "用法: $0 {start|stop|restart|status|logs [行数]}"
    echo ""
    echo "  start    启动服务（后台运行）"
    echo "  stop     停止服务"
    echo "  restart  重启服务"
    echo "  status   查看服务状态"
    echo "  logs     查看日志（默认 50 行）"
    exit 1
    ;;
esac
