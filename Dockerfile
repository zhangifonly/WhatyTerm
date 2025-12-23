FROM node:20-slim

# 安装 tmux 和编译依赖
RUN apt-get update && apt-get install -y \
    tmux \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 复制 package.json 先安装依赖（利用缓存）
COPY package*.json ./
RUN npm install

# 复制源码
COPY . .

# 构建前端
RUN npm run build

# 创建数据目录
RUN mkdir -p /app/server/db

EXPOSE 3000

CMD ["npm", "start"]
