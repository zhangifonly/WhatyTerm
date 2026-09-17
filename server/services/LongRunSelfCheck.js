/**
 * 长程编排：启动自检清单（对应原版 cli_common 的 report_* 与 load_req / make_supervisor 的打印）
 *
 * 原版每条都打印到终端，理由写在各处注释里，归结为一句：**静默生效的配置一旦出错没人会发现**。
 * 这里把同样的内容收集成 [{level, group, text}]，随任务快照与 selfcheck 事件交给面板。
 * level: info | warn
 */

import { readFileSync } from 'fs';
import path from 'path';
import { PROMPT_SLOTS } from './LongRunPrompts.js';
import { available as jobguardAvailable } from './LongRunJobGuard.js';
import { refDisplay, extraDirsOf } from './LongRunLaunch.js';

const chars = (s) => [...String(s || '')].length;     // 与 Python len() 一致按码点计

export class SelfCheck {
  constructor() { this.items = []; }
  info(group, text) { this.items.push({ level: 'info', group, text }); return this; }
  warn(group, text) { this.items.push({ level: 'warn', group, text }); return this; }
  toJSON() { return this.items; }
}

/** load_prompt_set：来源 + 每段字数。 */
export function reportPrompts(sc, prompts) {
  sc.info('提示词', `提示词: ${prompts.source}`);
  for (const slot of Object.keys(PROMPT_SLOTS)) {
    sc.info('提示词', `  ${slot.padEnd(12)} ${String(chars(prompts[slot])).padStart(5)} 字`);
  }
}

/**
 * report_claude_template 的对应项（配置已拆分）：执行者专用配置、skills 授权与项目信任、MCP 放行/屏蔽、
 * 项目配置只写记忆目录（备份、relay 移走）、接管时导入的记忆、两处记忆目录实际取值。
 */
export function reportClaudeTemplate(sc, spec) {
  const g = '项目配置';
  let exec = null;
  try { exec = JSON.parse(readFileSync(spec.executorSettingsPath, 'utf8')); } catch (e) {
    sc.warn(g, `读不出执行者配置 ${spec.executorSettingsPath}: ${e.message}`);
  }
  if (exec) {
    const p = exec.permissions || {};
    sc.info(g, `执行者配置: ${spec.executorSettingsPath}（放行 ${(p.allow || []).length} 条、禁止 ${(p.deny || []).length} 条，`
      + '经 --settings 只交给执行者，同目录的终端会话不受影响）');
  }
  if (spec.skillsGranted?.length) {
    // Skill(*) 通配实测不生效，必须具名授权，且要打出来
    sc.info(g, `  skills（已具名授权）: ${spec.skillsGranted.join(', ')}`);
  }
  // 项目配置（记忆目录）要生效，前提是项目被信任
  if (spec.trustGranted) sc.info(g, '  项目信任: 已标记（项目 settings.local.json 才会被加载）');
  else sc.warn(g, '  项目未标记信任：项目 settings.local.json 不会被加载，终端会话读不到共用的记忆目录');
  // 用户级 mcpServers 是继承来的，其中有能在别的进程里跑任意代码的，不该静默生效
  if (spec.mcpAllowed?.length) sc.info(g, `  MCP（已放行）: ${spec.mcpAllowed.join(', ')}`);
  if (spec.mcpDenied?.length) sc.info(g, `  MCP（已屏蔽）: ${spec.mcpDenied.join(', ')}`);

  let project = null;
  try { project = JSON.parse(readFileSync(path.join(spec.root, '.claude', 'settings.local.json'), 'utf8')); } catch { /* 没有或读不动 */ }
  sc.info(g, `  记忆目录（执行者）: ${exec?.autoMemoryDirectory || '(未写入)'}`);
  if (project?.autoMemoryDirectory === spec.memoryDir) {
    sc.info(g, `  记忆目录（项目配置，终端会话共用）: ${project.autoMemoryDirectory}`);
  } else {
    sc.warn(g, '  项目配置没有写上记忆目录（文件读不动时不覆盖），终端会话暂时不会共用 .memory');
  }
  if (spec.projectSettingsBackup) sc.info(g, `  项目原配置已备份: ${spec.projectSettingsBackup}`);
  if (spec.relayStripped) {
    sc.warn(g, '  项目配置里的会话级 relay 地址已移走（执行者不能走别的会话的 relay）；转为终端时会重新应用该会话的供应商');
  }
  if (spec.memoryImported?.length) {
    sc.info(g, `  已从 Claude 默认记忆位置导入 ${spec.memoryImported.length} 个记忆文件（原处保留）: ${spec.memoryImported.join(', ')}`);
  }
}

/** report_jobguard：不生效必须说出来 —— 实测发生过执行者脱管续跑 30 分钟。 */
export function reportJobguard(sc) {
  if (jobguardAvailable()) sc.info('进程', '子进程连坐: 已启用（WebTmux 退出时连带终止执行者进程树）');
  else sc.warn('进程', '子进程连坐: 不可用。WebTmux 若被强杀，执行者会脱管继续运行，需手动结束沙箱内的残留进程。');
}

