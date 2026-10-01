/**
 * 孤儿进程清理自保护 —— 用真实进程表复现 2026-10-01 的事故形态：
 * launchd → /bin/zsh -lic（PPID=1，命令行含 node，cwd 在 WebTmux 项目里）→ node server/index.js → caffeinate / tmux attach
 * 删除工作目录为 WebTmux 的会话时，外壳 zsh 被当成孤儿，连带整个服务被杀。
 *
 * 这里起一个同形态的进程链（sh 外壳 → node「服务」→ sleep 子进程），以「服务」为 self 求保护集，
 * 要求外壳、服务、子进程全在里面；与它无关的兄弟进程不在里面（保护不能变成「什么都不杀」）。
 */
import { spawn, execSync } from 'child_process';
import { protectedPids } from '../server/services/orphanGuard.js';

let pass = 0, fail = 0;
const check = (name, cond, detail) => { if (cond) { pass++; console.log(`✅ ${name}`); } else { fail++; console.log(`❌ ${name}\n    ${detail}`); } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function snapshot() {
  const processMap = new Map(), childrenMap = new Map();
  for (const line of execSync('ps -eo pid,ppid,comm', { encoding: 'utf-8' }).trim().split('\n').slice(1)) {
    const [pid, ppid] = line.trim().split(/\s+/);
    processMap.set(pid, { ppid });
    if (!childrenMap.has(ppid)) childrenMap.set(ppid, []);
    childrenMap.get(ppid).push(pid);
  }
  return { processMap, childrenMap };
}

// 外壳 sh 起「服务」node，node 再起一个 sleep；另起一个无关的 sleep 做对照
const shell = spawn('/bin/sh', ['-c', `exec 3>&1; node -e "require('child_process').spawn('sleep',['30'],{stdio:'ignore'}); console.log(process.pid); setTimeout(()=>{},30000)"`], { stdio: ['ignore', 'pipe', 'ignore'] });
const servicePid = await new Promise((r) => shell.stdout.once('data', (d) => r(String(d).trim())));
const bystander = spawn('sleep', ['30'], { stdio: 'ignore' });
await wait(500);

const { processMap, childrenMap } = snapshot();
const keep = protectedPids(servicePid, processMap, childrenMap);
const kids = childrenMap.get(servicePid) || [];
check('服务进程自身受保护', keep.has(servicePid), `servicePid=${servicePid}`);
check('外壳（服务的父进程，事故里被杀的 zsh 那一层）受保护', keep.has(String(shell.pid)), `shell=${shell.pid} keep=${[...keep]}`);
check('服务的子进程（caffeinate / tmux attach 那一层）受保护', kids.length > 0 && kids.every((k) => keep.has(k)), `kids=${kids}`);
check('无关进程不受保护（否则清理功能形同虚设）', !keep.has(String(bystander.pid)), `bystander=${bystander.pid}`);
check('init/launchd（pid 1）不在保护集里', !keep.has('1'), [...keep].join(','));

for (const p of [...kids, servicePid]) { try { process.kill(Number(p)); } catch {} }
shell.kill(); bystander.kill();
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);
