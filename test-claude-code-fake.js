/**
 * 伪装 Claude Code 请求测试脚本
 * 测试是否能绕过 Claude Relay Service 的客户端限制
 */

import crypto from 'crypto';

// crs.whaty.org 配置（设置了 Claude Code Only 限制）
const CONFIG = {
  baseUrl: 'https://crs.whaty.org/api',
  token: 'REDACTED_API_TOKEN',
  model: 'claude-sonnet-4-20250514'
};

// Claude Code 系统提示词（短版本）
const CLAUDE_CODE_SYSTEM_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude.";

// 生成符合格式的 user_id
function generateUserId() {
  const hash = crypto.randomBytes(32).toString('hex'); // 64位十六进制
  const sessionId = crypto.randomUUID();
  return `user_${hash}_account__session_${sessionId}`;
}

// 伪装 Claude Code 请求
async function testFakeClaudeCodeRequest() {
  const userId = generateUserId();

  const requestBody = {
    model: CONFIG.model,
    max_tokens: 1024,
    system: [
      {
        type: 'text',
        text: CLAUDE_CODE_SYSTEM_PROMPT
      }
    ],
    messages: [
      {
        role: 'user',
        content: 'Hello, just testing. Reply with "OK" only.'
      }
    ],
    metadata: {
      user_id: userId
    }
  };

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'claude-cli/2.0.69 (external, cli)',
    'x-app': 'cli',
    'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14',
    'anthropic-version': '2023-06-01',
    'Authorization': `Bearer ${CONFIG.token}`
  };

  console.log('='.repeat(60));
  console.log('伪装 Claude Code 请求测试');
  console.log('='.repeat(60));
  console.log('\n📤 请求配置:');
  console.log(`   URL: ${CONFIG.baseUrl}/v1/messages`);
  console.log(`   Model: ${CONFIG.model}`);
  console.log(`   User-Agent: ${headers['User-Agent']}`);
  console.log(`   user_id: ${userId.substring(0, 50)}...`);
  console.log('\n⏳ 发送请求...\n');

  try {
    const response = await fetch(`${CONFIG.baseUrl}/v1/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody)
    });

    const responseText = await response.text();
    let responseData;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = responseText;
    }

    console.log(`📥 响应状态: ${response.status} ${response.statusText}`);
    console.log('\n📥 响应内容:');
    console.log(JSON.stringify(responseData, null, 2));

    if (response.status === 403) {
      console.log('\n❌ 测试失败: 客户端验证被拒绝');
      if (responseData?.error?.type === 'client_validation_error') {
        console.log('   原因: Claude Code Only 限制生效');
      }
    } else if (response.status === 200) {
      console.log('\n✅ 测试成功: 伪装请求通过验证！');
    } else {
      console.log(`\n⚠️ 其他状态码: ${response.status}`);
    }

  } catch (error) {
    console.error('\n❌ 请求错误:', error.message);
  }
}

// 运行测试
testFakeClaudeCodeRequest();
