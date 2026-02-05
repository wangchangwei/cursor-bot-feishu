# 使用 Node.js 20 LTS 版本作为基础镜像
FROM node:20-alpine

# 设置工作目录
WORKDIR /app

# 安装 ripgrep（用于代码搜索功能）
RUN apk add --no-cache ripgrep

# 复制 package.json 和 package-lock.json
COPY package*.json ./

# 安装依赖
RUN npm ci --only=production

# 复制应用代码
COPY . .

# 暴露端口（API 服务端口）
EXPOSE 3456

# 设置环境变量默认值
ENV NODE_ENV=production
ENV API_PORT=3456

# 启动应用
CMD ["node", "index.js"]
