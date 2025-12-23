import { AIEngine } from './server/services/AIEngine.js';

const aiEngine = new AIEngine();

// 测试用例
const testCases = [
  {
    name: '程序运行中 - esc to interrupt',
    content: 'Running task... esc to interrupt\n2m 30s',
    expected: { needsAction: false, currentState: '程序运行中' }
  },
  {
    name: 'Claude Code确认界面',
    content: 'Do you want to make this edit?\n1. Yes\n2. Yes, allow for this session\n3. Type here',
    expected: { needsAction: true, actionType: 'select', suggestedAction: '2' }
  },
  {
    name: '普通确认界面',
    content: 'Do you want to proceed?\n1. Yes\n2. Type here...',
    expected: { needsAction: true, actionType: 'select', suggestedAction: '1' }
  },
  {
    name: 'Y/N确认 - 默认Yes',
    content: 'Continue? [Y/n]',
    expected: { needsAction: true, actionType: 'confirm', suggestedAction: 'y' }
  },
  {
    name: 'Y/N确认 - 默认No',
    content: 'Delete file? [y/N]',
    expected: { needsAction: true, actionType: 'confirm', suggestedAction: 'n' }
  },
  {
    name: '致命错误',
    content: 'Fatal error: Cannot continue\nError: System crashed',
    expected: { needsAction: true, actionType: 'text_input', suggestedAction: '/quit' }
  },
  {
    name: 'Shell命令行',
    content: '$ ',
    expected: { needsAction: true, actionType: 'shell_command', suggestedAction: 'claude -c' }
  },
  {
    name: '部署阶段',
    content: 'npm run dev\nServer running on localhost:3000',
    expected: { needsAction: false, currentState: '部署/脚本阶段' }
  },
  {
    name: '质量调查',
    content: 'How did Claude do?\nRate response: 1-5',
    expected: { needsAction: false, currentState: '质量调查界面' }
  },
  {
    name: '空内容',
    content: '',
    expected: { needsAction: false, currentState: '终端内容为空' }
  }
];

console.log('开始测试预判断逻辑...\n');

let passed = 0;
let failed = 0;

for (const testCase of testCases) {
  const result = aiEngine.preAnalyzeStatus(testCase.content);

  let success = true;
  const errors = [];

  if (result === null) {
    success = false;
    errors.push('返回null，应该返回预判断结果');
  } else {
    if (testCase.expected.needsAction !== undefined && result.needsAction !== testCase.expected.needsAction) {
      success = false;
      errors.push(`needsAction: 期望 ${testCase.expected.needsAction}, 实际 ${result.needsAction}`);
    }
    if (testCase.expected.actionType !== undefined && result.actionType !== testCase.expected.actionType) {
      success = false;
      errors.push(`actionType: 期望 ${testCase.expected.actionType}, 实际 ${result.actionType}`);
    }
    if (testCase.expected.suggestedAction !== undefined && result.suggestedAction !== testCase.expected.suggestedAction) {
      success = false;
      errors.push(`suggestedAction: 期望 ${testCase.expected.suggestedAction}, 实际 ${result.suggestedAction}`);
    }
    if (testCase.expected.currentState !== undefined && result.currentState !== testCase.expected.currentState) {
      success = false;
      errors.push(`currentState: 期望 ${testCase.expected.currentState}, 实际 ${result.currentState}`);
    }
  }

  if (success) {
    console.log(`✅ ${testCase.name}`);
    passed++;
  } else {
    console.log(`❌ ${testCase.name}`);
    errors.forEach(err => console.log(`   ${err}`));
    failed++;
  }
}

console.log(`\n测试完成: ${passed} 通过, ${failed} 失败`);

if (failed === 0) {
  console.log('\n🎉 所有测试通过！');
  process.exit(0);
} else {
  console.log('\n⚠️  部分测试失败，请检查逻辑');
  process.exit(1);
}
