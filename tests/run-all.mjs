/**
 * 统一测试入口：node tests/run-all.mjs（即 npm test）。
 * - 逐文件子进程运行，退出码汇总（v1.2.82 起各文件失败已正确置码）
 * - 每文件 60s 超时兜底（防挂起测试卡死跑批）
 * - SKIP 名单：需要真实服务器/网络环境的文件
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKIP = new Set([
  'test-api-endpoints.mjs',   // 需要运行中的服务器，长期挂起
  'test-core-services.mjs',   // 同上
  'run-all.mjs'
]);

const files = fs.readdirSync(__dirname)
  .filter(f => f.endsWith('.mjs') && !SKIP.has(f))
  .sort();

let failed = 0;
const t0 = Date.now();
for (const f of files) {
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], {
    cwd: path.join(__dirname, '..'),   // 各测试按仓库根目录相对路径读源码
    timeout: 60 * 1000,
    encoding: 'utf-8'
  });
  const ok = r.status === 0 && !r.error;
  if (ok) {
    console.log(`PASS ${f}`);
  } else {
    failed++;
    const why = r.error ? r.error.message : `exit=${r.status}`;
    console.log(`FAIL ${f} (${why})`);
    const tail = `${r.stdout || ''}\n${r.stderr || ''}`.split('\n')
      .filter(Boolean).slice(-10);
    for (const line of tail) console.log(`     ${line}`);
  }
}
console.log(`\n${files.length} 个文件，失败 ${failed}，跳过 ${SKIP.size - 1}，耗时 ${Math.round((Date.now() - t0) / 1000)}s`);
process.exit(failed ? 1 : 0);
