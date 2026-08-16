/**
 * AI 状态判定回归测试
 *
 * 样本来自 tests/fixtures/screens/*.txt —— 用 `tmux capture-pane -p -e` 抓的真实屏幕，
 * 刻意保留 ANSI（生产抓屏同样带 -e，v1.2.46 的 ANSI 膨胀故障就出在这里）。
 *
 * 覆盖两层：
 *   1. preAnalyzeStatus —— 本地正则层，约 90% 的监控决策由它做出，不花 API
 *   2. _parseStatusResponse —— AI 返回文本的解析层
 *
 * 运行：node tests/test-ai-status-parse.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, 'fixtures/screens');

const results = { passed: 0, failed: 0, errors: [] };

function test(name, fn) {
  try {
    fn();
    results.passed++;
    console.log(`✅ ${name}`);
  } catch (err) {
    results.failed++;
    results.errors.push({ name, error: err.message });
    console.log(`❌ ${name}: ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/**
 * 期望值表：每个样本一行
 *   needsAction  期望是否需要操作；null = 期望 preAnalyze 无法判断（交给 AI）
 *   actionType   期望动作类型
 *   action       期望具体动作
 *   note         这个样本在测什么
 */
const EXPECTATIONS = {
  // ---- 确认菜单：必须识别并选对选项 ----
  'confirm-proceed-eca0a648.txt': {
    needsAction: true, actionType: 'select', action: '1',
    note: '普通确认框（1.Yes / 2.No）→ 选 1'
  },
  'live-ee326d97.txt': {
    needsAction: true, actionType: 'select', action: '1',
    note: 'Parse error 后的确认框 → 选 1'
  },
  'whatyterm-ee326d97.txt': {
    needsAction: true, actionType: 'select', action: '1',
    note: '同上（另一次抓屏）'
  },
  'whatyterm-710b4468.txt': {
    needsAction: true, actionType: 'select', action: '1',
    note: "选项2是「don't ask again for similar commands」= 永久放行，必须选 1 而非 2"
  },
  'live-710b4468.txt': {
    needsAction: true, actionType: 'select', action: '1',
    note: '同上（另一次抓屏）'
  },

  // ---- 运行中：绝对不能打断 ----
  'whatyterm-1eb15796.txt': {
    needsAction: false, actionType: 'none',
    note: '✢ Finagling… (7m 31s) 计时器 + esc to interrupt'
  },
  'whatyterm-847b70b7.txt': {
    needsAction: false, actionType: 'none',
    note: 'esc to interrupt（auto mode）'
  },
  'whatyterm-a197e3d3.txt': {
    needsAction: false, actionType: 'none',
    note: '· Stewing… (5m 18s) + esc to interrupt'
  },
  'whatyterm-b9ef6f26.txt': {
    needsAction: false, actionType: 'none',
    note: '✽ Skedaddling… almost done thinking'
  },
  'whatyterm-eca0a648.txt': {
    needsAction: false, actionType: 'none',
    note: 'accept edits on + esc to interrupt，无计时器'
  },
  'whatyterm-6904990a.txt': {
    needsAction: false, actionType: 'none',
    note: '✶ Composing… (13h 26m 12s) —— U+2026 省略号 + 小时级时长，两者原正则都不认'
  },
  'whatyterm-94aa58d6.txt': {
    needsAction: false, actionType: 'none',
    note: '✢ Wibbling… (25m 24s) 压缩中'
  },
  'whatyterm-f4496549.txt': {
    needsAction: false, actionType: 'none',
    note: '✽ Embellishing… (4m 32s) + 1% until auto-compact'
  },
};