/** report_inject：人工干预的文件约定。面板有按钮，但终端投件同样有效，要说出来。 */
export function reportInject(sc, spec) {
  const run = spec.runDir, g = '人工干预';
  sc.info(g, `人工打断: 往 ${path.join(run, 'inject.txt')} 写一句话，下一个工具间隙生效`);
  sc.info(g, `  要立即打断（它在死循环里时）用 ${path.join(run, 'inject!.txt')}，或正文以 !! 开头`);
  sc.info(g, `暂停/继续: 建一个 ${path.join(run, 'pause')} 文件即暂停（当前这发跑完后停在下一次派发前），删掉就继续`);
  sc.info(g, '  想立刻停：先投 inject!.txt 打断，再建 pause（顺序反了当前这发会跑完）');
  sc.warn(g, '  暂停不是终止：删掉 pause 后它会接着干。打断语要写「先停一下，我看完让你接着做」，别写「停下别干了」');
  sc.info(g, `事后回放: 面板时间线（读 ${path.join(run, 'orchestrator.jsonl')}）`);
}

/** resume.py show_prior_state。 */
export function reportPriorState(sc, prior) {
  const g = '续跑';
  if (prior.legs != null || prior.handoffs != null) {
    sc.info(g, `上次运行: 调用 ${prior.legs ?? '?'} 次 · 交接 ${prior.handoffs ?? '?'} 次 · `
      + `花费 $${Number(prior.spentUsd || 0).toFixed(4)}`);
  }
  sc.info(g, `记忆文件: ${prior.memoryCount} 个`);
  for (const ln of prior.memoryIndex) sc.info(g, `  ${ln}`);
  if (prior.moreIndex > 0) sc.info(g, `  …… 另有 ${prior.moreIndex} 条`);
}

/** cli_common.load_req 的打印：参考路径、可写警告、链接、被放行的失效路径。 */
export function reportRequirement(sc, req, { allowMissingRefs = false } = {}) {
  const g = '需求';
  if (req.refs?.length) {
    sc.info(g, `参考资料: ${req.refs.length} 条路径，执行者直接读取（不复制）`);
    for (const r of req.refs) sc.info(g, `  ${refDisplay(r)}`);
    // --add-dir 给的是读写权限。用户已选择信任这些路径，但必须每次都说出来
    sc.warn(g, '  上述目录对执行者可写，不只是可读：');
    for (const d of extraDirsOf(req)) sc.warn(g, `      ${d}`);
  }
  if (req.urls?.length) sc.info(g, `参考链接: ${req.urls.length} 个（交给执行者自行抓取）`);
  if (req.rejected?.length && allowMissingRefs) {
    sc.warn(g, `以下 ${req.rejected.length} 条参考路径无法使用：`);
    for (const [ref, why] of req.rejected) sc.warn(g, `  ✗ ${ref} —— ${why}`);
    sc.warn(g, '  已按「忽略无法使用的参考路径」继续');
  }
}

/**
 * make_supervisor 的打印。status:
 *   off         未启用（noSupervisor）
 *   unavailable 凭据缺失（原版 LLMError），执行者每次结束都停机等人
 *   on          正常，带 model/baseUrl/promptSource/promptText/builtinText
 */
export function reportSupervisor(sc, s) {
  const g = '监督者';
  if (s.status === 'off') { sc.info(g, '未启用监督者：执行者每次结束都会停机等人判断'); return; }
  if (s.status === 'unavailable') {
    sc.warn(g, `监督者不可用: ${s.error}`);
    sc.warn(g, '  执行者每次结束都会停机等人判断。给所选供应商配上地址与密钥，或改回「跟随 CC Switch 当前配置」。');
    return;
  }
  sc.info(g, `监督者: ${s.model || '(默认模型)'} @ ${s.baseUrl}`);
  sc.info(g, s.via === 'cli'
    ? `  通道: claude CLI，跟随 CC Switch 当前 Claude 配置（${s.providerName}），与执行者同一套地址、登录与代理`
    : `  通道: 直接调 HTTP，面板明确选定的供应商 ${s.providerName}（调不通不会换别家）`);
  // 换掉提示词等于换掉全部判定规则，来源必须打出来
  sc.info(g, `  判定提示词: ${s.promptSource}（${chars(s.promptText).toLocaleString('en-US')} 字）`);
  // 只在内容真的不同时才警告，按来源判会每次都喊狼来了
  if (String(s.promptText).trim() !== String(s.builtinText).trim()) {
    sc.warn(g, '  与内置默认不一致：判定护栏可能已被改动');
  }
  // 代答权必须每次都说出来：它用委托人的口吻替他作决定，发出的话不带"这是推断"的标注
  sc.warn(g, '  监督者有代答权：它会依据需求文档代你回答执行者的问题，答复以你的口吻原样发出。');
  sc.warn(g, '    只有这四种情况才会叫你：缺只有你才有的外部信息 · 需求自相矛盾 · 它没把握 · 调用失败');
}
