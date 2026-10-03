/**
 * 长程开跑前，按执行者做准备与校验（在动项目目录之前跑，查出问题直接拒绝启动）：
 *   cursor    CLI 已登录；填了模型就核对 Cursor 账号的模型清单
 *   kiro      CLI 已登录；模型对照清单校验（Kiro 对不存在的模型只打 warn、照常用默认模型跑）；
 *             取模型的上下文窗口把占用百分比换成 token，窗口比交接线小时把三条水位线按窗口收紧
 *   opencode  用 CC Switch 的 Claude 类供应商写一份执行者专用配置（~/.webtmux 下，0600，不进项目），
 *             开跑前真发一个 1 token 请求，地址/密钥/模型不对当场报错
 * 返回给 LongRunService：runner 额外参数、自动换模型用的清单函数、自检说明、（可选）收紧后的水位线。
 */

import crypto from 'crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { cursorAccount } from './cursorCli.js';
import { kiroAccount } from './kiroCli.js';
import { listCursorModels } from './LongRunCursorRunner.js';
import { listKiroModels } from './LongRunKiroRunner.js';
import { buildOpencodeConfig, verifyOpencodeConfig } from './opencodeCli.js';
import { listProviderModels } from './ProviderModels.js';

/** 窗口装不下交接线时，按窗口比例收紧（只往小改，人填得更小的照旧） */
export function fitThresholds(o, window) {
  if (!window || window * 0.9 >= o.hardKill) return null;
  const hardKill = Math.min(o.hardKill, Math.round(window * 0.9));
  const handoffCeiling = Math.min(o.handoffCeiling, Math.round(window * 0.8));
  const handoffFloor = Math.min(o.handoffFloor, Math.round(window * 0.6));
  return handoffFloor < handoffCeiling && handoffCeiling < hardKill ? { handoffFloor, handoffCeiling, hardKill } : null;
}

/** OpenCode 执行者配置文件的位置：按项目目录分，不放项目里（里面有密钥） */
export const opencodeConfigPath = (root, home = os.homedir()) =>
  path.join(home, '.webtmux', 'longrun', `${path.basename(root)}-${crypto.createHash('md5').update(root).digest('hex').slice(0, 8)}`, 'opencode.json');

/**
 * @param {object} p
 * @param {object} p.o        normalizeOptions 之后的选项（含 executor、model、providerId、三条水位线）
 * @param {string} p.root     项目目录
 * @param {object} p.engine   AIEngine（经 CC Switch 解析供应商，禁止硬编码 Key）
 * @param {object} [p.deps]   测试注入：{cursorAccount, kiroAccount, listCursorModels, listKiroModels, listProviderModels, verify, home}
 * @returns {Promise<{extra:object, modelLister:Function|null|undefined, info:string, thresholds:object|null}>}
 *   modelLister 为 undefined 表示「用默认（CC Switch 供应商清单）」
 * @throws {Error} 准备不了（没登录、模型不存在、供应商不可用…），消息直接给人看
 */
export async function prepareExecutor({ o, root, engine, deps = {} }) {
  const d = { cursorAccount, kiroAccount, listCursorModels, listKiroModels, listProviderModels, verify: verifyOpencodeConfig, home: os.homedir(), ...deps };
  const model = o.model || '';
  if (o.executor === 'cursor') {
    if (!(await d.cursorAccount())) throw new Error('Cursor CLI 没登录：先在终端里运行 cursor-agent login');
    if (model) {
      const l = await d.listCursorModels();
      if (l.ok && !l.models.includes(model)) throw new Error(`Cursor 账号没有模型「${model}」，可用的有：${l.models.slice(0, 12).join('、')}…`);
    }
    return { extra: {}, modelLister: null, thresholds: null,
      info: `Cursor CLI（cursor-agent -p --force）${model ? `，模型 ${model}` : '，模型 Auto'}。按订阅计费不记美元，拿不到运行中水位、不做水位交接，人工插话会在工具间隙结束本发后续接` };
  }
  if (o.executor === 'kiro') {
    if (!(await d.kiroAccount())) throw new Error('Kiro CLI 没登录：先在终端里运行 kiro-cli login');
    const l = await d.listKiroModels();
    if (!l.ok) throw new Error(`读不到 Kiro 的模型清单：${l.error}`);
    const m = model || 'auto';
    if (!l.models.includes(m)) throw new Error(`Kiro 没有模型「${m}」（填错它不报错、会悄悄换成默认模型），可用的有：${l.models.join('、')}`);
    const window = l.windows[m] || 0;
    const thresholds = fitThresholds(o, window);
    return { extra: { contextWindow: window }, modelLister: null, thresholds,
      info: `Kiro CLI（kiro-cli chat --trust-all-tools），模型 ${m}${window ? `（上下文窗口 ${window.toLocaleString('en-US')}）` : ''}。`
        + `按 credits 计费不记美元（每发 credits 写进日志），预算上限对它不生效；人工插话会在工具间隙结束本发后续接`
        + (thresholds ? `。窗口装不下默认交接线，已按窗口收紧为 ${thresholds.handoffFloor.toLocaleString('en-US')} / ${thresholds.handoffCeiling.toLocaleString('en-US')} / ${thresholds.hardKill.toLocaleString('en-US')}` : '') };
  }
  if (o.executor === 'opencode') {
    const st = o.providerId ? engine?.resolveSessionSettings?.('claude', o.providerId) : engine?.getSettings?.();
    const c = st?.claude || {};
    if (!c.apiUrl || !c.apiKey) throw new Error('OpenCode 不能用 Claude 官方登录：在「供应商」里选一个 CC Switch 的第三方 Claude 供应商');
    const listed = await d.listProviderModels({ engine, providerId: o.providerId || '' });
    const env = { ANTHROPIC_BASE_URL: c.apiUrl, ANTHROPIC_AUTH_TOKEN: c.apiKey, ANTHROPIC_MODEL: model || c.model || '' };
    const name = st._providerName || o.providerId || 'CC Switch 当前 Claude 配置';
    const built = buildOpencodeConfig({ name, env, models: listed.ok ? listed.models : [] });
    if (!built.ok) throw new Error(built.error);
    const file = opencodeConfigPath(root, d.home);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(built.config, null, 2), { encoding: 'utf8', mode: 0o600 });
    try { chmodSync(file, 0o600); } catch { /* 已有文件要显式改（里面有密钥） */ }
    const v = await d.verify(file);
    if (!v.ok) throw new Error(`OpenCode 配置写好了，但测试请求失败：${v.error}`);
    return { extra: { opencodeConfig: file, defaultModel: built.model }, thresholds: null,
      // 自动换模型只在 Claude 系里挑：配置里只列了它们（供应商走 Anthropic 协议）
      modelLister: () => d.listProviderModels({ engine, providerId: o.providerId || '' }).then((r) => (r.ok ? r.models.filter((x) => /claude/i.test(x)) : [])),
      info: `OpenCode（opencode run --auto），供应商 ${name}，模型 ${built.model}。按价格表 × token 估算美元，预算刹车与水位交接照常；人工插话在两次模型调用之间结束本发后续接` };
  }
  return { extra: {}, modelLister: undefined, thresholds: null, info: `Claude Code（claude -p）${model ? `，模型 ${model}` : ''}` };
}
