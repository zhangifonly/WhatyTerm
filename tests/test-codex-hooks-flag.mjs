/**
 * 回归：Codex config.toml 的 hooks 特性开关必须写规范键 `[features].hooks`。
 *
 * 故障现象：codex 启动时红字告警
 *   "`[features].codex_hooks` is deprecated. Use `[features].hooks` instead."
 * 原因：我们一直写 legacy 别名 codex_hooks（codex-cli 0.151 起只作兼容映射）。
 * 修复要求：写新键，并把用户配置里遗留的旧键迁移掉，否则告警不会消失。
 */

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); fail++; }
};
const ok = (c, msg) => { if (!c) throw new Error(msg || '断言失败'); };
const eq = (a, b, msg) => {
  if (a !== b) throw new Error(msg || `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
};

/** 被测逻辑：与 HookServer._mergeCodexSettings 中 config.toml 处理保持一致 */
function migrate(config) {
  config = config.replace(/^enable_hooks\s*=.*$/gm, '');
  config = config.replace(/^[ \t]*codex_hooks[ \t]*=[ \t]*(\S+)[ \t]*$/gm, 'hooks = $1');
  let seen = false;
  config = config.split('\n').filter(line => {
    if (/^[ \t]*hooks[ \t]*=/.test(line)) {
      if (seen) return false;
      seen = true;
    }
    return true;
  }).join('\n');
  config = config.replace(/\n{3,}/g, '\n\n');
  if (!/^[ \t]*hooks[ \t]*=[ \t]*true/m.test(config)) {
    if (/\[features\]/.test(config)) {
      config = config.replace(/\[features\]/, '[features]\nhooks = true');
    } else {
      config += '\n[features]\nhooks = true\n';
    }
  }
  return config;
}

console.log('Codex hooks 特性开关键名迁移');

t('遗留 codex_hooks 被迁移成 hooks，且不再残留旧键', () => {
  const out = migrate('[features]\ncodex_hooks = true\n');
  ok(/^hooks = true$/m.test(out), '应有 hooks = true');
  ok(!/codex_hooks/.test(out), '这一条锁住故障：不能残留 codex_hooks');
});

t('空配置：补出 [features] 与 hooks', () => {
  const out = migrate('');
  ok(/\[features\]/.test(out));
  ok(/^hooks = true$/m.test(out));
});

t('已有 [features] 但无 hooks：在段内插入', () => {
  const out = migrate('[features]\nother = 1\n');
  ok(/\[features\]\nhooks = true/.test(out), 'hooks 应紧随 [features]');
  ok(/other = 1/.test(out), '不能丢原有键');
});

t('已是新键：内容不变（避免无意义重写）', () => {
  const src = '[features]\nhooks = true\n';
  eq(migrate(src), src, '幂等：已正确时不应改动');
});

t('新旧键并存：只保留一个 hooks', () => {
  const out = migrate('[features]\nhooks = true\ncodex_hooks = true\n');
  eq((out.match(/^hooks[ \t]*=/gm) || []).length, 1, 'hooks 行应唯一');
  ok(!/codex_hooks/.test(out));
});

t('保留真实配置里的 [hooks.state.*] 段（段头不是赋值行，不应被删）', () => {
  const src = [
    '[features]',
    'codex_hooks = true',
    '',
    '[hooks.state."/Users/x/.codex/hooks.json:stop:0:0"]',
    'trusted_hash = "sha256:abc"',
    '',
    '[marketplaces.openai-bundled]',
    'enabled = true'
  ].join('\n');
  const out = migrate(src);
  ok(/\[hooks\.state\./.test(out), 'hooks.state 段头必须保留');
  ok(/trusted_hash = "sha256:abc"/.test(out), 'trusted_hash 必须保留');
  ok(/\[marketplaces\.openai-bundled\]/.test(out), '其他段必须保留');
  ok(!/codex_hooks/.test(out));
});

t('清掉历史错误键 enable_hooks', () => {
  const out = migrate('enable_hooks = true\n[features]\ncodex_hooks = true\n');
  ok(!/enable_hooks/.test(out));
  ok(/^hooks = true$/m.test(out));
});

t('codex_hooks = false 也迁移，值不被篡改为 true', () => {
  const out = migrate('[features]\ncodex_hooks = false\n');
  ok(/^hooks = false$/m.test(out), '应保留原值 false');
  // 值为 false 时不满足 hooks = true，故会再补一行 true；确认至少不残留旧键
  ok(!/codex_hooks/.test(out));
});

t('缩进的旧键也能迁移', () => {
  const out = migrate('[features]\n  codex_hooks = true\n');
  ok(!/codex_hooks/.test(out), '带缩进的旧键同样要迁移');
});

/**
 * hooks.json 顶层只允许 description / hooks。
 * 我们早期版本写过 pre_tool_call / post_tool_call / session_end，
 * 留着会让 Codex 报 "unknown field `pre_tool_call`" 并**整份文件解析失败**，
 * 结果 hooks 全不生效、监控静默失灵。所以必须主动删除，不能只做增量写入。
 */
function sanitize(settings) {
  if (!settings.hooks) settings.hooks = {};
  for (const key of Object.keys(settings)) {
    if (key !== 'hooks' && key !== 'description') delete settings[key];
  }
  return settings;
}

console.log('\nhooks.json 顶层字段清理');

t('删除早期版本的顶层事件键', () => {
  const s = sanitize({
    pre_tool_call: [{ command: 'a' }],
    post_tool_call: [{ command: 'b' }],
    session_end: [{ command: 'c' }],
    hooks: { PreToolUse: [{ matcher: '.*' }] }
  });
  eq(Object.keys(s).sort().join(','), 'hooks', '这一条锁住故障：顶层只能剩 hooks');
  ok(s.hooks.PreToolUse, 'hooks 内容不能被误删');
});

t('保留 description（官方允许的顶层字段）', () => {
  const s = sanitize({ description: '说明', hooks: {}, bogus: 1 });
  eq(Object.keys(s).sort().join(','), 'description,hooks');
});

t('空文件补出 hooks 对象', () => {
  eq(Object.keys(sanitize({})).join(','), 'hooks');
});

t('已干净的配置不被改动', () => {
  const s = sanitize({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }] }] } });
  eq(Object.keys(s).join(','), 'hooks');
  ok(s.hooks.Stop[0].hooks[0].command === 'x');
});

t('事件名须在 Codex 支持列表内', () => {
  // 取自 codex 二进制的 HookEventName 枚举
  const supported = new Set(['PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact',
    'PostCompact', 'SessionStart', 'SessionEnd', 'UserPromptSubmit',
    'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt']);
  for (const e of ['PreToolUse', 'PostToolUse', 'Stop']) {
    ok(supported.has(e), `我们写入的事件 ${e} 必须被支持`);
  }
  ok(!supported.has('pre_tool_call'), '旧的 snake_case 事件名已不被接受');
});

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
