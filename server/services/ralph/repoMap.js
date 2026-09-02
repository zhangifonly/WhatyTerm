/**
 * 轻量仓库地图（v1.2.86，P3-15 的 aider repo-map 简化版，不引 tree-sitter）。
 *
 * 给 Ralph 每轮上下文注入项目结构概览：目录树（限深/限量）+ package.json scripts。
 * 动机：原来上下文只有 CLAUDE.md 前 4000 字符，agent 对项目结构一无所知，
 * 每轮都要花工具调用重新摸目录；scripts 列表还是 validationCommands 的事实来源。
 */
import fs from 'fs';
import path from 'path';

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'release', 'coverage', '.next',
  '.cache', 'vendor', '__pycache__', '.venv', 'venv', 'target', 'out'
]);
const MAX_ENTRIES = 400;   // 扫描上限（防超大仓库拖慢每轮启动）
const MAX_LINES = 60;      // 输出上限

/** 生成紧凑目录树文本；失败/超限时尽力输出已收集部分 */
export function buildRepoMap(workingDir, { maxDepth = 3 } = {}) {
  if (!workingDir) return '';
  let stat;
  try { stat = fs.statSync(workingDir); } catch { return ''; }
  if (!stat.isDirectory()) return '';

  const lines = [];
  let count = 0;
  const walk = (dir, depth, prefix) => {
    if (depth > maxDepth || count >= MAX_ENTRIES || lines.length >= MAX_LINES) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    const dirs = entries.filter(e => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'));
    const files = entries.filter(e => e.isFile() && !e.name.startsWith('.'));
    // 目录优先；文件多时折叠（只报数量与代表性文件名）
    for (const d of dirs) {
      if (lines.length >= MAX_LINES) return;
      count++;
      lines.push(`${prefix}${d.name}/`);
      walk(path.join(dir, d.name), depth + 1, prefix + '  ');
    }
    if (files.length > 8 && depth > 1) {
      const names = files.slice(0, 5).map(f => f.name).join(', ');
      lines.push(`${prefix}(${files.length} 个文件: ${names} …)`);
      count += files.length;
    } else {
      for (const f of files) {
        if (lines.length >= MAX_LINES) return;
        count++;
        lines.push(`${prefix}${f.name}`);
      }
    }
  };
  walk(workingDir, 1, '');

  const parts = [];
  // package.json scripts：validationCommands 的事实来源，单列
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(workingDir, 'package.json'), 'utf-8'));
    const scripts = Object.entries(pkg.scripts || {}).slice(0, 15)
      .map(([k, v]) => `- npm run ${k}  →  ${String(v).slice(0, 80)}`);
    if (scripts.length) parts.push(`## 可用 scripts（验证命令优先从这里选）\n${scripts.join('\n')}`);
  } catch {}
  if (lines.length) {
    parts.push(`## 目录结构（深度≤${maxDepth}，已省略 node_modules 等）\n${lines.join('\n')}${lines.length >= MAX_LINES ? '\n…（已截断）' : ''}`);
  }
  return parts.length ? `# 仓库地图\n${parts.join('\n\n')}` : '';
}