// ---- 空闲 / 完成：可以发"继续"推进 ----
const IDLE_FIXTURES = {
  'whatyterm-38d34579.txt': '✻ Baked for 1m 53s（过去式=完成）',
  'whatyterm-4234334b.txt': '✻ Worked for 8m 3s',
  'whatyterm-5f2353ad.txt': '✻ Sautéed for 4m 36s（含重音字符）',
  'whatyterm-9e66c2f8.txt': '✻ Churned for 3m 50s',
  'whatyterm-b7d80d07.txt': '✻ Churned for 2m 31s',
  'whatyterm-d660315f.txt': '✻ Cogitated for 1m 12s',
  'whatyterm-fca2bfbb.txt': '✻ Cooked for 2m 8s',
  'whatyterm-e0e95cf7.txt': 'Settings dialog dismissed 后空闲',
};
for (const [f, note] of Object.entries(IDLE_FIXTURES)) {
  EXPECTATIONS[f] = { needsAction: true, actionType: 'text_input', action: '继续', note };
}

// ---- 边界样本：preAnalyze 不该硬判，交给 AI ----
const DEFER_FIXTURES = {
  'whatyterm-4258a341.txt': 'Claude Code 刚启动的欢迎屏（manual mode），无历史可判',
  'whatyterm-6b679c22.txt': 'Grok CLI 的隐私政策 Opt-in 提示，非确认菜单',
};
for (const [f, note] of Object.entries(DEFER_FIXTURES)) {
  EXPECTATIONS[f] = { needsAction: null, note };
}

// ---- 特殊样本：API 错误 / 上下文超长 ----
EXPECTATIONS['whatyterm-85a5e4a6.txt'] = {
  needsAction: false, actionType: 'none',
  note: '504 · Retrying in 31s · attempt 8/10 —— CLI 自己在重试，且 esc to interrupt 仍在，不能插话'
};
EXPECTATIONS['whatyterm-a763d83a.txt'] = {
  needsAction: true, actionType: 'text_input', action: '继续',
  note: 'Cogitated for 4m 6s · 1 shell still running —— 有后台 shell 但无「等通知」措辞，仍可推进'
};
EXPECTATIONS['whatyterm-81dfe7f2.txt'] = {
  needsAction: true, actionTypeAnyOf: ['text_input'],
  note: '400 Input is too long + /compact 也失败 + 100% context —— 发"继续"无用，属已知待改进项'
};

// ============ 执行 ============

console.log('\n=== AI 状态判定回归测试 ===\n');

const { AIEngine, STATUS_TOOL, buildStatusPrompt } = await import('../server/services/AIEngine.js');
const engine = new AIEngine();
// 插件管理器是异步加载的，等它就位再跑（否则插件层判定缺失）
await new Promise(r => setTimeout(r, 1500));

console.log('--- preAnalyzeStatus（本地正则层）---');

const fixtures = fs.readdirSync(FIXTURE_DIR).filter(f => f.endsWith('.txt')).sort();

test(`样本目录非空（${fixtures.length} 个）`, () => {
  assert(fixtures.length > 0, 'fixtures/screens 下没有样本');
});

for (const file of fixtures) {
  const exp = EXPECTATIONS[file];
  if (!exp) {
    console.log(`⏭️  ${file}（未标注期望值，跳过）`);
    continue;
  }
  test(`${file} — ${exp.note}`, () => {
    const screen = fs.readFileSync(path.join(FIXTURE_DIR, file), 'utf8');
    // tmuxSession 传 null：避免 ProcessDetector 去查不存在的 tmux 会话
    const r = engine.preAnalyzeStatus(screen, 'claude', null, null, null);

    if (exp.needsAction === null) {
      assert(r === null || r === undefined,
        `期望 preAnalyze 放弃判断（返回 null），实际 needsAction=${r?.needsAction} actionType=${r?.actionType} action=${JSON.stringify(r?.suggestedAction)}`);
      return;
    }

    assert(r, '期望有判定结果，实际返回 null');
    assert(r.needsAction === exp.needsAction,
      `needsAction 期望 ${exp.needsAction}，实际 ${r.needsAction}（state=${r.currentState}）`);

    if (exp.actionType) {
      assert(r.actionType === exp.actionType,
        `actionType 期望 ${exp.actionType}，实际 ${r.actionType}`);
    }
    if (exp.actionTypeAnyOf) {
      assert(exp.actionTypeAnyOf.includes(r.actionType),
        `actionType 期望属于 ${exp.actionTypeAnyOf.join('/')}，实际 ${r.actionType}`);
    }
    if (exp.action !== undefined) {
      assert(r.suggestedAction === exp.action,
        `suggestedAction 期望 ${JSON.stringify(exp.action)}，实际 ${JSON.stringify(r.suggestedAction)}`);
    }
  });
}

