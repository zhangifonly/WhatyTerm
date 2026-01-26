FROM node:20-slim

WORKDIR /app

# 安装构建依赖
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

# 复制 package.json
COPY package.json ./

# 安装依赖
RUN npm install --production

# 复制源代码
COPY . .

# 创建数据目录
RUN mkdir -p /app/data

# 暴露端口
EXPOSE 3100

# 启动命令
CMD ["node", "server.js"]
