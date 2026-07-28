// pm2 配置：从 /root/wx-relay/.env 读环境变量（凭据不进 git）
// ⚠️ env 在 config 加载时从文件读取，pm2 delete+start 不会丢（吸取 mbti-api 教训）
const fs = require('fs');
const env = {};
try {
  fs.readFileSync('/root/wx-relay/.env', 'utf8').split('\n').forEach((l) => {
    const m = l.match(/^\s*(\w+)\s*=\s*(.*)\s*$/);
    if (m && !l.trim().startsWith('#')) env[m[1]] = m[2];
  });
} catch (e) {
  console.error('[wx-relay] 读取 .env 失败:', e.message);
}

module.exports = {
  apps: [{
    name: 'wx-relay',
    script: 'server.js',
    cwd: '/root/wx-relay',
    env,
    max_memory_restart: '100M',
    autorestart: true,
  }],
};