console.log('\n--- _parseStatusResponse（AI 回复解析层）---');

const PARSE_CASES = [
  {
    name: '裸 JSON',
    input: '{"currentState":"空闲","needsAction":true,"actionType":"text_input","suggestedAction":"继续"}',
    expect: { needsAction: true, actionType: 'text_input', suggestedAction: '继续' }
  },
  {
    name: 'markdown 代码块包裹',
    input: '```json\n{"currentState":"运行中","needsAction":false,"actionType":"none"}\n```',
    expect: { needsAction: false, actionType: 'none' }
  },
  {
    name: '前后带解释文字',
    input: '分析如下：\n{"currentState":"确认界面","needsAction":true,"actionType":"select","suggestedAction":"2"}\n以上。',
    expect: { needsAction: true, actionType: 'select', suggestedAction: '2' }
  },
  {
    name: '嵌套对象（考验括号配平）',
    input: '{"currentState":"x","needsAction":true,"actionType":"select","suggestedAction":"1","meta":{"a":{"b":1}}}',
    expect: { needsAction: true, actionType: 'select', suggestedAction: '1' }
  },
  {
    name: '缺字段时给默认值',
    input: '{"needsAction":false}',
    expect: { needsAction: false, actionType: 'none', currentState: '未知状态' }
  },
];

for (const c of PARSE_CASES) {
  test(`解析：${c.name}`, () => {
    const r = engine._parseStatusResponse(c.input);
    assert(r, '解析返回 null');
    for (const [k, v] of Object.entries(c.expect)) {
      assert(r[k] === v, `${k} 期望 ${JSON.stringify(v)}，实际 ${JSON.stringify(r[k])}`);
    }
  });
}

test('解析：完全非 JSON 时不抛异常', () => {
  const r = engine._parseStatusResponse('抱歉，我无法分析这段内容。');
  assert(r === null || typeof r === 'object', '应返回 null 或对象，不应抛异常');
});

// ============ 确认菜单选项语义：选 1 还是选 2 取决于选项 2 是什么 ============
// 三种情况必须区分开，弄错的后果各不相同：
//   "2. Yes, allow for this session"      → 选 2（省掉后续重复确认）
//   "2. Yes, and don't ask again for ..." → 选 1（选 2 会给整类命令永久免确认，安全问题）
//   "2. No"                               → 选 1（选 2 是拒绝执行，直接把任务否掉）
test('确认菜单：选项 2 的语义决定选 1 还是选 2', () => {
  const strip = s => s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
  let checked = 0;
  for (const f of fs.readdirSync(FIXTURE_DIR)) {
    const raw = fs.readFileSync(path.join(FIXTURE_DIR, f), 'utf8');
    const clean = strip(raw);
    if (!/Do you want/i.test(clean)) continue;
    const r = engine.preAnalyzeStatus(raw, 'claude', null, null, null);
    if (r?.actionType !== 'select') continue;
    checked++;

    const isPermanent = /2\.\s*Yes,\s*and\s+don.t\s+ask\s+again\s+for\b/i.test(clean);
    const isOption2Yes = /2\.\s*Yes/i.test(clean);

    if (isPermanent) {
      assert(r.suggestedAction === '1',
        `${f}: 选项 2 是永久允许，必须选 1，实际选了 ${r.suggestedAction}`);
    } else if (isOption2Yes) {
      assert(r.suggestedAction === '2',
        `${f}: 选项 2 是"允许本次会话"，应选 2，实际选了 ${r.suggestedAction}`);
    } else {
      // 选项 2 是 No 之类的否定项，选 2 等于拒绝执行
      assert(r.suggestedAction === '1',
        `${f}: 选项 2 非 Yes（如 "2. No"），必须选 1，实际选了 ${r.suggestedAction}`);
    }
  }
  assert(checked >= 4, `确认类样本太少（${checked}），覆盖不足`);
});

