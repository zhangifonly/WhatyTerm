/**
 * 跑一次 CLI 子进程拿全部输出（claude -p / codex exec / grok -p 纯文本调用共用）。
 * 只管进程生命周期：启动失败、超时强杀、标准输入写入；输出怎么解析由各客户端决定。
 */

import { spawn } from 'child_process';

/** 内部调用的子进程环境：带长程头（hook 一律丢弃，不串到任何会话上），清掉会让 CLI 误判嵌套的变量 */
export function internalCliEnv(base = process.env, extra = {}) {
  const env = { ...base, WEBTMUX_LONGRUN: '1', ...extra };
  for (const k of ['CLAUDECODE', 'TMUX', 'TMUX_PANE']) delete env[k];
  return env;
}

/**
 * @param {object} o
 * @param {string} o.label      报错用的名字，如 "claude CLI"
 * @param {string} o.bin
 * @param {string[]} o.args
 * @param {string} o.cwd
 * @param {object} o.env
 * @param {string} [o.stdin]    写入标准输入的内容（提示词不进命令行参数）
 * @param {number} o.timeoutMs
 * @returns {Promise<{code: number|null, out: string, err: string}>}  启动失败或超时 reject
 */
export function runCli({ label, bin, args, cwd, env, stdin = '', timeoutMs }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v); };
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      finish(reject, new Error(`${label} 超过 ${Math.round(timeoutMs / 1000)} 秒没有返回`));
    }, timeoutMs);
    proc.stdout.on('data', (b) => { out += b; });
    proc.stderr.on('data', (b) => { err += b; });
    proc.on('error', (e) => finish(reject, new Error(`无法启动 ${label}: ${e.message}`)));
    proc.on('close', (code) => finish(resolve, { code, out, err }));
    proc.stdin.on('error', () => {});
    proc.stdin.end(stdin);
  });
}
