/**
 * 开发机 launchd 守护：生成的配置能被系统接受，异常退出会被拉起，且配置里不含任何环境变量（密钥）。
 *
 * 由来（2026-09-26）：服务随 Claude 会话 /exit 被 SIGKILL，没人重拉。当时服务的环境里有
 * CODEX_API_KEY 等 4 个密钥类变量 —— 照抄进 plist 就是把密钥明文写进 ~/Library/LaunchAgents。
 *
 * 运行: node tests/test-service-launchd.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';

let pass = 0, fail = 0;
const test = (name, fn) => { try { fn(); pass++; console.log(`✅ ${name}`); } catch (e) { fail++; console.log(`❌ ${name}\n    ${e.message}`); } };
const assert = (c, m) => { if (!c) throw new Error(m || '断言失败'); };
if (process.platform !== 'darwin') { console.log('⏭ 非 macOS，跳过'); process.exit(0); }

const SCRIPT = new URL('../scripts/webtmux-service.sh', import.meta.url).pathname;
const REPO = path.resolve(path.dirname(SCRIPT), '..');
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'svc-')), 'x.plist');
execFileSync('bash', [SCRIPT, 'plist', out], { env: { ...process.env, CODEX_API_KEY: 'sk-should-not-leak' } });
const raw = fs.readFileSync(out, 'utf8');
const cfg = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', out]).toString());

test('配置能被系统解析；zsh 保持为父进程（不 exec）、node 作子进程，停止信号转发给 node、退出码原样返回', () => {
  const [sh, flag, script] = cfg.ProgramArguments;
  assert(sh === '/bin/zsh' && flag === '-lic', JSON.stringify(cfg.ProgramArguments));
  // TCC 按「负责进程」判定：exec 成 node 后负责进程变成 node，授权给 zsh 就覆盖不到了
  assert(!/exec node/.test(script), '又 exec 成 node 了');
  assert(script.includes(`cd '${REPO}'`) && /node server\/index\.js &/.test(script), script);
  assert(/trap 'kill -TERM \$pid 2>\/dev\/null' TERM INT HUP/.test(script), '停止信号没转发给 node（交互 zsh 默认忽略 SIGTERM）');
  assert(/exit \$rc$/.test(script.trim()), '退出码没原样交给 launchd（被强杀后就不会重拉）');
});

test('信号实测：停止时转发给 node、zsh 以 0 退出；node 被强杀时 zsh 以 137 退出（launchd 据此重拉）', () => {
  const script = cfg.ProgramArguments[2].replace(`cd '${REPO}' || exit 78`, 'cd /tmp')
    .replace('node server/index.js &', 'node -e "process.on(\\"SIGTERM\\",()=>process.exit(0));setInterval(()=>{},1000)" &');
  // 替身的输出不接到测试管道上、结束时强制清理、整体限时：转发坏掉时 node 会一直活着，不能把测试卡死
  const run = (sig, target) => execFileSync('/bin/zsh', ['-c', `/bin/zsh -c '${script.replace(/'/g, "'\\''")}' >/dev/null 2>&1 & Z=$!; sleep 1.5;
    C=$(pgrep -P $Z node); kill -${sig} ${target}; ( sleep 5; kill -9 $Z $C 2>/dev/null ) & W=$!; wait $Z; rc=$?; kill -9 $C $W 2>/dev/null; echo $rc`],
    { timeout: 20000 }).toString().trim();
  assert(run('TERM', '$Z') === '0', '正常停止没转发或退出码不是 0');
  assert(run('KILL', '$C') === '137', 'node 被强杀后 zsh 没以非 0 退出，launchd 不会重拉');
});

test('异常退出才重拉（SuccessfulExit=false），有节流，登录即启动，不被当后台任务限速', () => {
  assert(cfg.KeepAlive?.SuccessfulExit === false && cfg.RunAtLoad === true && cfg.ThrottleInterval >= 5, JSON.stringify(cfg));
  assert(cfg.ProcessType !== 'Background', '后台类型会被系统限速');
});

test('配置里不写任何环境变量 —— 密钥不落盘（环境来自 ~/.zshrc）', () => {
  assert(!('EnvironmentVariables' in cfg), '写了 EnvironmentVariables');
  assert(!/sk-should-not-leak|API_KEY|TOKEN|PROXY/i.test(raw), '配置文件里出现了环境变量内容');
});

test('安装前的保护：先预检再停服务；起不来自动回滚；端口被别的程序占用不动它；有长程执行者在跑默认不切', () => {
  const s = fs.readFileSync(SCRIPT, 'utf8');
  const inst = s.slice(s.indexOf('cmd_install() {'), s.indexOf('cmd_restart() {'));
  assert(inst.indexOf('cmd_preflight || exit 1') >= 0 && inst.indexOf('cmd_preflight || exit 1') < inst.indexOf('kill -TERM'),
    '停旧服务之前没做预检（上次就是先停服务、新的起不来，机器没了服务）');
  assert(/launchctl bootout[\s\S]{0,80}start_manual/.test(inst.slice(inst.indexOf('else'))), '起不来时没回滚拉回服务');
  assert(/\[ "\$cwd" = "\$REPO" \] \|\| \{ echo .*不动它/.test(s), '没核对占端口的是不是本项目服务');
  assert(/claude \.\*\(-p\|--print\|stream-json\)/.test(s) && /--force/.test(s), '没检查长程执行者');
});

test('脚本里变量后面不直接跟中文（bash 会把全角字节并进变量名，set -u 下直接报 unbound variable）', () => {
  const s = fs.readFileSync(SCRIPT, 'utf8');
  const bad = s.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7f]/.test(l));
  assert(!bad.length, `第 ${bad.map(([n]) => n).join('、')} 行：改成 \${变量}`);
});

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);