// ============ 第三层：结构化输出（tool_use）契约 ============
// 只验 schema 与下游的对接，不发真实网络请求。

test('schema：enum 覆盖下游所有 actionType 分支', () => {
  const en = STATUS_TOOL.input_schema.properties.actionType.enum;
  // 下游 server/index.js + AIEngine 实际会判的值，缺一个模型就只能凑数
  for (const v of ['select', 'text_input', 'single_char', 'suggestion', 'warning', 'none']) {
    assert(en.includes(v), `enum 缺少下游会用到的值 "${v}"`);
  }
});

test('schema：不含联合类型（部分中转站校验会 400）', () => {
  for (const [k, p] of Object.entries(STATUS_TOOL.input_schema.properties)) {
    assert(!Array.isArray(p.type), `${k} 用了联合类型 ${JSON.stringify(p.type)}`);
  }
});

test('schema：必填项与解析层的必需字段一致', () => {
  const req = STATUS_TOOL.input_schema.required;
  for (const k of ['currentState', 'needsAction', 'actionType']) {
    assert(req.includes(k), `required 缺少 ${k}`);
  }
});

test('结构化结果（空串表达"无动作"）能被解析层正确归一', () => {
  // 模拟 tool_use 的 input 被 JSON.stringify 后交给解析层
  const toolInput = {
    currentState: '运行中', workingDir: '未显示', recentAction: 'npm test',
    needsAction: false, actionType: 'none',
    suggestedAction: '', actionReason: '', suggestion: ''
  };
  const r = engine._parseStatusResponse(JSON.stringify(toolInput));
  assert(r, '解析返回 null');
  assert(r.needsAction === false, `needsAction 应为 false，实际 ${r.needsAction}`);
  assert(r.actionType === 'none', `actionType 应为 none，实际 ${r.actionType}`);
  // 空串必须归一成 null，否则下游 `action.length > 1` 之类的判定会拿到空串
  assert(r.suggestedAction === null, `空串应归一为 null，实际 ${JSON.stringify(r.suggestedAction)}`);
  assert(r.suggestion === null, `空串应归一为 null，实际 ${JSON.stringify(r.suggestion)}`);
});

test('max_tokens 兜底不低于 1024（原 500 会截断 JSON）', () => {
  const src = fs.readFileSync(path.join(__dirname, '../server/services/AIEngine.js'), 'utf8');
  assert(/max_tokens:\s*Math\.max\(this\.settings\.maxTokens\s*\|\|\s*0,\s*1024\)/.test(src),
    '未找到 max_tokens 的 1024 兜底');
});

// ============ 提示词契约：提示词是判定逻辑的载体，必须能回归 ============
const PROMPT = buildStatusPrompt({
  cliName: 'Claude Code',
  cliCommand: 'claude -c',
  terminalContent: 'FIXTURE_BODY_MARKER',
  progressContext: 'PROGRESS_MARKER'
});

