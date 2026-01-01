/**
 * MuxSessionAdapter 测试
 */

import { muxAdapter, MuxSessionAdapter } from './mux-session-adapter';

async function runTests(): Promise<void> {
  console.log('=== MuxSessionAdapter Tests ===\n');

  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => boolean | Promise<boolean>): Promise<void> {
    try {
      const result = await fn();
      if (result) {
        console.log(`✓ ${name}`);
        passed++;
      } else {
        console.log(`✗ ${name}`);
        failed++;
      }
    } catch (err: any) {
      console.log(`✗ ${name}: ${err.message}`);
      failed++;
    }
  }

  // Test 1: 初始化
  await test('MuxSessionAdapter initialization', () => {
    muxAdapter.initialize();
    return muxAdapter.isInitialized() && muxAdapter.getMux() !== null;
  });

  // Test 2: 创建会话
  let session: any = null;
  await test('Create session', async () => {
    session = await muxAdapter.createSession({
      name: 'test-session',
      cols: 80,
      rows: 24,
    });
    return session !== null && session.id.startsWith('mux-');
  });

  // Test 3: 获取会话
  await test('Get session by id', () => {
    if (!session) return false;
    const retrieved = muxAdapter.getSession(session.id);
    return retrieved === session;
  });

  // Test 4: 获取会话通过 PaneId
  await test('Get session by paneId', () => {
    if (!session) return false;
    const retrieved = muxAdapter.getSessionByPaneId(session.getPaneId());
    return retrieved === session;
  });

  // Test 5: 列出会话
  await test('List sessions', () => {
    const sessions = muxAdapter.listSessions();
    return sessions.length === 1 && sessions[0].name === 'test-session';
  });

  // Test 6: 会话写入（不会抛出错误）
  await test('Session write', () => {
    if (!session) return false;
    try {
      session.write('echo hello\r');
      return true;
    } catch {
      return false;
    }
  });

  // Test 7: 会话调整大小
  await test('Session resize', () => {
    if (!session) return false;
    try {
      session.resize(120, 40);
      return true;
    } catch {
      return false;
    }
  });

  // Test 8: 输出回调
  await test('Output callback registration', () => {
    if (!session) return false;
    let called = false;
    const callback = () => { called = true; };
    session.onOutput(callback);
    session.offOutput(callback);
    return true; // 只测试注册/注销不抛错
  });

  // Test 9: 删除会话
  await test('Delete session', () => {
    if (!session) return false;
    const result = muxAdapter.deleteSession(session.id);
    const sessions = muxAdapter.listSessions();
    return result === true && sessions.length === 0;
  });

  // Test 10: 关闭适配器
  await test('Shutdown adapter', () => {
    muxAdapter.shutdown();
    return !muxAdapter.isInitialized() && muxAdapter.getMux() === null;
  });

  // Summary
  console.log(`\n=== Test Results ===`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total: ${passed + failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

// Run tests
runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