test('提示词：变量全部插值，终端内容与进度上下文都在', () => {
  assert(!/\$\{/.test(PROMPT), '提示词里残留未插值的 ${...}');
  assert(PROMPT.includes('FIXTURE_BODY_MARKER'), '终端内容未插入');
  assert(PROMPT.includes('PROGRESS_MARKER'), '进度上下文未插入');
  assert(PROMPT.includes('claude -c'), 'cliCommand 未插入');
  assert(PROMPT.includes('Claude Code'), 'cliName 未插入');
});

test('提示词：空终端内容退化为 (空) 而非空白', () => {
  const p = buildStatusPrompt({ cliName: 'Claude Code', cliCommand: 'claude -c', terminalContent: '' });
  assert(p.includes('(空)'), '空内容未标记为 (空)');
});

test('提示词：确认菜单三种语义都写明，不再一律选 2', () => {
  // 生产已确认：选项 2 是"永久免确认"时选 2 属越权；是"No"时选 2 会否掉任务
  assert(/allow for this session/i.test(PROMPT), '缺少"仅本次会话"语义');
  assert(/don't ask again/i.test(PROMPT), '缺少"永久免确认"语义');
  assert(/\|\s*`?No`?\s*(或|\|)/.test(PROMPT) || /`No`/.test(PROMPT), '缺少"No"语义');
  // 旧版那句无条件"suggestedAction:\"2\""必须已被移除
  assert(!/确认界面.*suggestedAction:"2"/.test(PROMPT), '仍存在无条件选 2 的旧规则');
});

test('提示词：忙碌判据讲证据而非英文字面量', () => {
  // 计时器省略号可能是单字符 …，时长可能带小时；spinner 动词会被本地化
  assert(PROMPT.includes('…'), '未提示单字符省略号 U+2026');
  assert(/13h|小时/.test(PROMPT), '未提示小时级时长');
  assert(/不要认动词|本地化/.test(PROMPT), '未提示动词会被本地化（不可依赖英文字面量）');
});

test('提示词：明确写出代价不对称（打断 > 多等一轮）', () => {
  assert(/打断/.test(PROMPT), '未说明打断的代价');
  assert(/宁可多等|再来看/.test(PROMPT), '未给出拿不准时的倾向');
});

test('提示词：运行中提示符仍在，禁止以提示符判空闲', () => {
  assert(/依然存在|永远不能作为空闲证据/.test(PROMPT), '未警告提示符不可作为空闲证据');
  assert(/accept edits on/.test(PROMPT), '未说明 accept edits on 是常驻模式指示器');
});

test('提示词：actionType 取值不超出 schema enum', () => {
  const enumVals = STATUS_TOOL.input_schema.properties.actionType.enum;
  // 抽出提示词里 actionType:"xxx" 形式的取值，逐个比对
  const used = [...PROMPT.matchAll(/actionType:"([a-z_]+)"/g)].map(m => m[1]);
  assert(used.length > 0, '提示词里未出现任何 actionType 示例');
  for (const v of used) {
    assert(enumVals.includes(v), `提示词用了 schema 不认的 actionType: ${v}`);
  }
  // 输出说明段列出的候选同样不能越界
  const listed = (PROMPT.match(/actionType（([^）]+)）/) || [])[1];
  if (listed) {
    for (const v of listed.split('/').map(s => s.trim())) {
      assert(enumVals.includes(v), `输出说明列出了 schema 不认的 actionType: ${v}`);
    }
  }
});

test('提示词：仍保留 JSON 输出要求（非 Claude 供应商无 tool_use 可用）', () => {
  assert(/只输出 JSON|以 \{ 开头/.test(PROMPT), '缺少纯 JSON 输出要求');
  for (const f of ['currentState', 'needsAction', 'actionType', 'suggestedAction', 'workingDir']) {
    assert(PROMPT.includes(f), `输出字段说明缺 ${f}`);
  }
});

test('提示词：旧版硬编码对照表已清除', () => {
  assert(!/判断优先级（按顺序）/.test(PROMPT), '仍是旧版优先级对照表');
  assert(!/Do you want to make\/run/.test(PROMPT), '仍硬编码确认界面英文原文');
});

console.log(`\n=== 结果：${results.passed} 通过 / ${results.failed} 失败 ===`);
if (results.failed > 0) {
  console.log('\n失败明细：');
  for (const e of results.errors) console.log(`  • ${e.name}\n    ${e.error}`);
}
process.exit(results.failed > 0 ? 1 : 0);

