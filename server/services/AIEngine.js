import fs from 'fs';
import crypto from 'crypto';
import os from 'os';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn } from 'child_process';
import { ProxyAgent, Agent } from 'undici';
import Database from 'better-sqlite3';
import ProviderService from './ProviderService.js';
import configService from './ConfigService.js';
import processDetector from './ProcessDetector.js';
import tokenStatsService from './TokenStatsService.js';
import pluginManager from './MonitorPlugins/index.js';
import { isTaskDone } from './taskDonePattern.js';
import { hasPendingQuestion } from './pendingQuestion.js';
import { promptPendingText, isOwnPendingInput } from './promptState.js';
import { isLiveConfirmMenu } from './liveMenu.js';
import { evalEarlyRules } from './aiRules/earlyRules.js';
import { DEFAULT_MODEL, CLAUDE_CODE_FAKE, CODEX_FAKE, CLAUDE_MODEL_FALLBACK_LIST, getModelsConfig } from '../config/constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SETTINGS_PATH = join(__dirname, '../db/ai-settings.json');
// CLI 回退最小间隔（同一会话）。CLI 单次约 4.3 万 input tokens，不能每轮都走
const CLI_FALLBACK_INTERVAL = 5 * 60 * 1000;
// 代理供应商拉黑时长。实测 32 个带凭证的 claude 供应商只有 2 个真能用（其余
// 401/404/502/503），按名字盲挑必然挑到死的。挂了就拉黑一段时间换下一个，
// 别再撞同一面墙，也别因为一次失败就永久放弃（网关 502 常是临时的）。
const PROXY_BLACKLIST_TTL = 10 * 60 * 1000;
// 代理供应商最多换几次。3 次已能覆盖"前几个恰好都挂了"，再多就不如直接走 CLI
const PROXY_MAX_ATTEMPTS = 3;
const CC_SWITCH_DB_PATH = join(os.homedir(), '.cc-switch', 'cc-switch.db');

// 创建 ProviderService 实例（不传 io，AIEngine 不需要推送事件）
const providerService = new ProviderService();

// 生成 Claude Code 格式的 user_id
function generateClaudeCodeUserId() {
  const hash = crypto.randomBytes(32).toString('hex');
  const sessionId = crypto.randomUUID();
  return `user_${hash}_account__session_${sessionId}`;
}

// 不使用代理，直连 API
const proxyAgent = null;

// 创建忽略 SSL 验证的 Agent（用于某些自签名证书的 API）
const insecureAgent = new Agent({
  connect: {
    rejectUnauthorized: false
  }
});

console.log('[AIEngine] 不使用代理，直连 API');

/**
 * 根据 AI 类型获取对应的 CLI 命令
 * @param {string} aiType - AI 类型 (claude/codex/gemini/opencode)
 * @returns {string} CLI 命令
 */
function getCliCommand(aiType) {
  const commands = {
    'claude': 'claude -c',
    'codex': 'codex',
    'gemini': 'gemini',
    'droid': 'droid',
    'opencode': 'opencode',
    'grok': 'grok -c'
  };
  return commands[aiType] || commands['claude'];
}

/**
 * 根据 AI 类型获取 CLI 工具名称
 * @param {string} aiType - AI 类型 (claude/codex/gemini/opencode)
 * @returns {string} CLI 工具名称
 */
function getCliName(aiType) {
  const names = {
    'claude': 'Claude Code',
    'codex': 'OpenAI Codex',
    'gemini': 'Google Gemini',
    'droid': 'Droid AI',
    'opencode': 'OpenCode',
    'grok': 'Grok (xAI)'
  };
  return names[aiType] || names['claude'];
}

// 剥掉 TUI 框线，保留命令本身（不能全局删 `|`，那会打断管道命令）
function stripBoxBorders(line) {
  return line
    .replace(/^\s*[│┃╎┆┊║]\s?/, '')
    .replace(/\s*[│┃╎┆┊║]\s*$/, '')
    .replace(/^\s*[❯>]\s+/, '')
    .trim();
}

// 面板底部的按键提示。出现它就说明这是个等按键的模态面板，而不是 AI 打印的编号列表。
const MENU_HINT = /Esc to (cancel|exit|close|go back)|Enter to |↵|to select\b|to confirm\b|to adjust\b|to use this session|↑\/↓|arrow keys|tab to/i;

/**
 * 结构化识别「屏上开着一个编号选项面板」——**不依赖面板标题**。
 *
 * 为什么不能靠标题：原来的判据是一张白名单（Select Model|Style|Theme、
 * Settings/Status/Config 标签行……）。Claude Code 每加一个 slash 面板（/agents、
 * /output-style…）就漏一个，漏掉后屏幕被面板占满，通用判定看到光标就当空闲，
 * 于是往一个 Ink SelectInput 里发「继续」——既选不中任何项，也推进不了工作。
 *
 * 结构特征（三者叠加，才不会把 AI 输出里的编号列表误认成菜单）：
 *   1. 连续的编号行，从 1 开始递增，至少 2 项
 *   2. 列表落在屏幕末尾附近（菜单总在最下面，历史输出里的列表不算）
 *   3. 底部有按键提示，或某一项前面挂着 ›/❯ 选择光标
 *
 * @returns {{items:number, hasYes:boolean, hasEscHint:boolean, title:string}|null}
 */
function detectOptionMenu(text) {
  if (!text) return null;
  const lines = String(text).slice(-3000).split('\n').map(stripBoxBorders);
  // 只看末尾 30 个非空行——菜单总在屏幕最下面
  const idx = [];
  for (let i = lines.length - 1, seen = 0; i >= 0 && seen < 30; i--) {
    if (lines[i]) { idx.unshift(i); seen++; }
  }
  if (!idx.length) return null;

  // 找从 1 开始递增的编号行（允许中间夹空行）
  let start = -1, expect = 1, last = -1, cursor = false;
  const nums = [];
  for (const i of idx) {
    const m = lines[i].match(/^([›❯>*]\s*)?(\d+)\.\s+(\S.*)$/);
    if (m && Number(m[2]) === expect) {
      if (expect === 1) { start = i; nums.length = 0; cursor = false; }
      nums.push(lines[i]);
      if (m[1]) cursor = true;
      expect++; last = i;
    } else if (expect > 1 && m && Number(m[2]) === 1) {
      start = i; nums.length = 1; nums[0] = lines[i]; expect = 2; last = i;
      cursor = !!m[1];
    }
  }
  if (nums.length < 2) return null;

  // 编号行之后不能再有大段正文（否则是历史输出里的列表，不是当前菜单）
  const after = lines.slice(last + 1).filter(Boolean);
  const hint = after.slice(0, 8).some(l => MENU_HINT.test(l)) || MENU_HINT.test(nums.join('\n'));
  if (!hint && !cursor) return null;
  if (after.filter(l => l.length > 60 && !MENU_HINT.test(l)).length > 2) return null;

  const title = (lines.slice(Math.max(0, start - 3), start).filter(Boolean).pop() || '').slice(0, 60);
  return {
    items: nums.length,
    hasYes: /^\s*([›❯>*]\s*)?1\.\s*(Yes|是|允许)/i.test(nums[0]),
    hasEscHint: after.slice(0, 8).some(l => /Esc to (cancel|exit|close|go back)/i.test(l)),
    title
  };
}

const DEFAULT_SYSTEM_PROMPT = `你是一个终端助手，帮助用户在命令行中完成任务。

规则：
1. 分析终端输出，理解当前状态
2. 根据用户目标，建议下一步命令
3. 每次只建议一条命令
4. 如果目标已完成，返回 JSON: {"action": "complete", "summary": "完成总结"}
5. 如果遇到错误，建议修复方法
6. 如果需要用户输入（如密码），返回 JSON: {"action": "need_input", "question": "问题"}
7. 如果需要执行命令，返回 JSON: {"action": "command", "command": "命令", "reasoning": "理由"}

危险命令（如 rm -rf、sudo）需要特别说明风险。

你必须以 JSON 格式回复，不要包含其他内容。`;

const DEFAULT_STATUS_PROMPT = `你是终端状态分析器。分析终端内容，返回 JSON。

重要：你必须且只能返回一个 JSON 对象，不要任何其他文字、解释或 markdown 格式。

JSON 格式：
{"currentState":"终端当前状态描述","workingDir":"工作目录路径","recentAction":"最近执行的命令","suggestion":"建议（可选，无则为null）"}

示例输出：
{"currentState":"用户在家目录执行了ls命令，终端空闲等待输入","workingDir":"~","recentAction":"ls","suggestion":null}`;

/**
 * 运行中计时器：CLI 工作时在 spinner 行尾显示 "… (2m 29s · ↓ 13.5k tokens)"。
 *
 * 三个必须兼容的点，每一个都曾漏判并导致自动"继续"打断正在跑的任务：
 *   1. 省略号是 **U+2026 单字符 `…`**，不是三个点。原来只写 \.{2,3}，
 *      于是所有 Claude Code 的运行计时器一律匹配不上。
 *   2. 时长有小时级（"(13h 26m 12s)"）。原来只认 [ms]，13h 开头的直接漏。
 *   3. 括号内可能有空格。
 */
const RUNNING_TIMER_RE = /(?:\.{2,3}|…)\s*\(\s*\d+\s*[hms]/i;

/**
 * 进行时 spinner：不带计时器后缀时的运行标志，如 "✽ Skedaddling…"。
 *
 * ⚠️ 这条只是**补充**证据，不可作为主判据——Claude Code 现在会把动词本地化
 * （实测 "✶ 构建数学实验课程… (53m 38s)"），中文动词没有 -ing 形态，
 * 任何 [A-Z][a-z]*ing 模式结构上都匹配不到。真正可靠的是 RUNNING_TIMER_RE。
 *
 * 字符集只收状态行的 spinner 符号，**不含 `⎿`**——那是工具输出的树形前缀，
 * "⎿ Waiting…" 是已结束工具调用的输出文本，不代表 CLI 在运行。
 * 行首锚定同样是为了排除正文里出现的同形文本。
 */
const RUNNING_SPINNER_RE = /(?:^|\n)\s*[✢✻✽✳✶✴✵✷·+*]\s*[A-Za-z一-龥][^\n]{0,30}?(?:…|\.{3})/;

/** 屏幕尾部是否有运行迹象（计时器或进行时 spinner） */
export function hasRunningTimer(text) {
  return RUNNING_TIMER_RE.test(text) || RUNNING_SPINNER_RE.test(text);
}

/**
 * CLI 是否正忙（判"能不能发文本"的唯一口径，各分支必须统一用它）。
 *
 * 除计时器/spinner 外还认状态栏的 esc to interrupt——CLI 重试网络错误时
 * （"✻ 504 · Retrying in 31s · attempt 8/10"）没有 spinner 计时器，只有这句话。
 * 只查计时器会把它判成空闲并发"继续"，正好打断 CLI 自己的重试。
 *
 * ⚠️ 运行中屏幕上 ❯ 输入框依然存在，所以"有提示符"永远不构成空闲证据，
 *    必须先用本函数排除忙碌，才能走空闲分支。
 */
export function isCliBusy(tailText) {
  return hasRunningTimer(tailText) || /esc to interrupt/i.test(tailText);
}

/**
 * 状态分析的结构化输出 schema（Anthropic tool_use 格式）。
 *
 * 用途：把"请你返回纯JSON、以{开头、不要markdown代码块"这种**求着模型守格式**的写法，
 * 换成 API 层面的强制约束——tool_choice 指定本工具后，模型只能按 schema 填参数，
 * 不可能再返回 markdown 包裹、前后带解释文字或半截 JSON。
 *
 * _parseStatusResponse 仍然保留：非 Claude 供应商（Codex/Gemini/OpenAI）和
 * 不支持 tools 的中转站走不了这条路，得靠它兜底。
 */
/**
 * 状态判定提示词。
 *
 * 为什么重写：原版是一张「看到字符串 X 就输出 Y」的对照表，写死了
 * "esc to interrupt"、"2m 29s"、"2. Yes, allow for this session" 这类界面原文。
 * 三个已实测的失效点：
 *   1. 计时器用的是 U+2026 单字符省略号，且有小时级时长（"(13h 26m 12s)"）；
 *   2. CLI 会把 spinner 动词本地化（实测 "✶ 构建数学实验课程… (53m 38s)"），
 *      任何英文字面量都匹配不到；
 *   3. 选项 2 有三种互不相同的语义（详见下面的确认菜单一节），
 *      原版一律让选 "2"，撞上「永久免确认」那种就是安全问题。
 * 所以改成讲清判断目标与取证方式，让模型据此推理，而不是背字面量。
 *
 * ⚠️ 结构化输出（tool_use）已在 API 层强制 schema，但这里仍保留 JSON 格式说明：
 *    非 Claude 供应商走不了 tool_use，得靠 _parseStatusResponse 从自由文本里抠。
 */
export function buildStatusPrompt({ cliName, cliCommand, terminalContent, progressContext = '' }) {
  return `你在监控一个 ${cliName} 终端会话，判断此刻该不该由程序自动替用户发一次输入。

# 代价不对称（这条决定了拿不准时怎么选）
误判「空闲」→ 发出输入 → **打断正在运行的任务**，用户的工作可能因此丢失。
误判「忙碌」→ 什么都不做 → 下个检测周期再来看，几乎无损失。
所以：**只要有任何一点正在运行的迹象，就判忙碌**。宁可多等一轮，不可打断。

# 第一步：CLI 是不是正忙？忙就直接 needsAction:false，不必往下看
按「证据」判断，不要背界面原文（原文会变，也会被本地化成中文）：
- 屏幕上有**带括号的累计计时器**，形如 \`… (2m 29s · ↓ 13.5k tokens)\`。
  注意省略号可能是单字符 \`…\`；时长可能带小时（\`13h 26m 12s\`）；
  它前面的动词可能是任何语言的任何词（\`Composing…\`、\`构建数学实验课程…\`）——
  **认括号里的时长，不要认动词**。
- 屏幕上有「按 esc 中断」一类的提示（esc to interrupt 及其各语言说法）。
- CLI 正在自己重试网络错误（如 \`504 · Retrying in 31s · attempt 8/10\`）。
  这种情况没有计时器，但插话会打断它自己的重试。
- 状态栏显示后台任务未完（\`N shells still running\`、\`· N shell ·\`、\`← N agents\`），
  或 CLI 最近明确说了「等通知 / 等它跑完 / 不空转」。
  → needsAction:false，suggestion 说明「后台任务运行中，发继续只会空转」。

⚠️ 运行中屏幕上**输入框（❯ / >）依然存在**，所以「看到提示符」永远不能作为空闲证据。
   必须先排除上面全部忙碌迹象，才允许判空闲。
⚠️ \`accept edits on\`、\`shift+tab to cycle\` 是**常驻模式指示器**（底部状态栏一直挂着），
   不代表有东西在等你接受，不要因此判需要操作。
例外：若同时弹出了确认菜单，确认菜单优先（见下一节）。

# 第二步：有没有在等你选项？（确认菜单）
只有明确列出编号选项、且在等输入时才算。actionType:"select"，suggestedAction 填编号。
**选哪个由选项 2 的语义决定，这三种后果完全不同，别一律选 2：**
| 选项 2 的内容 | 选 | 理由 |
|---|---|---|
| \`Yes, allow for this session\`（仅本次会话允许） | \`2\` | 省掉后续重复确认，范围限于本会话 |
| \`Yes, and don't ask again ...\`（不再询问 / 永久允许） | \`1\` | 选 2 会给整类命令永久免确认，越权，必须避免 |
| \`No\` 或其他否定项 | \`1\` | 选 2 等于拒绝执行，会把任务否掉 |
若选项 2 看不清或不属以上任何一种，选 \`1\`（\`1. Yes\` 是最保守的放行）。
计划/方案执行确认（选项 1 形如 \`Yes, and auto-accept edits\`）→ 选 \`1\`。

# 第三步之前：CLI 是不是在问你一个需要判断的问题？
若屏幕结尾是 CLI 把决策权交回来（「你想让我接着做哪个？」「要不要顺便改掉 X？」
「第 1 项收益明确、第 2 项工作量大，你选哪个？」这类**没有编号选项的开放式提问**），
那么回「继续」等于没回答——CLI 只会再问一遍，或自行乱选一个。
此时必须**正面回答问题本身**：
- 读懂它给的选项及各自代价，按「先低风险、后高价值，都要做就按顺序做完」的原则决断；
- suggestedAction 写成一句能直接发给 CLI 的**明确指令**，点名做什么、什么顺序，例如
  \`按顺序完成：先做第 1 项存根补全，完成后再做第 2 项链路修复\`、
  \`先修 svx/sdrhittesthelper.ts 的断链，那个阻塞其他文件\`；
- actionType 仍为 "text_input"，actionReason 说明为什么这样选。
⚠️ 不要输出「继续」「好的」这类没有信息量的话；也不要反问用户——你就是来替他拿主意的。
⚠️ 但凡问题涉及**删除数据、覆盖文件、推送/发布、改动生产环境、花钱**，
   不要替用户决定 → needsAction:false，suggestion 说明「需要你本人确认」。

# 第三步：确实空闲时，该不该推一把？
- 若屏幕呈现「反复发继续 → CLI 只回一句短话（"好的""在""没有其他任务"）」的循环，
  说明活已经干完了，再发就是空转 → needsAction:false，
  suggestion 说明「任务已完成，无需继续发送指令」。
- 处在写代码/改文件/写文档这类**还没收尾的开发工作**中间 →
  needsAction:true, actionType:"text_input", suggestedAction:"继续"。
- 处在部署、起服务、跑测试这类**需要人看结果**的阶段（npm run、localhost、测试输出）→
  needsAction:false，suggestion 提醒用户自己检查。
- 掉回普通 shell 提示符（\`$\`/\`%\`，不是 ${cliName} 的 \`>\`），说明 CLI 已退出 →
  needsAction:true, actionType:"shell_command", suggestedAction:"${cliCommand}"。
- ${cliName} 自身崩溃且卡死不动 → actionType:"text_input", suggestedAction:"/quit"。
- 看不出在干什么、或信息不足（比如刚启动的欢迎屏、无历史可判）→
  needsAction:false，**不要猜**。

# 输出
字段：currentState（状态描述）、workingDir（从终端提取，没有就填"未显示"）、
recentAction（最近操作）、needsAction（布尔）、
actionType（select/text_input/shell_command/single_char/suggestion/warning/none）、
suggestedAction（要发送的内容，无则空）、actionReason（理由）、suggestion（给用户看的提示，无则空）。
needsAction 为 false 时 actionType 填 "none"。

终端内容：
---
${terminalContent || '(空)'}
---
${progressContext}
只输出 JSON（不要 markdown 代码块），以 { 开头：`;
}

export const STATUS_TOOL = {
  name: 'report_terminal_status',
  description: '报告终端当前状态与建议的自动操作',
  input_schema: {
    type: 'object',
    properties: {
      currentState: { type: 'string', description: '终端当前状态的简短描述' },
      workingDir: { type: 'string', description: '工作目录路径，未显示则填"未显示"' },
      recentAction: { type: 'string', description: '最近执行的命令或动作' },
      needsAction: { type: 'boolean', description: '是否需要自动操作介入' },
      actionType: {
        type: 'string',
        // ⚠️ 这份 enum 必须覆盖下游所有分支实际会判的值，否则模型被 schema 卡住，
        //    只能挑一个语义不对的凑数。下游现有判定：select/text_input/single_char/
        //    suggestion/warning，加上提示词里写的 confirm/shell_command/none。
        enum: ['confirm', 'select', 'text_input', 'shell_command',
               'single_char', 'suggestion', 'warning', 'key', 'none'],
        description: '动作类型；needsAction 为 false 时填 none'
      },
      // ⚠️ 一律用 type:'string'，不用 ['string','null'] 联合类型：
      //    联合类型在部分中转站的 schema 校验里会直接 400，而空动作用空串表达足够
      //    （下游判的是 !action，空串同样为假）。
      suggestedAction: {
        type: 'string',
        description: '具体要发送的内容（如 "2"、"继续"、"/quit"）；无动作时填空字符串'
      },
      actionReason: { type: 'string', description: '为什么建议这个动作，无则空字符串' },
      suggestion: { type: 'string', description: '给用户看的提示，无则空字符串' }
    },
    required: ['currentState', 'needsAction', 'actionType']
  }
};

export class AIEngine {
  constructor() {
    this.settings = this._loadSettings();
    this.failoverConfig = null;
    this._failoverConfigLoaded = false;
    this._loadFailoverConfig();

    // 已探明不支持 tool_use 的供应商 apiUrl 集合（结构化输出降级用，见 _callClaudeApi）
    this._noToolsProviders = new Set();

    // AI 调用并发控制（防止多 Agent 同时调用触发限流）
    this._aiConcurrency = 0;
    this._aiMaxConcurrency = 3;
    this._aiQueue = [];

    // 会话级供应商配置缓存：providerKey('appType:id') -> settings | null
    // null 表示该供应商无法用于 HTTP 调用（如官方 OAuth 登录，无 URL/key）
    this._sessionProviderCache = new Map();
    // 会话级 CLI 回退节流：sessionId -> 上次 CLI 调用时间戳
    this._cliFallbackAt = new Map();
    // 代理供应商缓存（OAuth 会话借用的那个带凭证供应商）
    this._proxyProviderSettings = undefined;
    // 代理供应商黑名单：providerKey -> 拉黑到期时间戳
    this._proxyBlacklist = new Map();
    // 最近成功过的代理供应商 providerKey。优先级名单是给"用户切换供应商"用的，
    // 里面排前面的未必活着（实测 88codepaid/crs/FoxCode 全挂），所以监控这边
    // 自己记一个"真的调通过"的，下次优先用它，别把重试预算浪费在必挂的选项上。
    this._proxyLastGood = null;

    // 初始化插件管理器
    this._initPluginManager();
  }

  async _initPluginManager() {
    try {
      await pluginManager.loadBuiltinPlugins();
      console.log('[AIEngine] 监控策略插件已加载:', pluginManager.listPlugins().map(p => p.name).join(', '));
    } catch (err) {
      console.error('[AIEngine] 加载监控策略插件失败:', err);
    }
  }

  /**
   * 获取可用的监控策略插件列表
   */
  getAvailablePlugins() {
    return pluginManager.listPlugins();
  }

  /**
   * 根据项目上下文选择合适的插件
   */
  selectPlugin(projectContext, forcedPluginId = null) {
    return pluginManager.selectPlugin(projectContext, forcedPluginId);
  }

  async _loadFailoverConfig() {
    try {
      await configService.loadConfig();
      this.failoverConfig = configService.getFailoverConfig();
      this._failoverConfigLoaded = true;
      console.log('[AIEngine] 故障转移配置已加载:', this.failoverConfig?.enabled ? '已启用' : '未启用');
    } catch (err) {
      console.error('[AIEngine] 加载故障转移配置失败:', err);
      this.failoverConfig = { enabled: false };
      this._failoverConfigLoaded = true;
    }
  }

  async _ensureFailoverConfigLoaded() {
    if (!this._failoverConfigLoaded) {
      await this._loadFailoverConfig();
    }
  }

  _loadSettings() {
    // 1. 先读取 ai-settings.json 获取用户选择的供应商 ID
    let savedSettings = null;
    let savedProviderId = null;
    try {
      if (fs.existsSync(SETTINGS_PATH)) {
        savedSettings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
        // _providerId 格式: "appType:id"，如 "claude:xxx-xxx"
        savedProviderId = savedSettings._providerId;
      }
    } catch (err) {
      console.error('[AIEngine] 读取 ai-settings.json 失败:', err);
    }

    // 2. 如果没有保存的供应商 ID，尝试从 ProviderService 获取当前供应商
    // ⚠️ 只认"能解析出 URL/key"的供应商。providers.json 里可能留着 env 为空的
    //    空壳（如迁移遗留的 provider-migrated），认了它下面三步全走空，最后落到
    //    第 5 级报"未找到供应商"——现在改为跳过空壳，继续往 CC Switch 当前供应商探。
    if (!savedProviderId) {
      try {
        const currentProvider = providerService.getCurrentProvider('claude');
        if (currentProvider && this._parseProviderConfigFromService(currentProvider)) {
          savedProviderId = `claude:${currentProvider.id}`;
          console.log(`[AIEngine] 从 ProviderService 获取当前供应商: ${currentProvider.name}`);
        } else if (currentProvider) {
          console.log(`[AIEngine] ProviderService 当前供应商 ${currentProvider.name} 无 HTTP 凭证，跳过`);
        }
      } catch (err) {
        console.error('[AIEngine] 从 ProviderService 获取当前供应商失败:', err);
      }
    }

    // 2b. 仍然没有，则跟随 CC Switch 里用户当前选中的供应商（~/.cc-switch/settings.json）。
    //     这才是"用户正在工作的默认供应商"的权威来源；上面 providers.json 只是本地快照。
    if (!savedProviderId) {
      try {
        const ccSettingsPath = join(os.homedir(), '.cc-switch', 'settings.json');
        if (fs.existsSync(ccSettingsPath)) {
          const cc = JSON.parse(fs.readFileSync(ccSettingsPath, 'utf-8'));
          const id = cc.currentProviderClaude;
          if (id) {
            savedProviderId = `claude:${id}`;
            console.log(`[AIEngine] 跟随 CC Switch 当前供应商: ${id.slice(0, 8)}…`);
          }
        }
      } catch (err) {
        console.error('[AIEngine] 读取 CC Switch 当前供应商失败:', err.message);
      }
    }

    // 3. 如果有供应商 ID，从 ProviderService 或 CC Switch 数据库获取配置
    if (savedProviderId) {
      try {
        const [appType, providerId] = savedProviderId.split(':');
        if (appType && providerId) {
          // 优先从 ProviderService 获取（支持 providers.json）
          const provider = providerService.getById(appType, providerId);
          if (provider && provider.settingsConfig) {
            const result = this._parseProviderConfigFromService(provider);
            if (result) {
              console.log(`[AIEngine] 使用 ProviderService 供应商: ${provider.name}`);
              result._providerId = savedProviderId;
              result._providerName = savedSettings?._providerName || `${provider.name} (${appType})`;
              if (savedSettings?.tunnelUrl) {
                result.tunnelUrl = savedSettings.tunnelUrl;
              }
              // 使用 models.json 中的默认模型（跟随最新模型变化）
              const modelsConf = getModelsConfig();
              if (result.claude) {
                result.claude.model = modelsConf?.claude?.default || DEFAULT_MODEL;
              }
              if (result.openai) {
                result.openai.model = modelsConf?.openai?.default || result.openai.model;
              }
              if (result.codex) {
                result.codex.model = modelsConf?.openai?.default || result.codex.model;
              }
              return result;
            }
          }

          // 回退：从 CC Switch 数据库获取
          if (fs.existsSync(CC_SWITCH_DB_PATH)) {
            const db = new Database(CC_SWITCH_DB_PATH, { readonly: true });
            const row = db.prepare(`
              SELECT id, name, app_type, settings_config, website_url
              FROM providers
              WHERE id = ? AND app_type = ?
              LIMIT 1
            `).get(providerId, appType);
            db.close();

            if (row && row.settings_config) {
              const result = this._parseProviderConfig(row);
              if (result) {
                console.log(`[AIEngine] 使用 CC Switch 供应商: ${row.name}`);
                result._providerId = savedProviderId;
                result._providerName = savedSettings?._providerName || `${row.name} (${appType})`;
                if (savedSettings?.tunnelUrl) {
                  result.tunnelUrl = savedSettings.tunnelUrl;
                }
                // 使用 models.json 中的默认模型（跟随最新模型变化）
                const modelsConf2 = getModelsConfig();
                if (result.claude) {
                  result.claude.model = modelsConf2?.claude?.default || DEFAULT_MODEL;
                }
                if (result.openai) {
                  result.openai.model = modelsConf2?.openai?.default || result.openai.model;
                }
                if (result.codex) {
                  result.codex.model = modelsConf2?.openai?.default || result.codex.model;
                }
                return result;
              }
            }
          }
        }
      } catch (err) {
        console.error('[AIEngine] 加载供应商配置失败:', err);
      }
    }

    // 4. 回退：使用 ai-settings.json 中的直接配置（旧格式）
    // ⚠️ v1.2.48：这条回退曾长期掩盖故障。_providerId 指向的供应商在
    //    ProviderService 和 CC Switch 里都查不到时（用户在 CC Switch 里删了
    //    再重建，ID 会变），上面两步静默失败，这里就落到 ai-settings.json 里
    //    内嵌的**陈旧凭证**上——那份 key 早已失效，于是每次分析都 401，
    //    日志只报"无效的令牌"，看不出根因是引用失效。故这里显式告警。
    if (savedSettings && savedSettings.claude?.apiUrl) {
      if (savedProviderId) {
        console.warn(`[AIEngine] ⚠️ 供应商引用 ${savedProviderId} 在 ProviderService/CC Switch 中均未找到，`
          + `已回退到 ai-settings.json 内嵌凭证——该凭证可能已失效，请在设置中重新选择供应商`);
      }
      console.log('[AIEngine] 使用 ai-settings.json 直接配置');
      return savedSettings;
    }

    // 5. 无配置时返回空配置
    console.warn('[AIEngine] 未找到 AI 监控供应商配置，请在设置中选择供应商');
    return {
      apiType: 'claude',
      openai: { apiUrl: '', apiKey: '', model: DEFAULT_MODEL },
      claude: { apiUrl: '', apiKey: '', model: DEFAULT_MODEL },
      maxTokens: 500,
      temperature: 0.7,
      _noProvider: true
    };
  }

  // 解析 CC Switch 供应商配置
  _parseProviderConfig(row) {
    try {
      const settingsConfig = JSON.parse(row.settings_config);
      const appType = row.app_type;

      // 记录当前供应商信息
      this._currentProvider = {
        id: row.id,
        name: row.name,
        appType: appType
      };

      // 根据 app_type 解析不同格式的配置
      if (appType === 'codex') {
        // Codex 使用 auth.OPENAI_API_KEY 和 TOML 格式的 config
        const apiKey = settingsConfig.auth?.OPENAI_API_KEY || settingsConfig.auth?.CODEX_API_KEY || '';
        let apiUrl = '';
        let model = '';

        // 从 TOML config 中提取 base_url 和 model
        if (settingsConfig.config) {
          const baseUrlMatch = settingsConfig.config.match(/base_url\s*=\s*"([^"]+)"/);
          if (baseUrlMatch) {
            apiUrl = baseUrlMatch[1];
          }
          const modelMatch = settingsConfig.config.match(/^model\s*=\s*"([^"]+)"/m);
          if (modelMatch) {
            model = modelMatch[1];
          }
        }

        if (!apiUrl || !apiKey) {
          return null;
        }

        // 规范化 API URL：确保以 /responses 结尾
        if (!apiUrl.endsWith('/responses')) {
          apiUrl = apiUrl.replace(/\/+$/, '');
          apiUrl = `${apiUrl}/responses`;
        }

        return {
          apiType: 'codex',
          codex: {
            apiUrl: apiUrl,
            apiKey: apiKey,
            model: model || 'gpt-5.2-codex'
          },
          openai: { apiUrl: '', apiKey: '', model: 'gpt-4o' },
          claude: { apiUrl: '', apiKey: '', model: DEFAULT_MODEL },
          maxTokens: 500,
          temperature: 0.7,
          _currentProvider: this._currentProvider
        };
      } else if (appType === 'gemini') {
        // Gemini 使用 env.GEMINI_API_KEY 和 env.GOOGLE_GEMINI_BASE_URL
        const env = settingsConfig.env || {};
        const apiKey = env.GEMINI_API_KEY || '';
        let apiUrl = env.GOOGLE_GEMINI_BASE_URL || '';
        const model = env.GEMINI_MODEL || 'gemini-2.5-flash';

        if (!apiKey) {
          return null;
        }

        // 如果没有自定义 base URL，使用 Google 官方 API
        if (!apiUrl) {
          apiUrl = 'https://generativelanguage.googleapis.com/v1beta';
        }

        // 规范化 API URL
        apiUrl = apiUrl.replace(/\/+$/, '');

        return {
          apiType: 'gemini',
          gemini: {
            apiUrl: apiUrl,
            apiKey: apiKey,
            model: model
          },
          openai: { apiUrl: '', apiKey: '', model: 'gpt-4o' },
          claude: { apiUrl: '', apiKey: '', model: DEFAULT_MODEL },
          maxTokens: 500,
          temperature: 0.7,
          _currentProvider: this._currentProvider
        };
      } else if (appType === 'opencode') {
        // OpenCode 支持多种后端（Claude, OpenAI, Gemini 等）
        const env = settingsConfig.env || {};
        const provider = env.OPENCODE_PROVIDER || 'anthropic';

        let apiUrl = '';
        let apiKey = '';
        let model = '';

        if (provider === 'anthropic' || provider === 'claude') {
          apiUrl = env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
          apiKey = env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || '';
          model = env.ANTHROPIC_MODEL || DEFAULT_MODEL;

          if (!apiUrl.endsWith('/v1/messages')) {
            apiUrl = apiUrl.replace(/\/+$/, '');
            apiUrl = `${apiUrl}/v1/messages`;
          }

          return {
            apiType: 'opencode',
            opencode: { apiUrl, apiKey, model, provider: 'anthropic' },
            openai: { apiUrl: '', apiKey: '', model: 'gpt-4o' },
            claude: { apiUrl, apiKey, model },
            maxTokens: 500,
            temperature: 0.7,
            _currentProvider: this._currentProvider
          };
        } else {
          apiUrl = env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
          apiKey = env.OPENAI_API_KEY || '';
          model = env.OPENAI_MODEL || 'gpt-4o';

          return {
            apiType: 'opencode',
            opencode: { apiUrl, apiKey, model, provider: 'openai' },
            openai: { apiUrl, apiKey, model },
            claude: { apiUrl: '', apiKey: '', model: DEFAULT_MODEL },
            maxTokens: 500,
            temperature: 0.7,
            _currentProvider: this._currentProvider
          };
        }
      } else {
        // Claude 使用 env.ANTHROPIC_BASE_URL 和 ANTHROPIC_AUTH_TOKEN
        const env = settingsConfig.env || {};
        let apiUrl = env.ANTHROPIC_BASE_URL || '';
        const apiKey = env.ANTHROPIC_AUTH_TOKEN || '';

        if (!apiUrl || !apiKey) {
          return null;
        }

        // 规范化 API URL：确保以 /v1/messages 结尾
        if (!apiUrl.endsWith('/v1/messages')) {
          apiUrl = apiUrl.replace(/\/+$/, '');
          apiUrl = `${apiUrl}/v1/messages`;
        }

        return {
          apiType: 'claude',
          openai: { apiUrl: '', apiKey: '', model: DEFAULT_MODEL },
          claude: {
            apiUrl: apiUrl,
            apiKey: apiKey,
            model: DEFAULT_MODEL
          },
          maxTokens: 500,
          temperature: 0.7,
          _currentProvider: this._currentProvider
        };
      }
    } catch (err) {
      console.error('[AIEngine] 解析供应商配置失败:', err);
      return null;
    }
  }

  // 解析 ProviderService 供应商配置
  _parseProviderConfigFromService(provider) {
    try {
      const settingsConfig = provider.settingsConfig;
      const appType = provider.appType;

      // 记录当前供应商信息
      this._currentProvider = {
        id: provider.id,
        name: provider.name,
        appType: appType
      };

      // 根据 app_type 解析不同格式的配置
      if (appType === 'codex') {
        // Codex 使用 auth.OPENAI_API_KEY 和 TOML 格式的 config
        const apiKey = settingsConfig.auth?.OPENAI_API_KEY || settingsConfig.auth?.CODEX_API_KEY || '';
        let apiUrl = '';
        let model = '';

        // 从 TOML config 中提取 base_url 和 model
        if (settingsConfig.config) {
          const baseUrlMatch = settingsConfig.config.match(/base_url\s*=\s*"([^"]+)"/);
          if (baseUrlMatch) {
            apiUrl = baseUrlMatch[1];
          }
          const modelMatch = settingsConfig.config.match(/^model\s*=\s*"([^"]+)"/m);
          if (modelMatch) {
            model = modelMatch[1];
          }
        }

        if (!apiUrl || !apiKey) {
          return null;
        }

        // 规范化 API URL：确保以 /responses 结尾
        if (!apiUrl.endsWith('/responses')) {
          apiUrl = apiUrl.replace(/\/+$/, '');
          apiUrl = `${apiUrl}/responses`;
        }

        return {
          apiType: 'codex',
          codex: {
            apiUrl: apiUrl,
            apiKey: apiKey,
            model: model || 'gpt-5.2-codex'
          },
          openai: { apiUrl: '', apiKey: '', model: 'gpt-4o' },
          claude: { apiUrl: '', apiKey: '', model: DEFAULT_MODEL },
          maxTokens: 500,
          temperature: 0.7,
          _currentProvider: this._currentProvider
        };
      } else if (appType === 'gemini') {
        // Gemini 使用 env.GEMINI_API_KEY 和 env.GOOGLE_GEMINI_BASE_URL
        const env = settingsConfig.env || {};
        const apiKey = env.GEMINI_API_KEY || '';
        let apiUrl = env.GOOGLE_GEMINI_BASE_URL || '';
        const model = env.GEMINI_MODEL || 'gemini-2.5-flash';

        if (!apiKey) {
          return null;
        }

        // 如果没有自定义 base URL，使用 Google 官方 API
        if (!apiUrl) {
          apiUrl = 'https://generativelanguage.googleapis.com/v1beta';
        }

        // 规范化 API URL
        apiUrl = apiUrl.replace(/\/+$/, '');

        return {
          apiType: 'gemini',
          gemini: {
            apiUrl: apiUrl,
            apiKey: apiKey,
            model: model
          },
          openai: { apiUrl: '', apiKey: '', model: 'gpt-4o' },
          claude: { apiUrl: '', apiKey: '', model: DEFAULT_MODEL },
          maxTokens: 500,
          temperature: 0.7,
          _currentProvider: this._currentProvider
        };
      } else if (appType === 'opencode') {
        // OpenCode 支持多种后端（Claude, OpenAI, Gemini 等）
        const env = settingsConfig.env || {};
        const provider = env.OPENCODE_PROVIDER || 'anthropic';

        let apiUrl = '';
        let apiKey = '';
        let model = '';

        if (provider === 'anthropic' || provider === 'claude') {
          apiUrl = env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
          apiKey = env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || '';
          model = env.ANTHROPIC_MODEL || DEFAULT_MODEL;

          if (!apiUrl.endsWith('/v1/messages')) {
            apiUrl = apiUrl.replace(/\/+$/, '');
            apiUrl = `${apiUrl}/v1/messages`;
          }

          return {
            apiType: 'opencode',
            opencode: { apiUrl, apiKey, model, provider: 'anthropic' },
            openai: { apiUrl: '', apiKey: '', model: 'gpt-4o' },
            claude: { apiUrl, apiKey, model },
            maxTokens: 500,
            temperature: 0.7,
            _currentProvider: this._currentProvider
          };
        } else {
          apiUrl = env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
          apiKey = env.OPENAI_API_KEY || '';
          model = env.OPENAI_MODEL || 'gpt-4o';

          return {
            apiType: 'opencode',
            opencode: { apiUrl, apiKey, model, provider: 'openai' },
            openai: { apiUrl, apiKey, model },
            claude: { apiUrl: '', apiKey: '', model: DEFAULT_MODEL },
            maxTokens: 500,
            temperature: 0.7,
            _currentProvider: this._currentProvider
          };
        }
      } else {
        // Claude 使用 env.ANTHROPIC_BASE_URL 和 ANTHROPIC_AUTH_TOKEN
        const env = settingsConfig.env || {};
        let apiUrl = env.ANTHROPIC_BASE_URL || '';
        const apiKey = env.ANTHROPIC_AUTH_TOKEN || '';

        if (!apiUrl || !apiKey) {
          return null;
        }

        // 规范化 API URL：确保以 /v1/messages 结尾
        if (!apiUrl.endsWith('/v1/messages')) {
          apiUrl = apiUrl.replace(/\/+$/, '');
          apiUrl = `${apiUrl}/v1/messages`;
        }

        return {
          apiType: 'claude',
          openai: { apiUrl: '', apiKey: '', model: DEFAULT_MODEL },
          claude: {
            apiUrl: apiUrl,
            apiKey: apiKey,
            model: DEFAULT_MODEL
          },
          maxTokens: 500,
          temperature: 0.7,
          _currentProvider: this._currentProvider
        };
      }
    } catch (err) {
      console.error('[AIEngine] 解析 ProviderService 供应商配置失败:', err);
      return null;
    }
  }

  /**
   * 重新加载配置（供应商切换后调用）
   */
  reloadSettings() {
    this.settings = this._loadSettings();
    this._sessionProviderCache.clear();
    return this.settings;
  }

  /**
   * 按会话正在使用的供应商解析监控用配置。
   *
   * 监控 AI 原来只读全局 ai-settings.json 里那一个 _providerId，一旦它失效
   * （用户在 CC Switch 里删了重建，ID 会变）整条监控链就哑掉。这里改为直接跟随
   * 会话自己的供应商——A 会话用 88code、B 会话用 Whaty，各自的屏幕就用各自的凭证判，
   * 也不再需要用户在设置里单独选一遍"监控供应商"。
   *
   * @param {string} appType - 供应商类型 claude/codex/gemini
   * @param {string} providerId - 供应商 ID
   * @returns {object|null} 可用于 _callApi 的 settings；null 表示该供应商无法走 HTTP
   *   （最常见是官方 OAuth 登录，settings_config.env 为空，没有 URL/key 可取），
   *   此时调用方应回退到 CLI 路径。
   */
  resolveSessionSettings(appType, providerId) {
    if (!appType || !providerId) return null;
    const key = `${appType}:${providerId}`;
    if (this._sessionProviderCache.has(key)) return this._sessionProviderCache.get(key);

    let result = null;
    try {
      // 优先 ProviderService（providers.json），回退 CC Switch 数据库
      const provider = providerService.getById(appType, providerId);
      if (provider && provider.settingsConfig) {
        result = this._parseProviderConfigFromService(provider);
        if (result) result._providerName = `${provider.name} (${appType})`;
      }
      if (!result && fs.existsSync(CC_SWITCH_DB_PATH)) {
        const db = new Database(CC_SWITCH_DB_PATH, { readonly: true });
        const row = db.prepare(
          'SELECT id, name, app_type, settings_config, website_url FROM providers WHERE id = ? AND app_type = ? LIMIT 1'
        ).get(providerId, appType);
        db.close();
        if (row && row.settings_config) {
          result = this._parseProviderConfig(row);
          if (result) result._providerName = `${row.name} (${appType})`;
        }
      }
      if (result) {
        result._providerId = key;
        // 模型统一跟随 models.json，避免供应商配置里写死旧模型名
        const modelsConf = getModelsConfig();
        if (result.claude) result.claude.model = modelsConf?.claude?.default || DEFAULT_MODEL;
        if (result.openai?.apiUrl) result.openai.model = modelsConf?.openai?.default || result.openai.model;
        if (result.codex) result.codex.model = modelsConf?.openai?.default || result.codex.model;
        result.maxTokens = this.settings.maxTokens || result.maxTokens || 500;
        result.temperature = this.settings.temperature ?? result.temperature ?? 0.7;
        console.log(`[AIEngine] 会话级监控供应商: ${result._providerName}`);
      } else {
        console.log(`[AIEngine] 供应商 ${key} 无 HTTP 凭证（可能是官方 OAuth 登录），监控将回退 CLI`);
      }
    } catch (err) {
      console.error(`[AIEngine] 解析会话供应商 ${key} 失败:`, err.message);
      result = null;
    }

    this._sessionProviderCache.set(key, result);
    return result;
  }

  /**
   * 为「无 HTTP 凭证」的会话挑一个带凭证的供应商做监控分析。
   *
   * 为什么这样做：实测 26 个会话里 25 个用 Claude Official（OAuth 登录，settings_config.env
   * 为空，结构上取不到 URL/key）。若这些会话一律回退 CLI，按 5 分钟节流也是
   * 25 × 4.3 万 ≈ 107 万 tokens / 5 分钟，不可接受。
   *
   * 而监控分析只是「读一屏文本判断状态」——用哪个 key 判断结果都一样，它不需要
   * 跟被监控会话用同一个供应商。所以这里借一个便宜的第三方 key，CLI 只留给
   * 「连一个带凭证的供应商都没有」的极端情况。
   *
   * @param {string[]} priority - 供应商名称优先级（外部传入，见 index.js 的 CLAUDE_PROVIDER_PRIORITY）
   */
  getProxyMonitorSettings(priority = []) {
    if (this._proxyProviderSettings !== undefined) return this._proxyProviderSettings;

    let picked = null;
    try {
      if (fs.existsSync(CC_SWITCH_DB_PATH)) {
        const db = new Database(CC_SWITCH_DB_PATH, { readonly: true });
        const rows = db.prepare(
          "SELECT id, name, app_type, settings_config, website_url FROM providers WHERE app_type='claude'"
        ).all();
        db.close();

        // 只保留能解析出 URL+key、且不在黑名单里的
        const now = Date.now();
        const usable = [];
        for (const row of rows) {
          const cfg = this._parseProviderConfig(row);
          if (!cfg?.claude?.apiUrl || !cfg.claude.apiKey) continue;
          const until = this._proxyBlacklist.get(`claude:${row.id}`) || 0;
          if (until > now) continue;   // 最近刚失败过，跳过
          usable.push({ row, cfg });
        }
        // 1) 上次真的调通过的那个 —— 比任何静态名单都可靠
        if (this._proxyLastGood) {
          picked = usable.find(u => `claude:${u.row.id}` === this._proxyLastGood) || null;
        }
        // 2) 按优先级名称匹配（子串匹配，和 tryAutoSwitchProvider 的口径一致）
        if (!picked) {
          for (const p of priority) {
            const hit = usable.find(u => u.row.name.includes(p));
            if (hit) { picked = hit; break; }
          }
        }
        // 3) 兜底取第一个可用的
        if (!picked && usable.length) picked = usable[0];
      }
    } catch (err) {
      console.error('[AIEngine] 挑选代理监控供应商失败:', err.message);
    }

    if (picked) {
      const r = picked.cfg;
      r._providerId = `claude:${picked.row.id}`;
      r._providerName = `${picked.row.name} (代理监控)`;
      r._isProxy = true;   // 标记"借来的"：失败时可以拉黑换下一个，会话自己的供应商不行
      const modelsConf = getModelsConfig();
      if (r.claude) r.claude.model = modelsConf?.claude?.default || DEFAULT_MODEL;
      r.maxTokens = this.settings.maxTokens || r.maxTokens || 500;
      console.log(`[AIEngine] OAuth 会话借用代理监控供应商: ${picked.row.name}`);
      this._proxyProviderSettings = r;
    } else {
      console.warn('[AIEngine] 无可用的代理监控供应商，OAuth 会话将回退 CLI');
      this._proxyProviderSettings = null;
    }
    return this._proxyProviderSettings;
  }

  /**
   * 把当前借用的代理供应商拉黑一段时间，并清掉缓存，让下次挑到别的。
   *
   * 只对**借来的**代理供应商这么做。会话自己指定的供应商不能换——那是用户的选择，
   * 换了就等于偷偷用别人的账号。而代理供应商本来就是我们随便挑的，挑错了换一个
   * 完全合理，比直接烧 4.3 万 tokens 走 CLI 划算得多。
   *
   * @param {string} providerKey - 形如 'claude:<id>'
   * @param {string} reason - 失败原因（记日志）
   */
  blacklistProxyProvider(providerKey, reason = '') {
    if (!providerKey) return;
    this._proxyBlacklist.set(providerKey, Date.now() + PROXY_BLACKLIST_TTL);
    if (this._proxyProviderSettings?._providerId === providerKey) {
      this._proxyProviderSettings = undefined;   // undefined 而非 null：下次重新挑
    }
    // 曾经能用现在挂了，"上次成功"这条记录也失效，否则会一直挑这个死的
    if (this._proxyLastGood === providerKey) this._proxyLastGood = null;
    console.warn(`[AIEngine] 代理监控供应商 ${providerKey.slice(0, 20)}… 拉黑 ${PROXY_BLACKLIST_TTL / 60000} 分钟：${reason.slice(0, 80)}`);
  }

  /**
   * 获取当前供应商信息
   */
  getCurrentProviderInfo() {
    return this.settings._currentProvider || null;
  }

  getSettings() {
    return this.settings;
  }

  saveSettings(newSettings) {
    this.settings = { ...this.settings, ...newSettings };
    try {
      fs.writeFileSync(SETTINGS_PATH, JSON.stringify(this.settings, null, 2));
      return true;
    } catch (err) {
      console.error('保存 AI 设置失败:', err);
      return false;
    }
  }

  /**
   * 通用 API 调用方法，根据 apiType 选择不同格式
   * @param {string} prompt - 提示词
   * @param {object} callOpts - 调用选项
   * @param {boolean} callOpts.structured - 是否用 tool_use 强制结构化输出（仅 Claude 格式支持，
   *        其他供应商忽略此项，继续靠 _parseStatusResponse 从自由文本里抠 JSON）
   */
  async _callApi(prompt, callOpts = {}) {
    // settingsOverride：会话级供应商配置（resolveSessionSettings 的返回值）。
    // 传了就用它，不动全局 this.settings——多会话各用各的凭证时互不干扰。
    const st = callOpts.settingsOverride || this.settings;
    const apiType = st.apiType || 'openai';

    if (apiType === 'claude') {
      const config = st.claude || st.openai;
      return this._callClaudeApi(prompt, config, callOpts);
    } else if (apiType === 'codex') {
      // Codex 使用 OpenAI Responses API 格式
      const config = st.codex || st.openai;
      return this._callCodexApi(prompt, config);
    } else if (apiType === 'gemini') {
      // Gemini 使用 Google GenerativeLanguage API 格式
      const config = st.gemini;
      return this._callGeminiApi(prompt, config);
    } else if (apiType === 'opencode') {
      // OpenCode 支持多种后端，根据配置选择
      // 默认使用 Claude API 格式（因为 OpenCode 主要支持 Claude/OpenAI）
      const config = st.opencode || st.claude || st.openai;
      if (config.apiUrl && config.apiUrl.includes('anthropic')) {
        return this._callClaudeApi(prompt, config, callOpts);
      } else {
        return this._callOpenAiApi(prompt, config);
      }
    } else {
      const config = st.openai;
      return this._callOpenAiApi(prompt, config);
    }
  }

  /**
   * 带故障转移的 API 调用
   * 当前供应商失败时，自动切换到下一个可用供应商
   * @param {string} prompt - 提示词
   * @param {object} options - 可选参数
   * @param {string} options.sessionId - 会话 ID（用于 token 统计）
   * @param {string} options.requestType - 请求类型（用于 token 统计）
   * @param {boolean} options.structured - 透传给 _callApi，Claude 格式下强制 tool_use 输出
   * @returns {string} 返回 AI 响应文本（保持向后兼容）
   */
  async _callApiWithFailover(prompt, options = {}) {
    const { sessionId, requestType = 'analyze', structured = false, settingsOverride = null } = options;
    const callOpts = { structured, settingsOverride };

    // 会话级供应商：直接用它调一次，不进故障转移。
    // 故障转移会切换**全局**当前供应商（_switchToNextProvider），对"跟随本会话供应商"
    // 是反效果——会话本来就该用它自己那一个，失败了让上层回退 CLI 更合理。
    if (settingsOverride) {
      const response = await this._callApi(prompt, callOpts);
      this._recordTokenUsage(response, sessionId, requestType);
      return response?.text ?? response;
    }

    // 确保故障转移配置已加载
    await this._ensureFailoverConfigLoaded();

    // 如果未启用故障转移，直接调用
    if (!this.failoverConfig || !this.failoverConfig.enabled) {
      const response = await this._callApi(prompt, callOpts);
      // 记录 token 统计（不影响原有逻辑）
      this._recordTokenUsage(response, sessionId, requestType);
      // 返回文本保持兼容
      return response?.text ?? response;
    }

    const maxRetries = this.failoverConfig.maxRetries || 3;
    const retryDelay = this.failoverConfig.retryDelayMs || 5000;
    let lastError = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        // 尝试调用当前供应商
        const currentProvider = this.getCurrentProviderInfo();
        console.log(`[AIEngine] 尝试调用供应商 (${attempt + 1}/${maxRetries}): ${currentProvider?.name || 'unknown'}`);
        const response = await this._callApi(prompt, callOpts);

        // 如果成功且不是第一次尝试，说明发生了故障转移
        if (attempt > 0) {
          console.log(`[AIEngine] 故障转移成功，切换到供应商: ${currentProvider?.name || 'unknown'}`);
        }

        // 记录 token 统计（不影响原有逻辑）
        this._recordTokenUsage(response, sessionId, requestType);
        // 返回文本保持兼容
        return response?.text ?? response;
      } catch (error) {
        lastError = error;
        const currentProvider = this.getCurrentProviderInfo();
        console.error(`[AIEngine] API 调用失败 (尝试 ${attempt + 1}/${maxRetries}), 供应商: ${currentProvider?.name || 'unknown'}, 错误:`, error.message);

        // 如果还有重试机会，尝试切换供应商
        if (attempt < maxRetries - 1) {
          console.log('[AIEngine] 尝试切换到下一个供应商...');
          const switched = await this._switchToNextProvider();

          if (!switched) {
            console.error('[AIEngine] 无法切换到下一个供应商，故障转移失败');
            break;
          }

          // 等待一段时间后重试
          if (retryDelay > 0) {
            console.log(`[AIEngine] 等待 ${retryDelay}ms 后重试...`);
            await new Promise(resolve => setTimeout(resolve, retryDelay));
          }
        }
      }
    }

    // 所有尝试都失败
    throw new Error(`故障转移失败，已尝试 ${maxRetries} 次: ${lastError?.message || '未知错误'}`);
  }

  /**
   * 记录 token 使用统计（内部方法，不影响主流程）
   */
  _recordTokenUsage(response, sessionId, requestType) {
    try {
      if (!response || !response.usage) return;

      const providerInfo = this.getCurrentProviderInfo();
      tokenStatsService.recordUsage({
        sessionId,
        providerName: providerInfo?.name || 'unknown',
        providerUrl: providerInfo?.url || '',
        model: response.model || 'unknown',
        usage: response.usage,
        requestType,
        success: true
      });
    } catch (err) {
      // 统计失败不影响主流程
      console.error('[AIEngine] Token 统计记录失败:', err.message);
    }
  }

  /**
   * 切换到下一个可用供应商
   * @returns {boolean} 是否成功切换
   */
  async _switchToNextProvider() {
    try {
      // 获取所有供应商，按 sortIndex 排序
      const data = providerService.list('claude');
      const providers = Object.values(data.providers).sort((a, b) => a.sortIndex - b.sortIndex);

      console.log(`[AIEngine] 供应商列表: ${providers.map(p => p.name).join(', ')} (共 ${providers.length} 个)`);

      if (providers.length === 0) {
        console.error('[AIEngine] 没有可用的供应商');
        return false;
      }

      if (providers.length === 1) {
        console.error('[AIEngine] 只有一个供应商，无法切换');
        return false;
      }

      // 获取当前供应商
      const currentId = data.current;
      const currentIndex = providers.findIndex(p => p.id === currentId);
      console.log(`[AIEngine] 当前供应商: ${providers[currentIndex]?.name || 'unknown'} (索引: ${currentIndex})`);

      // 找到下一个供应商（循环）
      let nextProvider = null;
      for (let i = 1; i <= providers.length; i++) {
        const nextIndex = (currentIndex + i) % providers.length;
        const candidate = providers[nextIndex];

        // 跳过当前供应商
        if (candidate.id === currentId) {
          continue;
        }

        nextProvider = candidate;
        break;
      }

      if (!nextProvider) {
        console.error('[AIEngine] 没有其他可用的供应商');
        return false;
      }

      // 切换供应商
      console.log(`[AIEngine] 尝试切换到供应商: ${nextProvider.name} (ID: ${nextProvider.id})`);
      const result = await providerService.switch('claude', nextProvider.id);

      if (result.success) {
        // 重新加载配置
        this.reloadSettings();
        console.log(`[AIEngine] 成功切换到供应商: ${nextProvider.name}`);
        return true;
      } else {
        console.error(`[AIEngine] 切换供应商失败: ${result.error}`);
        return false;
      }
    } catch (error) {
      console.error('[AIEngine] 切换供应商时发生错误:', error);
      return false;
    }
  }

  // OpenAI 兼容 API 调用
  async _callOpenAiApi(prompt, config) {
    if (!config.apiUrl || !config.apiKey) {
      throw new Error('OpenAI API 未配置，请先在 ccswitch 中添加供应商');
    }

    const fetchOptions = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        model: config.model || DEFAULT_MODEL,
        messages: [{ role: 'user', content: prompt }],
        stream: false
      })
    };

    // 设置 dispatcher：优先使用代理，否则使用忽略 SSL 验证的 Agent
    fetchOptions.dispatcher = proxyAgent || insecureAgent;

    const response = await fetch(config.apiUrl, fetchOptions);

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI API 请求失败: ${response.status} ${error}`);
    }

    const data = await response.json();
    // 返回包含 text 和 usage 的对象
    return {
      text: data.choices?.[0]?.message?.content || null,
      usage: data.usage ? {
        input_tokens: data.usage.prompt_tokens || 0,
        output_tokens: data.usage.completion_tokens || 0
      } : null,
      model: data.model || config.model || 'unknown'
    };
  }

  // Claude 原生 API 调用（带 Claude Code 伪装）
  async _callClaudeApi(prompt, config, callOpts = {}) {
    if (!config.apiUrl || !config.apiKey) {
      throw new Error('Claude API 未配置，请先在 ccswitch 中添加供应商');
    }

    // Claude 列表里的服务器统一使用伪装模式
    console.log('[AIEngine] 使用 Claude Code 伪装模式');

    // 该供应商已探明不支持 tools 就别再试探（每次试探都白付一次 400 的往返）
    if (callOpts.structured && this._noToolsProviders.has(config.apiUrl)) {
      callOpts = { ...callOpts, structured: false };
    }

    // 获取要尝试的模型列表
    const modelsToTry = this._getModelsToTry(config.model);
    let lastError = null;

    for (const model of modelsToTry) {
      try {
        const result = await this._callClaudeApiWithModel(prompt, config, model, callOpts);
        // 成功后更新当前使用的模型（用于下次优先使用）
        if (model !== modelsToTry[0]) {
          console.log(`[AIEngine] 模型降级成功: ${modelsToTry[0]} -> ${model}`);
          this._lastWorkingModel = model;
        }
        return result;
      } catch (error) {
        lastError = error;
        // 检查是否是模型不可用错误
        if (this._isModelNotFoundError(error)) {
          console.log(`[AIEngine] 模型 ${model} 不可用，尝试下一个模型...`);
          continue;
        }
        // 其他错误直接抛出
        throw error;
      }
    }

    // 所有模型都失败
    throw lastError || new Error('所有模型都不可用');
  }

  // 获取要尝试的模型列表
  _getModelsToTry(configModel, skipFallback = false) {
    // 如果明确指定不使用降级列表（供应商只支持特定模型），直接返回配置的模型
    if (skipFallback && configModel) {
      return [configModel];
    }

    // 如果有上次成功的模型，优先使用
    if (this._lastWorkingModel && this._lastWorkingModel !== configModel) {
      const models = [this._lastWorkingModel];
      // 添加配置的模型作为备选
      if (configModel && !models.includes(configModel)) {
        models.push(configModel);
      }
      // 添加其他模型作为备选
      for (const m of CLAUDE_MODEL_FALLBACK_LIST) {
        if (!models.includes(m)) {
          models.push(m);
        }
      }
      return models;
    }

    // 使用配置的模型作为首选，然后是降级列表
    const models = [configModel || DEFAULT_MODEL];
    for (const m of CLAUDE_MODEL_FALLBACK_LIST) {
      if (!models.includes(m)) {
        models.push(m);
      }
    }
    return models;
  }

  // 检查是否是模型不可用错误
  _isModelNotFoundError(error) {
    const msg = error.message || '';
    return msg.includes('model_not_found') ||
           msg.includes('无可用渠道') ||
           msg.includes('model not found') ||
           msg.includes('No available accounts') ||  // Owly 返回的错误
           msg.includes('no available accounts') ||
           (msg.includes('503') && msg.includes('model'));
  }

  // 使用指定模型调用 Claude API
  async _callClaudeApiWithModel(prompt, config, model, callOpts = {}) {
    // 构建请求头（伪装 Claude Code）
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': CLAUDE_CODE_FAKE.userAgent,
      'x-app': CLAUDE_CODE_FAKE.headers['x-app'],
      'anthropic-beta': CLAUDE_CODE_FAKE.headers['anthropic-beta'],
      'anthropic-version': CLAUDE_CODE_FAKE.headers['anthropic-version'],
      'Authorization': `Bearer ${config.apiKey}`
    };

    // 构建请求体（伪装 Claude Code）
    // ⚠️ max_tokens 兜底抬到 1024：原来是 500，模型一旦多写两句解释，JSON 就被
    //    截断在半路，_parseStatusResponse 只能整条丢弃 → 表现为"AI 分析无结果"。
    const requestBody = {
      model: model,
      max_tokens: Math.max(callOpts.settingsOverride?.maxTokens || this.settings.maxTokens || 0, 1024),
      messages: [{ role: 'user', content: prompt }],
      system: [{ type: 'text', text: CLAUDE_CODE_FAKE.systemPrompt }],
      metadata: { user_id: generateClaudeCodeUserId() }
    };

    // 结构化输出：用 tool_choice 把模型钉死在 schema 上，从"求它别加 markdown"
    // 变成 API 层面不可能加。不支持 tools 的中转站会报错或忽略，下面按 text 兜底。
    if (callOpts.structured) {
      requestBody.tools = [STATUS_TOOL];
      requestBody.tool_choice = { type: 'tool', name: STATUS_TOOL.name };
    }

    const fetchOptions = {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody)
    };

    // 设置 dispatcher：优先使用代理，否则使用忽略 SSL 验证的 Agent
    fetchOptions.dispatcher = proxyAgent || insecureAgent;

    console.log(`[AIEngine] 调用 Claude API，模型: ${model}${callOpts.structured ? '（结构化输出）' : ''}`);
    const response = await fetch(config.apiUrl, fetchOptions);

    if (!response.ok) {
      const error = await response.text();
      // 中转站不支持 tools 时会 400/422，这里去掉 tools 重试一次再放弃——
      // 否则一个不支持 tools 的供应商会让整个状态分析彻底不可用。
      if (callOpts.structured && (response.status === 400 || response.status === 422)) {
        // ⚠️ 按 apiUrl 记，不能记在 engine 上：故障转移会换供应商，
        //    一个破中转站若把全局开关关掉，好供应商也跟着退化成自由文本。
        console.warn(`[AIEngine] 供应商不支持 tools（${response.status}），回退为自由文本模式: ${config.apiUrl}`);
        this._noToolsProviders.add(config.apiUrl);
        return this._callClaudeApiWithModel(prompt, config, model, { ...callOpts, structured: false });
      }
      throw new Error(`Claude API 请求失败: ${response.status} ${error}`);
    }

    const data = await response.json();

    // 优先取 tool_use 的入参（结构化路径），拿不到再退回普通文本块。
    // 序列化成 JSON 字符串是为了让下游 _parseStatusResponse 完全不用改：
    // 它本来就是"从字符串里抠 JSON"，给它一个纯净 JSON 是最好情况。
    const toolBlock = Array.isArray(data.content)
      ? data.content.find(b => b?.type === 'tool_use' && b?.input)
      : null;
    const textBlock = Array.isArray(data.content)
      ? data.content.find(b => b?.type === 'text' && b?.text)
      : null;

    return {
      text: toolBlock ? JSON.stringify(toolBlock.input) : (textBlock?.text || data.content?.[0]?.text || null),
      usage: data.usage || null,
      model: data.model || model,
      structured: !!toolBlock
    };
  }

  // Codex API 调用（带 Codex CLI 伪装，使用 OpenAI Responses API 格式）
  async _callCodexApi(prompt, config) {
    if (!config.apiUrl || !config.apiKey) {
      throw new Error('Codex API 未配置，请先在 ccswitch 中添加供应商');
    }

    console.log('[AIEngine] 使用 Codex CLI 伪装模式');

    // 构建请求头（伪装 Codex CLI）
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': CODEX_FAKE.userAgent,
      'openai-beta': CODEX_FAKE.headers['openai-beta'],
      'Authorization': `Bearer ${config.apiKey}`
    };

    // 构建请求体（OpenAI Responses API 格式）
    // 使用正确的 input 数组格式
    // 注意：不发送 instructions 字段，因为某些供应商（如 FoxCode）不接受自定义 instructions
    // 供应商会使用自己的默认 instructions
    const requestBody = {
      model: config.model || 'gpt-5.2-codex',
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: prompt }
          ]
        }
      ],
      stream: false
    };

    const fetchOptions = {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody)
    };

    // 设置 dispatcher
    fetchOptions.dispatcher = proxyAgent || insecureAgent;

    const response = await fetch(config.apiUrl, fetchOptions);

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Codex API 请求失败: ${response.status} ${error}`);
    }

    // 处理响应（可能是 SSE 流式或 JSON）
    const contentType = response.headers.get('content-type') || '';
    const responseText = await response.text();

    // 如果是 SSE 流式响应，解析事件流
    if (contentType.includes('text/event-stream') || responseText.startsWith('event:')) {
      const { text, usage } = this._parseCodexSSE(responseText);
      return { text, usage, model: config.model || 'gpt-5.2-codex' };
    }

    // 尝试解析为 JSON
    try {
      const data = JSON.parse(responseText);
      // Responses API 返回格式：{ output: [{ type: 'message', content: [...] }] }
      const output = data.output || [];
      let text = null;
      for (const item of output) {
        if (item.type === 'message' && item.content) {
          for (const content of item.content) {
            if (content.type === 'output_text') {
              text = content.text;
              break;
            }
          }
        }
        if (text) break;
      }
      // 回退：尝试其他可能的响应格式
      if (!text) {
        text = data.choices?.[0]?.message?.content || data.text || null;
      }
      // 返回包含 text 和 usage 的对象
      return {
        text,
        usage: data.usage ? {
          input_tokens: data.usage.prompt_tokens || data.usage.input_tokens || 0,
          output_tokens: data.usage.completion_tokens || data.usage.output_tokens || 0
        } : null,
        model: data.model || config.model || 'gpt-5.2-codex'
      };
    } catch (e) {
      console.error('[AIEngine] Codex 响应解析失败:', e);
      return { text: null, usage: null, model: config.model || 'gpt-5.2-codex' };
    }
  }

  // 解析 Codex SSE 流式响应
  _parseCodexSSE(sseText) {
    let result = '';
    let usage = null;
    const lines = sseText.split('\n');

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          const jsonStr = line.slice(6);
          const data = JSON.parse(jsonStr);

          // 处理 response.completed 事件
          if (data.type === 'response.completed' && data.response?.output) {
            for (const item of data.response.output) {
              if (item.type === 'message' && item.content) {
                for (const content of item.content) {
                  if (content.type === 'output_text') {
                    result += content.text;
                  }
                }
              }
            }
            // 提取 usage 信息
            if (data.response?.usage) {
              usage = {
                input_tokens: data.response.usage.input_tokens || 0,
                output_tokens: data.response.usage.output_tokens || 0
              };
            }
          }

          // 处理增量文本事件
          if (data.type === 'response.output_text.delta' && data.delta) {
            result += data.delta;
          }
        } catch (e) {
          // 忽略解析错误
        }
      }
    }

    return { text: result || null, usage };
  }

  // 调用 Gemini API
  async _callGeminiApi(prompt, config) {
    if (!config || !config.apiKey) {
      throw new Error('Gemini API 未配置');
    }

    const model = config.model || 'gemini-2.5-flash';
    let apiUrl = config.apiUrl || 'https://generativelanguage.googleapis.com/v1beta';

    // 构建完整 URL
    if (!apiUrl.includes('/models/')) {
      apiUrl = `${apiUrl}/models/${model}:generateContent`;
    }

    // 添加 API Key 到 URL
    const urlWithKey = `${apiUrl}?key=${config.apiKey}`;

    const requestBody = {
      contents: [
        {
          parts: [
            { text: prompt }
          ]
        }
      ],
      generationConfig: {
        temperature: this.settings.temperature || 0.7,
        maxOutputTokens: this.settings.maxTokens || 500
      }
    };

    console.log(`[AIEngine] 调用 Gemini API: ${model}`);

    try {
      const response = await fetch(urlWithKey, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });

      const responseText = await response.text();

      if (!response.ok) {
        console.error(`[AIEngine] Gemini API 错误 ${response.status}:`, responseText.slice(0, 500));
        throw new Error(`Gemini API 调用失败: ${response.status}`);
      }

      const data = JSON.parse(responseText);

      // 提取响应文本
      let text = null;
      if (data.candidates && data.candidates[0]?.content?.parts) {
        text = data.candidates[0].content.parts
          .filter(p => p.text)
          .map(p => p.text)
          .join('');
      }

      // 提取 usage 信息
      const usage = data.usageMetadata ? {
        input_tokens: data.usageMetadata.promptTokenCount || 0,
        output_tokens: data.usageMetadata.candidatesTokenCount || 0
      } : null;

      return {
        text,
        usage,
        model: model
      };
    } catch (err) {
      console.error('[AIEngine] Gemini API 调用失败:', err);
      throw err;
    }
  }

  async analyze({ goal, systemPrompt, history }) {
    if (!goal) return null;

    const recentHistory = history.slice(-30);
    const historyText = recentHistory
      .map(h => {
        if (h.type === 'input') return `$ ${h.content}`;
        if (h.type === 'output') return h.content;
        if (h.type === 'ai_decision') return `[AI执行] ${h.content}`;
        return `[${h.type}] ${h.content}`;
      })
      .join('\n');

    const basePrompt = systemPrompt || DEFAULT_SYSTEM_PROMPT;
    const prompt = `${basePrompt}

目标: ${goal}

终端历史记录:
\`\`\`
${historyText || '(空)'}
\`\`\`

分析当前状态，只返回 JSON：`;

    try {
      const content = await this._callApiWithFailover(prompt);

      if (!content) {
        return null;
      }

      // 解析 JSON 响应
      const result = this._parseResponse(content);
      return result;
    } catch (err) {
      console.error('AI 分析错误:', err);
      throw err;
    }
  }

  _parseResponse(content) {
    try {
      // 尝试提取 JSON
      let jsonStr = content;
      const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1];
      } else {
        // 尝试找到第一个完整的 JSON 对象（使用括号匹配算法）
        const startIdx = content.indexOf('{');
        if (startIdx !== -1) {
          let braceCount = 0;
          let endIdx = -1;
          for (let i = startIdx; i < content.length; i++) {
            if (content[i] === '{') braceCount++;
            else if (content[i] === '}') {
              braceCount--;
              if (braceCount === 0) {
                endIdx = i;
                break;
              }
            }
          }
          if (endIdx !== -1) {
            jsonStr = content.slice(startIdx, endIdx + 1);
          }
        }
      }

      const parsed = JSON.parse(jsonStr);

      if (parsed.action === 'complete') {
        return {
          type: 'complete',
          summary: parsed.summary
        };
      } else if (parsed.action === 'need_input') {
        return {
          type: 'need_input',
          question: parsed.question
        };
      } else if (parsed.action === 'command') {
        return {
          type: 'command',
          command: parsed.command,
          reasoning: parsed.reasoning,
          // 破坏性检测已按要求整体移除；字段保留为 false，避免下游读取时行为突变
          isDangerous: false
        };
      }

      return null;
    } catch (err) {
      console.error('解析 AI 响应失败:', err, content);
      return null;
    }
  }

  /**
   * 检测终端中运行的 CLI 工具类型
   * 优先使用 tmux 进程检测，回退到终端内容分析
   * @param {string} terminalContent - 终端内容
   * @param {string} tmuxSession - tmux 会话名称（可选，用于进程检测）
   * @returns {string|null} 'claude' | 'codex' | 'gemini' | null
   */
  detectRunningCLI(terminalContent, tmuxSession = null) {
    // 优先使用进程检测（更可靠）
    if (tmuxSession) {
      const processResult = processDetector.detectCLI(tmuxSession);
      if (processResult.detected) {
        console.log(`[AIEngine] 进程检测到 CLI: ${processResult.cli} (${processResult.processName}, PID: ${processResult.pid})`);
        return processResult.cli;
      }
    }

    // 回退到终端内容分析
    if (!terminalContent) return null;

    // 只检查最后 30 行内容，避免被历史记录干扰
    const lines = terminalContent.split('\n');
    const lastLines = lines.slice(-30).join('\n');

    // 检测 shell 命令行提示符（CLI 已退出的标志）
    // 如果最后几行是 shell 提示符，说明 CLI 已退出
    const last5Lines = lines.slice(-5).join('\n');

    // 如果最后几行是普通 shell 提示符（包含用户名@主机名），CLI 已退出
    if (/\w+@\w+.*[%$#]\s*$/.test(last5Lines)) {
      return null;
    }

    // 检测 Codex CLI 特征
    // 注意：必须使用严格的模式，避免与 Claude Code 输出混淆
    if (/OpenAI Codex|codex-cli|openai.*codex/i.test(lastLines) ||
        /codex\s+v\d+\.\d+/i.test(lastLines) ||
        /Codex\s*>\s*$/m.test(lastLines) ||
        /gpt-\d+(\.\d+)?\s+(low|medium|high|xhigh)\s*[·•]/i.test(lastLines) ||
        /Goal achieved/i.test(lastLines) && /gpt-/i.test(lastLines)) {
      return 'codex';
    }

    // 检测 Claude Code 特征
    if (/esc to interrupt/i.test(lastLines) ||
        /Clauding|Hatching/i.test(lastLines) ||
        /accept edits/i.test(lastLines) ||
        /Do you want to (make this edit|create|delete|run)/i.test(lastLines) ||
        /Claude Code|claude-cli/i.test(lastLines) ||
        /Running \d+ Task agents/i.test(lastLines)) {
      return 'claude';
    }

    // 检测 Gemini CLI 特征
    if (/gemini-2\.5-(flash|pro)|gemini-cli|@google\/gemini/i.test(lastLines) ||
        /GoogleSearch\s+Searching/i.test(lastLines) ||
        /✦\s*I have successfully/i.test(lastLines) ||
        /Ready\s*\(\d+\s*tools?\)/i.test(lastLines) ||
        /Google Gemini/i.test(lastLines) ||
        /(ReadFile|WriteFile|Shell)\s+(Reading|Writing|Running)/i.test(lastLines)) {
      return 'gemini';
    }

    // 检测 Droid CLI 特征
    if (/GPT5-Codex.*\[Custom\]/i.test(lastLines) ||
        /droid.*v\d+\.\d+/i.test(lastLines) ||
        /IDE\s*⚙/i.test(lastLines) ||
        /Auto \(Off\).*shift\+tab/i.test(lastLines)) {
      return 'droid';
    }

    // 检测 OpenCode CLI 特征
    // OpenCode 是 SST/Anomaly 团队开发的开源 AI 编码代理
    if (/opencode.*v\d+\.\d+/i.test(lastLines) ||
        /opencode-ai/i.test(lastLines) ||
        /OpenCode\s*>\s*$/m.test(lastLines) ||
        /\[build\]|\[plan\]/i.test(lastLines) && /opencode/i.test(terminalContent) ||
        /@general/i.test(lastLines) && /opencode/i.test(terminalContent) ||
        /anomalyco\/opencode/i.test(lastLines)) {
      return 'opencode';
    }

    // 检测 Grok CLI 特征（xAI Grok Build TUI）
    // 特征：输入框边框 "Grok Build · ..."、底部栏 Ctrl+o:interject、运行态 Waiting…、完成态 Turn completed in
    if (/Grok Build/i.test(lastLines) ||
        /Ctrl\+o:interject/i.test(lastLines) ||
        /Turn completed in \d/i.test(lastLines) ||
        /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*Waiting…/i.test(lastLines)) {
      return 'grok';
    }

    return null;
  }

  /**
   * 预判断终端状态，避免不必要的AI调用
   * 返回null表示需要AI分析，返回对象表示已判断出结果
   * @param {string} terminalContent - 终端内容
   * @param {string} aiType - AI 类型 (claude/codex/gemini)
   * @param {string} tmuxSession - tmux 会话名称（可选，用于进程检测）
   * @param {object} projectContext - 项目上下文（可选，用于插件选择）
   * @param {string} forcedPluginId - 强制使用的插件 ID（可选）
   */
  preAnalyzeStatus(terminalContent, aiType = 'claude', tmuxSession = null, projectContext = null, forcedPluginId = null) {
    // 获取选中的插件（用于在返回结果中显示）
    const selectedPlugin = pluginManager.selectPlugin(projectContext || {}, forcedPluginId);
    const pluginInfo = selectedPlugin ? {
      plugin: selectedPlugin.id,
      pluginName: selectedPlugin.name
    } : {};

    if (!terminalContent || terminalContent.trim().length === 0) {
      return {
        currentState: '终端内容为空',
        workingDir: '未知',
        recentAction: '无',
        needsAction: false,
        actionType: 'none',
        suggestedAction: null,
        actionReason: null,
        suggestion: null,
        updatedAt: new Date().toISOString(),
        preAnalyzed: true,
        detectedCLI: null,
        ...pluginInfo
      };
    }

    // 检测运行的 CLI 工具（优先使用进程检测）
    const detectedCLI = this.detectRunningCLI(terminalContent, tmuxSession);

    // === 高优先级：在插件分析之前，先检测确认界面 ===
    // 确认界面（Do you want to proceed? / Do you want to run?）必须优先于插件分析
    // 否则插件可能误匹配终端内容中的关键词（如 "error"）而跳过确认界面检测
    const earlyCleanContent = terminalContent
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')  // CSI 序列（含 ?25h 等）
      .replace(/\x1b\][^\x07]*\x07/g, '')       // OSC 序列
      .replace(/\x1b[()][A-Z0-9]/g, '')         // 字符集切换
      .replace(/\x1b[=>]/g, '')                  // 键盘模式
      .replace(/\r/g, '');                       // 回车符
    const cliNameEarly = getCliName(aiType);

    // 检测 "Do you want to ..." 确认界面（检查最后 5000 字符，确保覆盖可见屏幕）
    const earlyLast3000 = earlyCleanContent.slice(-5000);
    const isEditConfirmEarly = /Do you want to (make this edit|create|delete|overwrite|run|allow|execute)/i.test(earlyLast3000);
    const isProceedConfirmEarly = /(Do you want to|Would you like to) (proceed|run|execute|install|enable|update|continue)/i.test(earlyLast3000);
    const isPlanExecuteEarly = /written up a plan.*ready to execute/i.test(earlyLast3000);
    // 通用确认界面：任何以 ? 结尾的问句 + 选项 1. Yes（覆盖 Exit plan mode? / Would you like to install? 等）
    const isGenericConfirmEarly = /\?\s*\n[\s\S]{0,100}1\.\s*(Yes|Install|Enable|Accept)/im.test(earlyLast3000);
    const hasOption1YesEarly = /1\.\s*Yes/i.test(earlyLast3000);
    const hasOption2YesEarly = /2\.\s*Yes/i.test(earlyLast3000);
    // 检测选项 2 是否是"永久允许某命令模式"（don't ask again for: 具体命令）
    // 这种情况不应自动选 2，因为会永久跳过该命令的确认
    // ⚠️ 冒号必须可选：Claude Code 有两种措辞——
    //   带冒号 "2. Yes, and don't ask again for: npm run build"（针对具体命令）
    //   无冒号 "2. Yes, and don't ask again for similar commands in /path/to/proj"（针对整类命令，更危险）
    // 原正则写死了冒号，无冒号那种一律漏判 → 被当成普通"允许本次会话"自动选 2，
    // 于是给整个项目目录里的同类命令永久免确认。实测 Ghidra 会话就中过这一枪。
    const isOption2PermanentAllowEarly = /2\.\s*Yes,\s*and\s+don.t\s+ask\s+again\s+for\b/i.test(earlyLast3000);
    // 长说明型选项菜单兜底：标题问号与选项间隔大段说明文字（如 workflow 确认
    // "Run a dynamic workflow?" ... "1. Yes, run it / 2. View raw script / 3. No"），
    // isGenericConfirmEarly 的 100 字符窗口覆盖不到。用"1. Yes 选项 + 2. 选项 + 底部
    // Esc to cancel"这一确认菜单通用特征识别；选项 2 非 Yes 时下方逻辑自动落到选 1。
    // ⚠️ 只认 cancel/amend——"Esc to interrupt" 是运行中状态的常驻底栏，若把它算作
    // 确认菜单特征，AI 正在输出含 "1. Yes/2. ..." 的列表时会被误判成确认界面。
    const hasOptionMenuEarly = hasOption1YesEarly
      && /^\s*[❯>]?\s*2\.\s+\S/im.test(earlyLast3000)
      && /Esc to (cancel|amend)\b/i.test(earlyLast3000);

    // v1.2.81 验活闸：Claude 侧「关键词命中」不等于「有菜单」——对话正文里的
    // 问句+编号列表照样命中这些正则。台账实测 1142 次自动选择里 1138 次落账时
    // 屏上根本没有菜单（空转率 99.5%~100%），按键全落在空输入框/运行中的 CLI 上。
    // 活菜单必有 ❯ 指针行 + 底部快捷键提示（见 liveMenu.js，fixture 实测）。
    // Codex 走同一路径实测 84.3% 有效，不收紧非 Claude 的判定。
    const confirmKeywordHitEarly = (isEditConfirmEarly || isProceedConfirmEarly || isPlanExecuteEarly || isGenericConfirmEarly || hasOptionMenuEarly) && hasOption1YesEarly;
    const confirmMenuLiveEarly = (aiType || 'claude') !== 'claude' || isLiveConfirmMenu(earlyCleanContent);
    if (confirmKeywordHitEarly && !confirmMenuLiveEarly) {
      console.log('[AIEngine] 确认字样命中但无活菜单（缺 ❯ 指针/底部快捷键提示），判为正文误报，不发键');
    }
    if (confirmKeywordHitEarly && confirmMenuLiveEarly) {
      // Plan 执行确认（auto-accept edits）：选 1
      // 文件操作确认（allow all edits this session）：选 2
      // 永久允许某命令模式：选 1（避免永久跳过确认）
      let selectOption;
      if (isPlanExecuteEarly) {
        selectOption = '1';
      } else if (hasOption2YesEarly && !isOption2PermanentAllowEarly) {
        selectOption = '2';
      } else {
        selectOption = '1';
      }
      console.log(`[AIEngine] [高优先级] 检测到确认界面（插件分析前），选择选项 ${selectOption}${isPlanExecuteEarly ? '（Plan执行）' : isOption2PermanentAllowEarly ? '（跳过永久允许）' : ''}`);
      return {
        currentState: `${cliNameEarly}确认界面`,
        workingDir: '未显示',
        recentAction: '等待确认',
        needsAction: true,
        actionType: 'select',
        suggestedAction: selectOption,
        actionReason: (hasOption2YesEarly && !isOption2PermanentAllowEarly) ? '选择"允许本次会话"以自动化流程' : '选择"Yes"继续执行',
        suggestion: null,
        updatedAt: new Date().toISOString(),
        preAnalyzed: true,
        detectedCLI,
        ...pluginInfo
      };
    }

    // 注意：accept_edits 状态由插件统一处理（发"继续"），不在这里强制发 Tab。
    // Tab 通过 tmux send-keys 发送给 Claude Code (Ink 应用) 不可靠，
    // 而发"继续"既能让 Claude 继续工作，也能间接接受编辑。

    // === 高优先级：CLI 内置对话框开着（/status、/config、/model 等）===
    // 这类面板是 CLI 自己的模态界面，末尾提示 "Esc to cancel"。开着时屏幕全是设置内容，
    // 看不到任何工作进展，AI 只能判「状态不明确」而无限空转（实测挂了 20+ 分钟）。
    // 正确动作是按 Esc 关掉对话框，让真实终端内容重新露出来，下一轮再正常判定。
    // Esc 在此处无副作用（对话框取消，不提交任何设置变更）。
    {
      // v1.2.88 P3-13 第一阶段：本分支已迁入声明式规则表 aiRules/earlyRules.js
      // （首批为 CLI 内置对话框族）。规则 id 随 _rule 写进台账，空转率可按规则归因。
      const hit = evalEarlyRules({
        tail: earlyCleanContent.slice(-1200),
        clean: earlyCleanContent,
        aiType,
        helpers: { detectOptionMenu }
      });
      if (hit) {
        const { rule, extras } = hit;
        if (extras.log) console.log(`[AIEngine] ${extras.log}`);
        console.log(`[AIEngine] 声明式规则 ${rule.id} 命中`);
        return {
          currentState: rule.state,
          workingDir: '未显示',
          recentAction: rule.recentAction || '',
          needsAction: true,
          actionType: rule.action?.type || 'none',
          suggestedAction: rule.action ? (rule.action.key || rule.action.text || null) : null,
          actionReason: rule.reason || '',
          suggestion: null,
          updatedAt: new Date().toISOString(),
          preAnalyzed: true,
          _rule: rule.id,
          detectedCLI,
          ...pluginInfo,
          ...(rule.fields ? rule.fields(extras) : {})
        };
      }

      // （原「无脱身方式的选项面板」分支已迁入 aiRules/earlyRules.js 的 panel-no-escape）
    }

    // === 高优先级：连环打断熔断器 ===
    // 自动发的"继续"落在运行中的 CLI 上会打断工作（Interrupted · What should Claude
    // do instead?）。若近屏出现 ≥2 次该痕迹，说明自动操作正在反复打断真实工作，
    // 必须立即停手——哪怕当前看似空闲也不再发，等新输出把打断痕迹滚出屏幕再恢复。
    {
      const interruptCount = (earlyCleanContent.slice(-1500)
        .match(/Interrupted\s*[·•]\s*What should Claude do instead/gi) || []).length;
      if (interruptCount >= 2) {
        console.log(`[AIEngine] 熔断：近屏 ${interruptCount} 次 Interrupted 打断痕迹，停止自动操作`);
        return {
          currentState: `自动操作连续打断工作（${interruptCount} 次），已熔断停手`,
          workingDir: '未显示',
          recentAction: '自动"继续"打断了运行中的任务',
          needsAction: false,
          actionType: 'none',
          suggestedAction: null,
          actionReason: '检测到多次 Interrupted 痕迹——自动发送的"继续"正落在运行中的 CLI 上反复打断工作。已停止自动操作，待 CLI 自行推进、打断痕迹滚出屏幕后恢复',
          suggestion: null,
          updatedAt: new Date().toISOString(),
          preAnalyzed: true,
          detectedCLI,
          ...pluginInfo
        };
      }
    }

    // === 高优先级：检测"后台任务运行中 + CLI 自述等通知"，不发"继续" ===
    // 场景：CLI 把长任务放后台（run_in_background shell / agents），自己回到提示符，
    // 状态栏显示"N shell(s) still running / · N shell · / ← N agents"，且最近回复明确
    // 说"等循环通知，没有新信息前不空转"。此时发"继续"只会让 CLI 再回一句"等通知即可"，
    // 形成 继续→等通知→继续 的空转循环。两个信号必须同时满足才停手——只有后台任务
    // 而无等待措辞时不拦截（如常驻 dev server 场景，发"继续"仍是合理推进）。
    {
      const bgTail = earlyCleanContent.slice(-1500);
      const bgLast8 = earlyCleanContent.split('\n').slice(-8).join('\n');
      const hasBgRunning = /\d+\s+(shells?|tasks?|agents?)\s+still\s+running/i.test(bgTail)
        || /·\s*\d+\s+shells?\s*·/i.test(bgLast8)
        || /←\s*\d+\s+agents?/i.test(bgLast8);
      const saysWaitNotify = /等(候|待)?(循环|完成|任务)?通知|完成会有通知|等通知即可|不空转|轮询不出新信息|无人值守(推进|运行)|等(它|其|任务|后台)?(跑完|完成|结束)|后台(任务|批次|生成|执行)?(仍在|正在|进行中|运行中)|wait(ing)? for (the )?(task|notification|background)/i.test(bgTail);
      // 护栏：屏幕底部若出现确认菜单/选项界面，必须交给确认处理逻辑，不能在这里停手
      const hasConfirmMenu = /Do you want to|❯\s*1\.|\b1\.\s+(Yes|允许)|\[Y\/n\]/i.test(earlyCleanContent.slice(-600));
      if (hasBgRunning && saysWaitNotify && !hasConfirmMenu) {
        console.log('[AIEngine] 检测到后台任务运行中且 CLI 自述等通知，不发"继续"，等待任务完成');
        return {
          currentState: '后台任务运行中（CLI 等待完成通知）',
          workingDir: '未显示',
          recentAction: '后台 shell/agent 执行中',
          needsAction: false,
          actionType: 'none',
          suggestedAction: null,
          actionReason: 'CLI 已明确表示在等后台任务的完成通知、无新信息前不空转；此时发"继续"只会得到又一句"等通知即可"，属无效空转。后台任务完成会自动唤醒 CLI，无需干预',
          suggestion: null,
          updatedAt: new Date().toISOString(),
          preAnalyzed: true,
          detectedCLI,
          ...pluginInfo
        };
      }
    }

    // === 高优先级：检测 AI 明确"待命/无任务可做"的空闲，停手而非反复发"继续" ===
    // 场景：Ralph 自主会话或普通会话开发告一段落后，Claude 回复"待命中。需要具体任务。"
    // 之类，表示它没有可推进的工作、在等用户给方向。此时若继续自动发"继续"，Claude 只会
    // 再次回"待命中"，形成 继续→待命→继续 的死循环空转，白烧 API。应识别后停手并提示用户。
    {
      const idleTail = earlyCleanContent.slice(-800);
      const idleLast6 = earlyCleanContent.split('\n').slice(-6).join('\n');
      const hasIdlePromptHere = /^[❯>]\s*$/m.test(idleLast6) || /\n[❯>]\s*$/m.test(idleLast6);
      const isRunningHere = RUNNING_TIMER_RE.test(idleTail) || /esc to interrupt/i.test(idleLast6);
      // AI 主动表示"待命/无事可做/需要任务/已完成在等指示"的措辞
      const awaitingTask = /待命中|需要具体任务|需要(您|你)?(提供|给出|明确)(具体)?任务|没有(更多|可执行的)?任务|暂无任务|等待(您|你)?(的)?(指示|指令|下一步|进一步)(说明|要求)?|请(告诉|提供|给).{0,8}(任务|需求|指示)|awaiting (your )?(instructions?|task)|no (further )?task|standing by|let me know what|what would you like (me )?to/i.test(idleTail);
      if (hasIdlePromptHere && !isRunningHere && awaitingTask) {
        console.log('[AIEngine] 检测到 AI 待命/无任务空闲，停止自动发"继续"，提示用户介入');
        return {
          currentState: `${cliNameEarly}待命中（等待用户下达任务）`,
          workingDir: '未显示',
          recentAction: 'AI 表示无任务可推进',
          needsAction: false,
          actionType: 'none',
          suggestedAction: null,
          actionReason: 'AI 已明确表示待命、需要用户提供具体任务；继续自动发"继续"只会空转，已停手等待用户介入',
          suggestion: null,
          updatedAt: new Date().toISOString(),
          preAnalyzed: true,
          detectedCLI,
          ...pluginInfo
        };
      }
    }

    // === 高优先级：检测"列出多个下一步方向/选项让用户选择"的场景 ===
    // Claude 完成一轮开发后常列出"下一步可选方向/接下来可以..."等编号清单等待选择。
    // 这种场景应自动回复"按建议顺序继续开发"，让开发持续推进（优先于插件阶段判断，
    // 避免被测试归档等禁用自动操作的阶段误拦截）。
    {
      const directionLast1500 = earlyCleanContent.slice(-1500);
      // 必须是空闲状态（有提示符 ❯/> 且不在运行中）
      const directionLast5 = earlyCleanContent.split('\n').slice(-6).join('\n');
      const hasIdlePrompt = /^[❯>]\s*$/m.test(directionLast5) || /\n[❯>]\s*$/m.test(directionLast5);
      const isRunningNow = RUNNING_TIMER_RE.test(earlyCleanContent.slice(-500)) || /esc to interrupt/i.test(directionLast5);
      // "下一步方向/选项"提示语 + 至少两个编号项 + 征询选择的问句
      const hasDirectionHeader = /(下一步|接下来|后续|可选)(可以|的)?(方向|选项|工作|功能|计划|步骤)|next steps?|下一步可选/i.test(directionLast1500);
      const hasNumberedOptions = (directionLast1500.match(/^\s*\d+\.\s+\S/gm) || []).length >= 2;
      const hasChoicePrompt = /(继续哪个|选择哪个|想做哪|要做哪|哪个方向|which (one|direction|option)|或有其他|告诉我|你的想法|如何选择)/i.test(directionLast1500);

      if (hasIdlePrompt && !isRunningNow && hasDirectionHeader && hasNumberedOptions && hasChoicePrompt) {
        console.log('[AIEngine] 检测到"列出下一步方向"场景，自动回复按建议顺序继续开发');
        return {
          currentState: `${cliNameEarly}列出下一步方向`,
          workingDir: '未显示',
          recentAction: '等待选择方向',
          needsAction: true,
          actionType: 'text_input',
          suggestedAction: '按建议顺序继续开发',
          actionReason: '列出多个方向待选，自动按建议顺序推进',
          suggestion: null,
          updatedAt: new Date().toISOString(),
          preAnalyzed: true,
          detectedCLI,
          ...pluginInfo
        };
      }
    }

    // === 高优先级：Grok 状态检测（必须在插件分析之前，否则 DefaultPlugin 会拦截返回"状态不明确"）===
    // Grok 是盒装 TUI（│ ❯ │），与现有 CLI 的 ❯$ / accept edits 模式都不同，需专门处理
    if (aiType === 'grok') {
      const grokTail = earlyCleanContent.slice(-1500);
      const hasCancelBar = /Ctrl\+c:cancel|Ctrl\+o:interject/i.test(grokTail);
      const hasSpinnerWaiting = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*Waiting|Waiting…/i.test(grokTail);
      const hasTimingToken = /\d+\.\d+s\s+⇣/i.test(grokTail);
      // 运行中：底部栏有 cancel/interject，或有 spinner+Waiting，或计时+token 指示器
      if (hasCancelBar || hasSpinnerWaiting || hasTimingToken) {
        console.log('[AIEngine] 检测到 Grok 运行中，不打断');
        return {
          currentState: '程序运行中',
          workingDir: '未显示',
          recentAction: '执行中',
          needsAction: false,
          actionType: 'none',
          suggestedAction: null,
          actionReason: 'Grok 正在工作，不应打断',
          suggestion: null,
          updatedAt: new Date().toISOString(),
          preAnalyzed: true,
          detectedCLI,
          ...pluginInfo
        };
      }
      // 空闲：盒装提示符 │ ❯ + 空闲底部栏（Shift+Tab:mode 且无 cancel）
      const hasGrokBoxPrompt = /[│|]\s*[❯>]\s/.test(grokTail);
      const hasIdleBar = /Shift\+Tab:mode/i.test(grokTail);
      if (hasGrokBoxPrompt && hasIdleBar) {
        console.log('[AIEngine] 检测到 Grok 空闲（盒装提示符 + 空闲状态栏），自动发送继续');
        return {
          currentState: 'Grok 空闲',
          workingDir: '未显示',
          recentAction: '等待输入',
          needsAction: true,
          actionType: 'text_input',
          suggestedAction: '继续',
          actionReason: '空闲状态，自动继续开发',
          suggestion: null,
          updatedAt: new Date().toISOString(),
          preAnalyzed: true,
          detectedCLI,
          ...pluginInfo
        };
      }
    }

    // 尝试使用插件系统分析（如果有项目上下文）
    // 注意：默认插件也需要执行分析，以支持免费用户的自动化操作
    if (projectContext || forcedPluginId) {
      const plugin = pluginManager.selectPlugin(projectContext || {}, forcedPluginId);
      if (plugin) {
        // 检测当前阶段
        const phase = plugin.detectPhase(terminalContent, projectContext || {});
        const phaseConfig = plugin.getPhaseConfig(phase);

        // 使用插件分析状态（包括默认插件）
        // 注入 aiType，供插件在 shell 提示符下构造正确的 CLI 重启命令
        const pluginResult = plugin.analyzeStatus(terminalContent, phase, { ...(projectContext || {}), aiType });
        if (pluginResult) {
          // Harness: Sprint feature 指令只在 feature 切换时注入一次
          // 之后用普通"继续"，避免重复发送导致 Claude "第 N 次重复，未执行"
          if (pluginResult.needsAction && pluginResult.actionType === 'text_input'
              && pluginResult.suggestedAction?.startsWith('继续')
              && projectContext?.progress?.features?.length) {
            const cur = projectContext.progress.features.find(f => f.status === 'in_progress')
              || projectContext.progress.features.find(f => f.status === 'pending');
            if (cur) {
              const featureKey = cur.id || cur.name;
              if (!this._lastSprintFeature || this._lastSprintFeature !== featureKey) {
                // feature 切换了，发送完整指令
                this._lastSprintFeature = featureKey;
                pluginResult.suggestedAction = this._buildSprintInstruction(projectContext.progress) || pluginResult.suggestedAction;
              }
              // 否则保持原始的"继续"，不重复注入 feature 指令
            }
          }
          console.log(`[AIEngine] 插件 ${plugin.name} 分析结果: ${pluginResult.message || pluginResult.actionType}`);
          return {
            ...pluginResult,
            currentState: pluginResult.currentState || pluginResult.message || pluginResult.actionType,
            plugin: plugin.id,
            pluginName: plugin.name,
            phase,
            phaseName: plugin.phases.find(p => p.id === phase)?.name || phase,
            detectedCLI,
            updatedAt: new Date().toISOString(),
            preAnalyzed: true
          };
        }

        // 如果插件没有返回结果但阶段配置禁用自动操作，返回不操作状态
        // ⚠️ v1.2.47：这个提前 return 会截断后面**所有**通用检测（确认界面、错误恢复、
        //    运行中判定…）。当屏上正挂着"Do you want to proceed?"确认菜单时，
        //    据此返回 needsAction:false 等于让整条流水线停摆——CLI 在等按键，
        //    而我们回一句"当前阶段不自动操作"，谁也不会去按，会话就无限期挂着。
        //    实测 RustCandance 挂 3 小时零按键（19 轮走到这里 vs 仅 1 轮认出确认界面）。
        //    确认菜单是"CLI 阻塞等输入"的硬信号，与阶段策略无关：此时必须放行，
        //    让下方高优先级确认界面逻辑接手按键。
        const blockedByConfirmMenu = /(Do you want to|Would you like to)[\s\S]{0,400}?^\s*[❯>]?\s*1\.\s+\S/im
          .test(earlyLast3000) && /Esc to (cancel|amend)\b/i.test(earlyLast3000);
        if (phaseConfig.autoActionEnabled === false && blockedByConfirmMenu) {
          console.log(`[AIEngine] 插件 ${plugin.name}(${phase}) 阶段禁用自动操作，但屏上挂着确认菜单 → 放行给通用确认逻辑`);
        }
        if (phaseConfig.autoActionEnabled === false && !blockedByConfirmMenu) {
          return {
            currentState: `${plugin.name} - ${plugin.phases.find(p => p.id === phase)?.name || phase}`,
            workingDir: '未显示',
            recentAction: '等待',
            needsAction: false,
            actionType: 'none',
            suggestedAction: null,
            actionReason: `${phaseConfig.requireConfirmation ? '需要人工确认' : '当前阶段不自动操作'}`,
            suggestion: null,
            plugin: plugin.id,
            pluginName: plugin.name,
            phase,
            phaseName: plugin.phases.find(p => p.id === phase)?.name || phase,
            detectedCLI,
            updatedAt: new Date().toISOString(),
            preAnalyzed: true
          };
        }
      }
    }

    // 先清理 ANSI 转义序列，确保正则能正确匹配
    const cleanContent = terminalContent.replace(/\x1b\[[0-9;]*m/g, '');
    // 更彻底的 ANSI 清理（包括光标移动、清行等），用于运行状态检测
    // 避免 Claude Code 运行状态行被非颜色 ANSI 序列破坏导致正则无法匹配
    const fullyCleanContent = terminalContent.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

    // 0. 最高优先级：检测 API 错误（必须在"运行中"检测之前）
    // 因为即使终端历史中有 "esc to interrupt"，如果有 API 错误也应该触发修复
    const hasInputPromptForError = /^>\s*$/m.test(cleanContent) || /\n>\s*$/m.test(cleanContent);

    // 需要完整修复的错误（thinking block 相关）- 交给 ClaudeSessionFixer 处理
    // 注意：只检测最近的输出（最后 2000 字符），避免历史错误信息导致重复检测
    const recentContent = cleanContent.slice(-2000);
    // 移除换行符和多余空格以处理跨行的错误信息（如 "th\ninking.signature"）
    const recentContentNoNewlines = recentContent.replace(/\r?\n\s*/g, '');
    const needsSessionFix = /invalid.*signature.*in.*thinking/i.test(recentContentNoNewlines) ||
                            /thinking.*block.*not.*allowed/i.test(recentContentNoNewlines) ||
                            /invalid.*thinking.*block/i.test(recentContentNoNewlines) ||
                            /thinking\.signature.*Field required/i.test(recentContentNoNewlines) ||
                            /thinking\.signature:\s*Field required/i.test(recentContentNoNewlines) ||
                            /"signature":\s*"Field required"/i.test(recentContentNoNewlines) ||
                            /text content blocks must be non-empty/i.test(recentContentNoNewlines) ||
                            /content blocks must be non-empty/i.test(recentContentNoNewlines) ||
                            /Improperly formed request/i.test(recentContentNoNewlines) ||
                            /tool_use_id/i.test(recentContentNoNewlines) && /API Error/i.test(recentContentNoNewlines);

    // 调试日志
    if (needsSessionFix || hasInputPromptForError) {
      console.log(`[AIEngine] API错误检测: needsSessionFix=${needsSessionFix}, hasInputPromptForError=${hasInputPromptForError}`);
      if (needsSessionFix) {
        // 输出匹配到的具体模式
        const patterns = [
          { name: 'invalid signature in thinking', regex: /invalid.*signature.*in.*thinking/i },
          { name: 'thinking block not allowed', regex: /thinking.*block.*not.*allowed/i },
          { name: 'invalid thinking block', regex: /invalid.*thinking.*block/i },
          { name: 'thinking.signature Field required', regex: /thinking\.signature.*Field required/i },
          { name: 'thinking.signature: Field required (JSON)', regex: /thinking\.signature:\s*Field required/i },
          { name: 'JSON signature Field required', regex: /"signature":\s*"Field required"/i },
          { name: 'text content blocks must be non-empty', regex: /text content blocks must be non-empty/i },
          { name: 'content blocks must be non-empty', regex: /content blocks must be non-empty/i },
          { name: 'Improperly formed request', regex: /Improperly formed request/i },
          { name: 'tool_use_id + API Error', regex: /tool_use_id/i }
        ];
        for (const p of patterns) {
          if (p.regex.test(recentContentNoNewlines)) {
            console.log(`[AIEngine] 匹配到错误模式: ${p.name}`);
          }
        }
      }
    }

    // 如果检测到需要修复的错误，直接返回修复状态
    // 注意：即使没有 > 提示符，也应该触发修复，因为错误已经发生
    if (needsSessionFix) {
      // 不自动操作，让 server/index.js 的 ClaudeSessionFixer 来处理
      console.log('[AIEngine] 检测到需要修复的 API 错误（thinking block/tool_use_id），交给修复流程处理');
      return {
        currentState: 'API错误需要修复',
        workingDir: '未显示',
        recentAction: 'API调用失败',
        needsAction: false,  // 不自动操作
        actionType: 'none',
        suggestedAction: null,
        actionReason: '检测到 thinking block 签名错误，需要修复会话历史',
        suggestion: '等待自动修复流程执行',
        updatedAt: new Date().toISOString(),
        preAnalyzed: true,
        detectedCLI,
        ...pluginInfo,
        needsSessionFix: true  // 标记需要修复
      };
    }

    // 0. 最高优先级：检测排队消息状态（上下文压缩期间排队的无效输入）
    // 必须在所有其他检测之前，因为此时任何操作都会被打断
    if (/Press up to edit queued messages/i.test(cleanContent)) {
      console.log(`[AIEngine] 检测到排队消息状态，发送 Escape 清除`);
      return {
        currentState: '有排队消息待清除',
        workingDir: '未显示',
        recentAction: '排队消息',
        needsAction: true,
        actionType: 'single_char',
        suggestedAction: 'Escape',
        actionReason: '清除上下文压缩期间排队的无效消息',
        suggestion: null,
        updatedAt: new Date().toISOString(),
        preAnalyzed: true,
        detectedCLI,
        ...pluginInfo
      };
    }

    // 1. 检测程序运行中（在 API 错误检测之后）
    // 如果程序正在运行，即使历史中有确认界面内容，也应该返回"运行中"
    // 但要排除确认界面的情况（确认界面显示时程序实际上已暂停）
    let isRunning = false;
    const cliName = getCliName(aiType);

    // 先检查是否是确认界面（排除误判）
    const isConfirmDialog = (/Do you want to proceed\?/i.test(cleanContent) ||
                             /Do you want to (make this edit|create|delete|run)/i.test(cleanContent)) &&
                            /1\.\s*Yes/i.test(cleanContent);

    // 检查是否有 accept edits 等待状态（Claude Code 完成任务后等待用户接受编辑）
    // 重要：只检测末尾若干行，避免匹配到历史滚动缓冲区里的旧提示符。
    // ⚠️ 必须先滤掉空行再取末 5 行：tmux capture-pane 会把 pane 补齐到固定高度，
    //    屏幕不满时尾部是一串空行（实测 38 行的屏幕尾部 8 行全空）。原来直接
    //    slice(-5) 取到的全是空行，❯ 提示符根本不在窗口里 → hasIdlePromptForAccept
    //    恒为 false，进而让下面的 isWaitingForAccept 恒为 true。
    const nonEmptyLines = cleanContent.split('\n').filter(l => l.trim());
    const last5Lines = nonEmptyLines.slice(-5).join('\n');
    const hasIdlePromptForAccept = /^[❯>]\s*$/m.test(last5Lines) || /\n[❯>]\s*$/m.test(last5Lines);
    // ⚠️ "accept edits on" 是**常驻模式指示器**（底部状态栏一直挂着，shift+tab 切换），
    //    不代表"有编辑在等你接受"。把它当等待信号会压掉真正的运行证据：
    //    isWaitingForAccept 为真时下方 hasRunningIndicator/hasRecentRuntime 都被否决，
    //    于是「accept edits on + esc to interrupt」的运行中屏幕被判成"等待接受编辑"
    //    并发出"继续"，直接打断正在跑的任务（实测 Composing… 13h 的会话中过枪）。
    //    真正的等待接受编辑，屏上会有 Claude Code 的编辑确认框，那由上面的确认分支处理。
    //    所以这里只在**没有任何运行迹象**时才认定为等待接受。
    const hasAnyRunningHint = /esc to interrupt/i.test(cleanContent)
      || RUNNING_TIMER_RE.test(fullyCleanContent.slice(-500));
    const isWaitingForAccept = !hasIdlePromptForAccept && !hasAnyRunningHint
      && /accept edits on|shift\+tab to cycle/i.test(cleanContent);
    // 检查是否有"<过去式动词> for <时长>"任务完成标志。Claude Code 每轮结束随机用
    // 烹饪动词（Brewed/Baked/Sautéed/Cooked/Simmered...），运行中则是进行时
    // "Sautéing… (10s · esc to interrupt)"。只认 Brewed 曾导致 "Sautéed for 10m 29s"
    // 的时长被误判为运行时间，会话卡死在"程序运行中"永不发继续。
    // \S+ed 兼容含重音字符的动词（Sautéed）；时长兼容 "30s" / "10m 29s" / "1h 21m 8s"
    // （长任务会出现小时级，漏掉 h 会导致完成标志识别不出、时长被当运行计时器）。
    // 只看末尾 600 字符：完成标志总在提示符正上方，历史轮次的旧标志不该抵消当前运行状态
    const hasBrewedFor = /\b\S+ed for (\d+h\s*)?(\d+m\s*)?\d+s\b/i.test(cleanContent.slice(-600));

    // 提前声明 isCompacting，供后续 stateDesc 使用（跨 aiType 分支）
    let isCompacting = false;

    if (aiType === 'claude') {
      // Claude Code 运行中标志
      // 如果是确认界面或等待接受编辑，不判断为运行中
      // 如果有空闲提示符（❯），状态栏的 esc to interrupt 可能是后台 shell，不代表 claude 在运行
      isCompacting = /Evaporat|Compact|Summariz|Churning/i.test(cleanContent) && /\(\d+[ms]\s*\d*s?\s*[·•]?\s*[↓↑]/i.test(cleanContent);
      // 活跃运行状态词：Claude Code 运行时显示任意文本 + "..." + 时间/token 指示器
      // 使用 fullyCleanContent 避免光标移动等 ANSI 序列破坏运行状态文本
      const last500 = fullyCleanContent.slice(-500);
      // 进行时 spinner（"✢ Frolicking…"）可能不带计时器后缀也表示运行中——
      // 注意运行中屏幕上输入框 ❯ 依然存在，"有空闲提示符"不构成空闲证据，
      // 进行时(…ing) vs 过去式(Xxxed for Ys) 才是运行/完成的可靠区分
      const isActivelyRunning = RUNNING_TIMER_RE.test(last500) ||
        RUNNING_SPINNER_RE.test(last500);
      const hasRunningIndicator = !hasIdlePromptForAccept && (
        /esc to interrupt/i.test(cleanContent) ||
        /ctrl\+t to show todos/i.test(cleanContent)
      );
      // 运行时间只在最后500字符内检测，避免匹配到历史 timeout 参数
      // 但要排除 "Brewed for" 这种完成时间
      // 如果有 Brewed for 或 accept edits，说明任务已完成，不是运行中
      // 裸时长文本（"21m 8s"）不算运行证据——它同样出现在完成行 "Cooked for 1h 21m 8s"
      // 和正文里。真正的运行计时器一定带括号形式 "(2m 29s · ↓ tokens · esc to interrupt)"，
      // 故只认括号包裹的时长；裸时长曾使 1 小时长任务完成后被判成运行中、永不发继续
      const hasRecentRuntime = /\(\s*(\d+h\s*)?(\d+m\s*)?\d+s\s*[·•)]/.test(last500)
        && !hasBrewedFor && !isWaitingForAccept;

      // isActivelyRunning 优先级最高：即使屏幕残留 accept edits 文本，只要有活跃运行状态词就判定为运行中
      isRunning = !isConfirmDialog && (isActivelyRunning || isCompacting || (!isWaitingForAccept && (hasRunningIndicator || hasRecentRuntime)));
    } else if (aiType === 'codex') {
      // Codex CLI 运行中标志（排除确认界面）
      isRunning = !isConfirmDialog && (
        /\(\d+s\s*[•·]?\s*esc to interrupt\)/i.test(cleanContent) ||
        /(Reviewing|Generating|Executing|Processing|Thinking).*\(\d+s/i.test(cleanContent) ||
        /esc to interrupt/i.test(cleanContent)
      );
    } else if (aiType === 'gemini') {
      // Gemini CLI 运行中标志（排除确认界面）
      isRunning = !isConfirmDialog && (
        /GoogleSearch\s+Searching/i.test(cleanContent) ||
        /(ReadFile|WriteFile|Shell)\s+(Reading|Writing|Running)/i.test(cleanContent) ||
        /gemini-2\.5.*\.\.\./i.test(cleanContent) ||
        /(Thinking|Generating|Processing).*\.\.\./i.test(cleanContent)
      );
    } else if (aiType === 'droid') {
      // Droid CLI 运行中标志（排除确认界面）
      isRunning = !isConfirmDialog && (
        /esc to interrupt/i.test(cleanContent) ||
        /Thinking|Processing|Generating/i.test(cleanContent) ||
        /\(\d+m\s*\d+s\)|\d+m\s+\d+s\s*$/.test(cleanContent.slice(-500))
      );
    } else if (aiType === 'opencode') {
      // OpenCode CLI 运行中标志（排除确认界面）
      // OpenCode 特有标志：[build] thinking, [plan] thinking
      isRunning = !isConfirmDialog && (
        /esc to interrupt/i.test(cleanContent) ||
        /\[build\].*thinking|\[plan\].*thinking/i.test(cleanContent) ||
        /Thinking|Processing|Generating/i.test(cleanContent) ||
        /\(\d+m\s*\d+s\)|\d+m\s+\d+s\s*$/.test(cleanContent.slice(-500))
      );
    } else if (aiType === 'grok') {
      // Grok 运行/空闲态已在插件分析前的高优先级块处理（见上方 aiType==='grok' 分支）
      // 此处保留兜底：若走到这里仍按运行态标志判断
      const grokLast500 = fullyCleanContent.slice(-500);
      isRunning = !isConfirmDialog && (
        /Ctrl\+c:cancel|Ctrl\+o:interject/i.test(grokLast500) ||
        /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*Waiting|Waiting…/i.test(grokLast500) ||
        /\d+\.\d+s\s+⇣/i.test(grokLast500)
      );
    } else {
      // 通用检测（排除确认界面）
      const last500 = cleanContent.slice(-500);
      isRunning = !isConfirmDialog && (
        /esc to interrupt/i.test(cleanContent) ||
        /\(\d+m\s*\d+s\)|\d+m\s+\d+s\s*$/.test(last500)
      );
    }

    if (isRunning) {
      const stateDesc = isCompacting ? '上下文压缩中' : '程序运行中';
      console.log(`[AIEngine] 检测到${stateDesc}, CLI: ${cliName}`);
      return {
        currentState: stateDesc,
        workingDir: '未显示',
        recentAction: '执行中',
        needsAction: false,
        actionType: 'none',
        suggestedAction: null,
        actionReason: `${cliName} 正在工作，不应打断`,
        suggestion: null,
        updatedAt: new Date().toISOString(),
        preAnalyzed: true,
        detectedCLI,
        ...pluginInfo
      };
    }

    // 1.4 检测 Claude Code 评分/反馈对话框（"How is Claude doing?" 1: Bad 2: Fine 3: Good 0: Dismiss）
    // 自动发送 0（Dismiss）跳过评分，让 Claude 继续工作
    if (/How is Claude doing.*\(optional\)/i.test(cleanContent) && /0:\s*Dismiss/i.test(cleanContent)) {
      console.log('[AIEngine] 检测到 Claude 评分对话框，自动 Dismiss');
      return {
        currentState: 'Claude 评分对话框',
        workingDir: '未显示',
        recentAction: '跳过评分',
        needsAction: true,
        actionType: 'single_char',
        suggestedAction: '0',
        actionReason: '检测到 Claude 评分对话框，自动发送 0 (Dismiss) 跳过',
        suggestion: null,
        updatedAt: new Date().toISOString(),
        preAnalyzed: true,
        detectedCLI,
        ...pluginInfo
      };
    }

    // 1.5 检测 accept edits 状态：发送"继续"而非 Tab
    // 原因：Tab 通过 tmux send-keys 不可靠，"继续"文本输入更稳定且能让 Claude 推进 Sprint
    if (isWaitingForAccept) {
      // 重要：先检查是否正在运行中（活跃运行状态词）
      // 使用更彻底的 ANSI 清理，避免光标移动等序列破坏运行状态文本
      const fullyClean = fullyCleanContent;
      const last500 = fullyClean.slice(-500);
      const isActivelyRunning = RUNNING_TIMER_RE.test(last500);
      if (isActivelyRunning) {
        console.log(`[AIEngine] 检测到活跃运行状态，跳过 accept edits 处理`);
        return {
          currentState: '程序运行中',
          workingDir: '未显示',
          recentAction: '执行中',
          needsAction: false,
          actionType: 'none',
          suggestedAction: null,
          actionReason: `${cliName} 正在工作，不应打断`,
          suggestion: null,
          updatedAt: new Date().toISOString(),
          preAnalyzed: true,
          detectedCLI,
          ...pluginInfo
        };
      }

      // 这条分支的成立条件里包含「没看到空提示符」，而输入框里留着未提交文本时
      // 恰好也满足 —— 于是会在已有内容后面再打一个「继续」，拼成没法用的指令。
      // 先把这种情况分出去：自己的指令回车提交，用户的内容不碰。
      const acceptPending = promptPendingText(fullyCleanContent);
      if (acceptPending) {
        const own = isOwnPendingInput(acceptPending, ['继续'], projectContext?.lastSentText);
        console.log(`[AIEngine] 输入框有未提交内容「${acceptPending.slice(0, 30)}」，${own ? '发送回车提交' : '疑似用户输入，暂不操作'}`);
        return {
          currentState: own ? `${cliName}有未提交的自动指令` : `${cliName}输入框有你未提交的内容`,
          workingDir: '未显示',
          recentAction: own ? '等待提交' : '等待用户',
          needsAction: own,
          actionType: own ? 'key' : 'none',
          suggestedAction: own ? 'Enter' : null,
          actionReason: own
            ? `输入框里留着自动指令「${acceptPending.slice(0, 30)}」尚未提交，发送回车`
            : `输入框里有你未提交的内容「${acceptPending.slice(0, 30)}」，已暂停自动操作`,
          suggestion: null,
          updatedAt: new Date().toISOString(),
          preAnalyzed: true,
          detectedCLI,
          ...pluginInfo
        };
      }

      console.log(`[AIEngine] 检测到 ${cliName} 等待接受编辑，发送"继续"`);
      return {
        currentState: `${cliName}等待接受编辑`,
        workingDir: '未显示',
        recentAction: '等待接受编辑',
        needsAction: true,
        actionType: 'text_input',
        suggestedAction: '继续',
        actionReason: '检测到编辑等待接受，发送"继续"让 Claude 推进',
        suggestion: null,
        updatedAt: new Date().toISOString(),
        preAnalyzed: true,
        detectedCLI,
        ...pluginInfo
      };
    }

    // 2. 检测确认界面（Do you want to...）
    const isEditConfirm = /Do you want to (make this edit|create|delete|run)/i.test(cleanContent);
    const hasOption1Yes = /1\.\s*Yes/i.test(cleanContent);
    const hasOption2Yes = /2\.\s*Yes/i.test(cleanContent);

    // v1.2.81 验活闸（同早期分支）：Claude 侧必须屏上有活菜单才发键
    if (isEditConfirm && hasOption1Yes && confirmMenuLiveEarly) {
      // 检测选项 2 是否是"永久允许某命令模式"
      const isOption2PermanentAllow = /2\.\s*Yes,\s*and\s+don.t\s+ask\s+again\s+for:/i.test(cleanContent);
      // 有选项2且不是永久允许时选2（允许本次会话），否则选1
      const selectOption = (hasOption2Yes && !isOption2PermanentAllow) ? '2' : '1';
      console.log(`[AIEngine] 检测到 ${cliName} 确认界面，选择选项 ${selectOption}${isOption2PermanentAllow ? '（跳过永久允许）' : ''}`);
      return {
        currentState: `${cliName}确认界面`,
        workingDir: '未显示',
        recentAction: '等待确认',
        needsAction: true,
        actionType: 'select',
        suggestedAction: selectOption,
        actionReason: hasOption2Yes ? '选择"允许本次会话"以自动化流程' : '选择"Yes"继续执行',
        suggestion: null,
        updatedAt: new Date().toISOString(),
        preAnalyzed: true,
        detectedCLI,
        ...pluginInfo
      };
    }

    // 2. 检测可重试的 API 错误（如 rate_limit）
    // 注意：thinking block 相关错误已在上面（最高优先级）处理
    const hasRetryableError = /API Error.*rate_limit/i.test(cleanContent) ||
                              /API Error.*overloaded/i.test(cleanContent) ||
                              /API Error.*5\d{2}/i.test(cleanContent);  // 5xx 服务器错误

    if (hasRetryableError && hasInputPromptForError) {
      console.log('[AIEngine] 检测到可重试的 API 错误，发送"继续"重试');
      return {
        currentState: 'API错误可重试',
        workingDir: '未显示',
        recentAction: 'API调用失败',
        needsAction: true,
        actionType: 'text_input',
        suggestedAction: '继续',
        actionReason: '检测到可重试的 API 错误，自动发送"继续"重试',
        suggestion: null,
        updatedAt: new Date().toISOString(),
        preAnalyzed: true,
        detectedCLI,
        ...pluginInfo
      };
    }

    // 3. 先检测询问问题状态（优先级高于编辑确认）
    // 因为状态栏的 "shift+tab to cycle" 始终存在，不能仅凭此判断编辑确认
    const last1000Chars = terminalContent.slice(-1000);
    const cleanLast1000 = last1000Chars.replace(/\x1b\[[0-9;]*m/g, '');
    const hasInputPromptEarly = /^>\s*$/m.test(cleanLast1000) || />\s*\|/.test(cleanLast1000) || /\n>\s*$/.test(cleanLast1000);

    if (hasInputPromptEarly) {
      // 「是否需要 X？」是**内容问题**（是否需要我把这些也加上测试／同时更新文档），
      // 回"继续"从来不是答案，CLI 只能再问一遍或自行乱选。原来这里硬答"继续"，
      // 现在不拦：让它落到下面的通用判定，由 analyzeStatus 的 hasPendingQuestion
      // 升级给 AI 读屏作答；AI 不可用时会交出"CLI 正在提问"状态请人工回答。
      // 注意与紧随其后的「是否继续 X？」区分开——那个问题"继续"确实是有效答案。

      // 检测"是否继续"类问题 - 应该自动回答"继续"
      const isContinueQuestionEarly = /是否继续.{0,20}[？?]/i.test(cleanLast1000);
      if (isContinueQuestionEarly) {
        console.log('[AIEngine] 检测到"是否继续"问题，自动回答继续');
        return {
          currentState: `${cliName}询问是否继续`,
          workingDir: '未显示',
          recentAction: '显示问题',
          needsAction: true,
          actionType: 'text_input',
          suggestedAction: '继续',
          actionReason: '自动回答继续以保持工作流程',
          suggestion: null,
          updatedAt: new Date().toISOString(),
          preAnalyzed: true,
          detectedCLI,
        ...pluginInfo
        };
      }

      // 检测"请告知..."类询问 - 需要用户输入
      const isAskForInput = /请告知.{0,30}[。？?]/i.test(cleanLast1000);
      if (isAskForInput) {
        console.log('[AIEngine] 检测到"请告知..."询问，等待用户输入');
        return {
          currentState: '等待用户输入',
          workingDir: '未显示',
          recentAction: '显示询问',
          needsAction: false,
          actionType: 'none',
          suggestedAction: null,
          actionReason: '等待用户提供信息，不自动操作',
          suggestion: null,
          updatedAt: new Date().toISOString(),
          preAnalyzed: true,
          detectedCLI,
        ...pluginInfo
        };
      }
    }

    // 4. 检测 Claude Code 编辑确认界面（>> accept edits on）
    // 注意：必须有 ">>" 双箭头才是真正的编辑确认界面
    // 单独的 "shift+tab to cycle" 只是状态栏提示，不代表有编辑等待确认
    // 真正的编辑确认界面会显示文件路径和 diff 内容
    const hasDoubleArrow = /^>>\s/m.test(cleanContent) || /\n>>\s/m.test(cleanContent);
    const hasEditContent = /\+\+\+|---|\@\@.*\@\@/m.test(cleanContent); // diff 格式
    if (hasDoubleArrow && (hasEditContent || /accept edits/i.test(cleanContent))) {
      console.log(`[AIEngine] 检测到 ${cliName} 编辑确认界面(Tab模式)，等待用户确认`);
      return {
        currentState: `${cliName}等待编辑确认`,
        workingDir: '未显示',
        recentAction: '等待用户按Tab确认编辑',
        needsAction: false,
        actionType: 'none',
        suggestedAction: null,
        actionReason: '用户需要按 Tab 键确认或拒绝编辑，不自动操作',
        suggestion: null,
        updatedAt: new Date().toISOString(),
        preAnalyzed: true,
        detectedCLI,
        ...pluginInfo
      };
    }

    // 5. 检测普通确认界面（Do you want to proceed?）
    // 如果有选项 2 且不是永久允许某命令模式，选择 2；否则选择 1
    if (/Do you want to proceed\?/i.test(cleanContent) &&
        /1\.\s*Yes/i.test(cleanContent) &&
        confirmMenuLiveEarly) {  // v1.2.81 验活闸（同早期分支）
      const hasOption2 = /2\.\s*Yes/i.test(cleanContent);
      const isOption2Permanent = /2\.\s*Yes,\s*and\s+don't\s+ask\s+again\s+for:/i.test(cleanContent);
      const selectOpt = (hasOption2 && !isOption2Permanent) ? '2' : '1';
      console.log(`[AIEngine] 检测到普通确认界面，选择选项 ${selectOpt}${isOption2Permanent ? '（跳过永久允许）' : ''}`);
      return {
        currentState: '确认界面',
        workingDir: '未显示',
        recentAction: '等待确认',
        needsAction: true,
        actionType: 'select',
        suggestedAction: selectOpt,
        actionReason: (hasOption2 && !isOption2Permanent) ? '选择"允许本次会话"以自动化流程' : '选择"Yes"继续执行',
        suggestion: null,
        updatedAt: new Date().toISOString(),
        preAnalyzed: true,
        detectedCLI,
        ...pluginInfo
      };
    }

    // 2.6 先检测问句（优先于空闲状态检测）
    // 检查最后 800 字符中是否有问句
    const last800Chars = terminalContent.slice(-800);
    const cleanLast800 = last800Chars.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

    // 检测"继续实现"类问题 - 应该自动回答"继续"
    const isContinueImplementQuestion = /(要继续|是否继续|继续.{0,10}实现.{0,20}[？?])/i.test(cleanLast800);
    if (isContinueImplementQuestion) {
      console.log('[AIEngine] 检测到"继续实现"问题，自动回答继续');
      return {
        currentState: `${cliName}询问是否继续`,
        workingDir: '未显示',
        recentAction: '显示问题',
        needsAction: true,
        actionType: 'text_input',
        suggestedAction: '继续',
        actionReason: '自动回答继续以保持工作流程',
        suggestion: null,
        updatedAt: new Date().toISOString(),
        preAnalyzed: true,
        detectedCLI,
        ...pluginInfo
      };
    }

    // 2.65 检测 Codex 空闲状态
    // Codex 的空闲屏与 Claude Code 完全不同，套用 2.7 的规则会永远判不出空闲：
    //   › Implement {feature}                       ← 提示符是 ›(U+203A)，且带占位提示文字
    //     gpt-5.6-sol xhigh · ~/path/to/project     ← 底部栏没有 accept edits
    // 三处都对不上 2.7 的 /^[❯>]\s*$/ + /accept edits/，导致自动模式一直"等待"不发继续。
    if (aiType === 'codex') {
      const codexTail = fullyCleanContent.slice(-600);
      // 空闲证据：占位提示符行 + 底部「模型 · 工作目录」栏
      const hasCodexIdlePrompt = /^\s*[›❯>]\s+\S/m.test(last5Lines);
      const hasCodexFooter = /·\s*[~/][^\s]*/.test(codexTail);
      if (hasCodexIdlePrompt && hasCodexFooter && !isCliBusy(codexTail)) {
        // 已表示任务完成/无更多工作时停手，不机械发继续。
        // 判定收敛到 taskDonePattern：「本批已完成 … 下一批目标是 …」属于进度汇报，不是收工。
        if (isTaskDone(fullyCleanContent.slice(-800))) {
          console.log('[AIEngine] Codex 已表示无更多任务，停止自动发送继续');
          return {
            currentState: '任务已完成',
            workingDir: '未显示',
            recentAction: 'Codex 表示无更多任务',
            needsAction: false,
            actionType: 'none',
            suggestedAction: null,
            actionReason: 'Codex 已表示没有更多任务，不再发送继续',
            suggestion: null,
            updatedAt: new Date().toISOString(),
            preAnalyzed: true,
            detectedCLI,
            ...pluginInfo
          };
        }
        console.log('[AIEngine] 检测到 Codex 空闲（占位提示符 + 模型/目录栏），自动发送继续');
        return {
          currentState: 'Codex 空闲',
          workingDir: '未显示',
          recentAction: '等待输入',
          needsAction: true,
          actionType: 'text_input',
          suggestedAction: '继续',
          actionReason: '空闲状态，自动继续开发',
          suggestion: null,
          updatedAt: new Date().toISOString(),
          preAnalyzed: true,
          detectedCLI,
          ...pluginInfo
        };
      }
    }

    // 2.7 检测 Claude Code 空闲状态（有提示符 + accept edits 状态栏）
    // 底部状态栏的 "accept edits on" 只是提示，不需要按 Tab
    // 空闲状态下应该自动发送"继续"让 Claude Code 继续开发
    // 复用前面声明的 last5Lines
    const hasPrompt = /^[❯>]\s*$/m.test(last5Lines) || /\n[❯>]\s*$/m.test(last5Lines);
    const isEditConfirmMode = />>.*accept edits/i.test(cleanContent) || /shift\+tab to cycle/i.test(cleanContent);
    if (hasPrompt && /accept edits/i.test(cleanContent) && !isEditConfirmMode) {
      // 重要：先检查是否正在运行中（使用 fullyCleanContent 避免 ANSI 序列干扰）
      const last500 = fullyCleanContent.slice(-500);
      const isActivelyRunning = isCliBusy(last500);
      if (isActivelyRunning) {
        console.log(`[AIEngine] 检测到活跃运行状态，跳过空闲处理`);
        return {
          currentState: '程序运行中',
          workingDir: '未显示',
          recentAction: '执行中',
          needsAction: false,
          actionType: 'none',
          suggestedAction: null,
          actionReason: `${cliName} 正在工作，不应打断`,
          suggestion: null,
          updatedAt: new Date().toISOString(),
          preAnalyzed: true,
          detectedCLI,
          ...pluginInfo
        };
      }

      // 检测 Claude 已表示任务完成/无更多工作
      const taskDone800 = fullyCleanContent.slice(-800);
      if (isTaskDone(taskDone800)) {
        console.log(`[AIEngine] 检测到 ${cliName} 表示任务已完成，停止自动操作`);
        return {
          currentState: '任务已完成',
          workingDir: '未显示',
          recentAction: 'Claude 表示无更多任务',
          needsAction: false,
          actionType: 'none',
          suggestedAction: null,
          actionReason: 'Claude 已表示没有更多任务，不再发送继续',
          suggestion: null,
          updatedAt: new Date().toISOString(),
          preAnalyzed: true,
          detectedCLI,
          ...pluginInfo
        };
      }

      console.log(`[AIEngine] 检测到 ${cliName} 空闲（有 accept edits 状态栏），自动发送继续`);
      return {
        currentState: `${cliName}空闲`,
        workingDir: '未显示',
        recentAction: '等待输入',
        needsAction: true,
        actionType: 'text_input',
        suggestedAction: '继续',
        actionReason: '空闲状态，自动继续开发',
        suggestion: null,
        updatedAt: new Date().toISOString(),
        preAnalyzed: true,
        detectedCLI,
        ...pluginInfo
      };
    }

    // 2.8 检测 Claude Code 空闲状态下的中文问句
    // 检测 > 提示符（可能带有空格或光标）
    // 支持多种格式：行首 >、> 后有光标、行尾 >、独立的 > 字符
    const hasInputPrompt = /^[❯>]\s*$/m.test(cleanLast800) || /[❯>]\s*\|/.test(cleanLast800) || /\n[❯>]\s*$/.test(cleanLast800) || /─>─/.test(cleanLast800);

    if (hasInputPrompt) {
      // 重要：先检查是否正在运行中（使用 fullyCleanContent 避免 ANSI 序列干扰）
      // ⚠️ 运行中屏幕上 ❯ 输入框**依然存在**，所以"有提示符"不构成空闲证据，
      //    必须把运行证据查全再决定。除计时器外还要认 esc to interrupt：
      //    CLI 重试网络错误时（"✻ 504 · Retrying in 31s · attempt 8/10"）没有
      //    spinner 计时器，只有状态栏那句 esc to interrupt，原来这里只查计时器
      //    → 判成"空闲"发"继续"，正好打断 CLI 自己的重试。
      //    这也与 server/index.js 末端保护的口径统一（那边 esc 无条件拦截）。
      const isActivelyRunning = isCliBusy(fullyCleanContent.slice(-800));
      if (isActivelyRunning) {
        console.log('[AIEngine] 检测到活跃运行状态，跳过空闲处理');
        return {
          currentState: '程序运行中',
          workingDir: '未显示',
          recentAction: '执行中',
          needsAction: false,
          actionType: 'none',
          suggestedAction: null,
          actionReason: `${cliName} 正在工作，不应打断`,
          suggestion: null,
          updatedAt: new Date().toISOString(),
          preAnalyzed: true,
          detectedCLI,
          ...pluginInfo
        };
      }

      // 检测"是否继续"类问题 - 应该自动回答"继续"
      const isContinueQuestion = /是否继续.{0,20}[？?]/i.test(cleanLast800);
      if (isContinueQuestion) {
        console.log('[AIEngine] 检测到"是否继续"问题，自动回答继续');
        return {
          currentState: `${cliName}询问是否继续`,
          workingDir: '未显示',
          recentAction: '显示问题',
          needsAction: true,
          actionType: 'text_input',
          suggestedAction: '继续',
          actionReason: '自动回答继续以保持工作流程',
          suggestion: null,
          updatedAt: new Date().toISOString(),
          preAnalyzed: true,
          detectedCLI,
          ...pluginInfo
        };
      }

      // 检测需要用户手动输入的问题（如"请输入..."、"请选择..."）
      const needsUserInput = /请.{0,15}(输入|选择|确认|填写)/i.test(cleanLast800);
      if (needsUserInput) {
        console.log('[AIEngine] 检测到需要用户输入的提示，不自动操作');
        return {
          currentState: '等待用户输入',
          workingDir: '未显示',
          recentAction: '显示问题',
          needsAction: false,
          actionType: 'none',
          suggestedAction: null,
          actionReason: '等待用户回答问题，不自动操作',
          suggestion: null,
          updatedAt: new Date().toISOString(),
          preAnalyzed: true,
          detectedCLI,
          ...pluginInfo
        };
      }

      // 优先检测部署/脚本阶段（npm run、启动服务、localhost 等）
      // 只检查最近内容（最后800字符），避免历史内容中的关键词误判
      // 这种情况下不应该自动发送"继续"，而是提醒用户检查
      const isDeploymentContext = /(npm run|yarn start|启动服务|server.*running|deployment)/i.test(cleanLast800);
      if (isDeploymentContext) {
        console.log('[AIEngine] 部署/脚本阶段但有输入提示符，返回建议供执行');
        return {
          currentState: '部署/脚本阶段空闲',
          workingDir: '未显示',
          recentAction: '等待输入',
          needsAction: true,
          actionType: 'suggestion',  // 表示 suggestion 可以作为输入发送
          suggestedAction: null,
          actionReason: '部署/脚本阶段空闲，提醒检查服务状态',
          suggestion: '请检查服务状态和未完成项目',
          hasInputPrompt: true,
          updatedAt: new Date().toISOString(),
          preAnalyzed: true,
          detectedCLI,
          ...pluginInfo
        };
      }

      // 检测开发阶段空闲状态 - 有 > 或 ❯ 提示符，刚完成操作，应该发送"继续"
      // 策略：只要 Claude Code 空闲且自动操作开启，默认发送"继续"
      // 不再依赖关键词匹配，因为各种语言/框架的关键词太多无法穷举

      // 检测 Claude 已表示任务完成/无更多工作 - 不应再发"继续"
      // 常见表述：没有任务、已完成所有、没有更多、all done、nothing to do 等
      if (isTaskDone(cleanLast800)) {
        console.log('[AIEngine] 检测到 Claude 表示任务已完成/无更多工作，停止自动操作');
        return {
          currentState: '任务已完成',
          workingDir: '未显示',
          recentAction: 'Claude 表示无更多任务',
          needsAction: false,
          actionType: 'none',
          suggestedAction: null,
          actionReason: 'Claude 已表示没有更多任务，不再发送继续',
          suggestion: null,
          updatedAt: new Date().toISOString(),
          preAnalyzed: true,
          detectedCLI,
          ...pluginInfo
        };
      }

      // 输入框里若留着没提交的文本，只需要回车 —— 再发「继续」会把它拼成
      // 「原文本+继续」，既不是原意也不是能用的指令。
      const pendingInput = promptPendingText(fullyCleanContent);
      if (pendingInput) {
        // 只提交我们自己打进去的（以「继续」开头）。用户可能正打到一半在思考，
        // 替他按回车会把半截话发出去 —— 那比不操作更糟，而用户输入暂停只挡 5 秒。
        const own = isOwnPendingInput(pendingInput, ['继续'], projectContext?.lastSentText);
        console.log(`[AIEngine] 输入框有未提交内容「${pendingInput.slice(0, 30)}」，${own ? '发送回车提交' : '疑似用户输入，暂不操作'}`);
        return {
          currentState: own ? `${cliName}有未提交的自动指令` : `${cliName}输入框有你未提交的内容`,
          workingDir: '未显示',
          recentAction: own ? '等待提交' : '等待用户',
          needsAction: own,
          actionType: own ? 'key' : 'none',
          suggestedAction: own ? 'Enter' : null,
          actionReason: own
            ? `输入框里留着自动指令「${pendingInput.slice(0, 30)}」尚未提交，发送回车`
            : `输入框里有你未提交的内容「${pendingInput.slice(0, 30)}」，已暂停自动操作`,
          suggestion: null,
          updatedAt: new Date().toISOString(),
          preAnalyzed: true,
          detectedCLI,
          ...pluginInfo
        };
      }

      console.log('[AIEngine] 检测到空闲状态（❯ 提示符），自动发送继续');
      return {
        currentState: `${cliName}空闲`,
        workingDir: '未显示',
        recentAction: '等待输入',
        needsAction: true,
        actionType: 'text_input',
        suggestedAction: '继续',
        actionReason: '空闲状态，自动继续开发',
        suggestion: null,
        updatedAt: new Date().toISOString(),
        preAnalyzed: true,
        detectedCLI,
        ...pluginInfo
      };
    }

    // 注意：底部状态栏的 "accept edits on" 只是提示，不需要任何操作
    // Claude Code 不会有需要按 Tab 接受编辑的界面，编辑确认使用的是选项菜单（1/2/3）

    // 3. 检测其他程序运行中的情况
    if (/ctrl\+c to cancel/i.test(terminalContent)) {
      return {
        currentState: '程序运行中',
        workingDir: '未显示',
        recentAction: '执行中',
        needsAction: false,
        actionType: 'none',
        suggestedAction: null,
        actionReason: '程序正在运行，不应打断',
        suggestion: null,
        updatedAt: new Date().toISOString(),
        preAnalyzed: true,
        detectedCLI,
        ...pluginInfo
      };
    }

    // 4. 检测质量调查/评分界面
    if (/How did Claude do\?|Rate response|quality survey/i.test(terminalContent)) {
      return {
        currentState: '质量调查界面',
        workingDir: '未显示',
        recentAction: '显示调查',
        needsAction: false,
        actionType: 'none',
        suggestedAction: null,
        actionReason: '不自动填写调查',
        suggestion: null,
        updatedAt: new Date().toISOString(),
        preAnalyzed: true,
        detectedCLI,
        ...pluginInfo
      };
    }

    // 5. 检测 API 错误（需要 AI 判断错误类型）
    // 只检查最近 30 行内容，避免被历史错误干扰
    const recentLines = cleanContent.split('\n').slice(-30).join('\n');

    // 统计错误出现次数
    const errorPatterns = [
      /Error writing file/gi,
      /API Error/gi,
      /Connection error/gi,
      /bad response status code/gi,
      /我遇到了工具调用问题/g,
    ];
    let totalErrors = 0;
    let matchedPatterns = [];
    for (const pattern of errorPatterns) {
      const matches = recentLines.match(pattern);
      if (matches) {
        totalErrors += matches.length;
        matchedPatterns.push(`${pattern.source}(${matches.length}次)`);
      }
    }

    // 如果检测到错误，返回特殊标记，让调用方进行 AI 错误分析
    if (totalErrors >= 1) {
      console.log(`[AIEngine] 检测到 API 错误 (${totalErrors}次)，匹配模式: ${matchedPatterns.join(', ')}`);
      console.log(`[AIEngine] 最近30行内容预览: ${recentLines.slice(0, 500)}...`);
      return {
        currentState: 'API错误待分析',
        workingDir: '未显示',
        recentAction: 'API错误',
        needsAction: false,  // 暂不操作，等 AI 分析
        actionType: 'none',
        suggestedAction: null,
        actionReason: '检测到 API 错误，需要 AI 分析错误类型',
        suggestion: null,
        updatedAt: new Date().toISOString(),
        preAnalyzed: true,
        detectedCLI,
        ...pluginInfo,
        needsErrorAnalysis: true,  // 标记需要 AI 错误分析
        errorContent: recentLines,  // 传递错误内容供 AI 分析
        errorCount: totalErrors
      };
    }

    // 6. 检测简单的Y/N确认
    if (/\[Y\/n\]|\[y\/N\]|\(y\/n\)/i.test(terminalContent)) {
      // 根据大写字母判断默认值：[Y/n] 默认y，[y/N] 默认n
      let suggestedAction = 'y';
      if (/\[y\/N\]/.test(terminalContent)) {
        suggestedAction = 'n';
      }
      return {
        currentState: '等待Y/N确认',
        workingDir: '未显示',
        recentAction: '等待确认',
        needsAction: true,
        actionType: 'confirm',
        suggestedAction,
        actionReason: '简单确认提示',
        suggestion: null,
        updatedAt: new Date().toISOString(),
        preAnalyzed: true,
        detectedCLI,
        ...pluginInfo
      };
    }

    // 6. 检测 CLI 崩溃后回到 Shell（需要自动恢复）
    // 特征：终端内容包含 Node.js 崩溃错误 + shell 提示符
    const crashPatterns = [
      /RangeError:\s*Maximum call stack size exceeded/i,
      /FATAL ERROR/i,
      /JavaScript heap out of memory/i,
      /SIGKILL|SIGTERM|SIGSEGV/,
      /Error:.*cannot continue/i,
      /Unhandled.*rejection/i,
      /TypeError:.*undefined/i,
      /SyntaxError:.*Unexpected/i
    ];

    const hasCrashError = crashPatterns.some(pattern => pattern.test(terminalContent));
    const isShellPrompt = /\w+@\w+.*[%$#]\s*$/.test(cleanContent) ||  // user@host ... %
                          /^[\$%#]\s*$/m.test(cleanContent);           // 单独的 $ % #

    // 如果检测到崩溃错误且回到了 shell 提示符，需要自动恢复
    if (hasCrashError && isShellPrompt) {
      const cliCommand = getCliCommand(aiType);
      return {
        currentState: `${cliName}崩溃`,
        workingDir: '未显示',
        recentAction: 'CLI异常退出',
        needsAction: true,
        actionType: 'text_input',
        suggestedAction: cliCommand,
        actionReason: `${cliName}崩溃后退出，需要重新启动继续开发`,
        suggestion: null,
        updatedAt: new Date().toISOString(),
        preAnalyzed: true,
        detectedCLI,
        ...pluginInfo
      };
    }

    // 7. 检测致命错误（CLI 还在运行，需要退出）
    if (/(fatal|crashed|Error:.*cannot continue)/i.test(terminalContent) &&
        !/Do you want to proceed\?/i.test(terminalContent) &&
        !isShellPrompt) {
      return {
        currentState: `${cliName}致命错误`,
        workingDir: '未显示',
        recentAction: '发生错误',
        needsAction: true,
        actionType: 'text_input',
        suggestedAction: '/quit',
        actionReason: `${cliName}遇到致命错误，需要退出`,
        suggestion: null,
        updatedAt: new Date().toISOString(),
        preAnalyzed: true,
        detectedCLI,
        ...pluginInfo
      };
    }

    // 8. 检测Shell命令行（CLI 正常退出，不需要紧急操作）
    if (isShellPrompt && !/^>\s*$/m.test(cleanContent)) {
      return {
        currentState: 'Shell命令行',
        workingDir: '未显示',
        recentAction: `${cliName}已退出`,
        needsAction: false,
        actionType: 'none',
        suggestedAction: null,
        actionReason: null,
        suggestion: `可输入 ${getCliCommand(aiType)} 重新启动${cliName}`,
        updatedAt: new Date().toISOString(),
        preAnalyzed: true,
        detectedCLI,
        ...pluginInfo
      };
    }

    // 9. 检测部署/脚本阶段关键词（没有输入提示符的情况）
    // 注意：有输入提示符的情况已在前面的 hasInputPrompt 块中处理
    if (/(npm run|yarn start|启动服务|localhost:\d+|server.*running|deployment)/i.test(terminalContent)) {
      // 没有输入提示符，说明服务正在运行，不自动操作
      return {
        currentState: '部署/脚本阶段',
        workingDir: '未显示',
        recentAction: '运行服务',
        needsAction: false,
        actionType: 'none',
        suggestedAction: null,
        actionReason: '需要人工检查',
        suggestion: '请检查服务状态和未完成项目',
        updatedAt: new Date().toISOString(),
        preAnalyzed: true,
        detectedCLI,
        ...pluginInfo
      };
    }

    // 无法通过简单规则判断，需要AI分析
    return null;
  }

  /**
   * 分析终端状态
   * @param {string} terminalContent - 终端内容
   * @param {string} aiType - AI 类型 (claude/codex/gemini)
   * @param {string} sessionId - 会话 ID
   * @param {string} tmuxSession - tmux 会话名称（可选，用于进程检测）
   * @param {object} projectContext - 项目上下文（可选，用于插件选择）
   *   projectContext.sessionProviderId - 本会话正在用的供应商 ID（可选）。给了就用它的凭证
   *   做监控分析，实现"监控 AI 跟随当前工作供应商"；取不到 HTTP 凭证时自动回退 CLI。
   *   projectContext.providerEnv - CLI 回退时注入的环境变量（applySessionProvider 的产物）
   * @param {string} forcedPluginId - 强制使用的插件 ID（可选）
   */
  async analyzeStatus(terminalContent, aiType = 'claude', sessionId = null, tmuxSession = null, projectContext = null, forcedPluginId = null) {
    // 因「CLI 正在提问」而被丢弃的预判断结果。AI 不可用时不能就这么什么都不返回：
    // 屏幕上挂着一个真问题，用户界面却一片空白，等于问题被静默吞掉。
    let escalatedQuestion = null;
    // 先尝试预判断（传递完整参数）
    const preResult = this.preAnalyzeStatus(terminalContent, aiType, tmuxSession, projectContext, forcedPluginId);
    if (preResult) {
      // CLI 把球踢回来问「你想让我接着做哪个？」这类问题时，机械回「继续」等于没回答，
      // CLI 只能再问一遍或自行乱选。这种场景丢弃预判断结果、改走 AI，让它读完屏幕
      // 给出有内容的答复（如「按顺序完成，先做第 1 项」）。
      // 只拦「本来就要发继续」的情况：忙碌(needsAction:false)、确认菜单(select)、
      // 任务已完成等判定完全不受影响，成本也只在真有提问时才付。
      const mechanicalContinue = preResult.needsAction
        && preResult.actionType === 'text_input'
        && /^继续/.test(String(preResult.suggestedAction || ''));
      // 规则层明确说"这个我判不了"（如开着一个不认识的选项面板）时也升级给 AI
      const needsAi = preResult._needsAiJudgement === true;
      const cleanForAsk = String(terminalContent || '')
        .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
        .replace(/\x1b\][^\x07]*\x07/g, '');
      if (needsAi || (mechanicalContinue && hasPendingQuestion(cleanForAsk))) {
        console.log(needsAi
          ? '[AIEngine] 规则层判不了（选项面板），交给 AI 读屏决定'
          : '[AIEngine] 检测到 CLI 正在提问，改由 AI 生成有针对性的回答');
        escalatedQuestion = preResult;   // AI 不可用时用它兜底，见下方 _pendingQuestionStatus
      } else {
        console.log('[AIEngine] 预判断成功，跳过AI调用:', preResult.currentState);
        return preResult;
      }
    }

    // 需要AI分析
    const cliName = getCliName(aiType);
    const cliCommand = getCliCommand(aiType);
    const prompt = buildStatusPrompt({
      cliName,
      cliCommand,
      terminalContent,
      progressContext: this._buildProgressContext(projectContext) + this._buildHookContext(projectContext)
    });

    // 供应商三级选择：
    //   1. 会话自己的供应商有 HTTP 凭证 → 用它（凭证归属最清晰）
    //   2. 会话是 OAuth 登录（取不到 key）→ 借一个带凭证的第三方做监控
    //      （监控只是读屏判状态，用谁的 key 结果一样，比每次烧 4.3 万 tokens 走 CLI 划算）
    //   3. 两者都没有 → CLI 兜底
    let sessionSettings = projectContext?.sessionProviderId
      ? this.resolveSessionSettings(aiType, projectContext.sessionProviderId)
      : null;
    if (!sessionSettings) {
      sessionSettings = this.getProxyMonitorSettings(projectContext?.providerPriority || []);
    }

    // 会话供应商和全局配置都没有可用的 HTTP 凭证时，不必先发一次注定 401 的请求，
    // 直接走 CLI（_noProvider 是 _loadSettings 第 5 级兜底打的标记）
    if (!sessionSettings && this.settings._noProvider) {
      const viaCli = await this._analyzeStatusViaCLI(prompt, sessionId, aiType, projectContext);
      if (viaCli) return viaCli;
      console.warn('[AIEngine] 无可用监控供应商，且 CLI 回退未产出结果');
      return this._pendingQuestionStatus(escalatedQuestion, aiType);
    }

    // 借来的代理供应商挂了就换下一个再试（实测 32 个带凭证供应商只有 2 个真能用，
    // 一次失败就回退 CLI 等于白扔一个便宜路径）。会话自己指定的供应商不参与轮换。
    const isProxy = !!sessionSettings?._isProxy;
    const maxAttempts = isProxy ? PROXY_MAX_ATTEMPTS : 1;
    let lastErr = null;

    for (let attempt = 0; attempt < maxAttempts && sessionSettings; attempt++) {
      try {
        // structured: 走 tool_use 强制 schema（仅 Claude 格式生效，其他供应商自动忽略）。
        // 具体供应商是否支持由 _callClaudeApi 按 apiUrl 判断并降级，这里无条件请求即可。
        const content = await this._callApiWithFailover(prompt, {
          sessionId,
          requestType: 'analyzeStatus',
          structured: true,
          settingsOverride: sessionSettings
        });

        if (!content) break;
        const parsed = this._parseStatusResponse(content);
        if (parsed) {
          // 记住这个真的调通过的代理，下次直接用它，省掉前面几个必挂的
          if (isProxy) this._proxyLastGood = sessionSettings._providerId;
          return parsed;
        }
        break;   // 拿到响应但解析不出结构 → 换供应商也没用
      } catch (err) {
        lastErr = err;
        console.error(`AI 状态分析错误（第 ${attempt + 1}/${maxAttempts} 次）:`, err.message);
        if (!isProxy) break;
        this.blacklistProxyProvider(sessionSettings._providerId, err.message);
        sessionSettings = this.getProxyMonitorSettings(projectContext?.providerPriority || []);
      }
    }

    // HTTP 路径彻底走不通：用 CLI 兜底——它复用 CLI 自己的登录态，OAuth 也能用。
    const viaCli = await this._analyzeStatusViaCLI(prompt, sessionId, aiType, projectContext);
    if (viaCli) return viaCli;
    const pending = this._pendingQuestionStatus(escalatedQuestion, aiType);
    if (pending) return pending;
    if (lastErr) throw lastErr;
    return null;
  }

  /**
   * AI 不可用时，把「CLI 正在提问」这件事本身交给用户。
   *
   * 不能退回预判断里那句机械的"继续"——正是因为它答非所问才升级给 AI 的；
   * 也不能返回 null 让界面一片空白。所以给一个只展示、不自动按键的状态，
   * 由人来读屏回答。actionType:'warning' 会被 server 的自动操作闸门拦下。
   */
  _pendingQuestionStatus(escalated, aiType) {
    if (!escalated) return null;
    // 面板类（规则层自己声明判不了）和提问类（机械「继续」被拦下）文案不同
    const isPanel = escalated._needsAiJudgement === true;
    console.warn(`[AIEngine] ${isPanel ? '选项面板' : 'CLI 提问'}需要 AI 判断但 AI 不可用，交由人工处理`);
    return {
      ...escalated,
      currentState: isPanel
        ? escalated.currentState
        : `${getCliName(aiType)}正在提问，等待你回答`,
      actionType: 'warning',
      // ⚠️ 必须清掉：escalated 里带着规则层那句「继续」，不清的话界面会在
      //    "请人工回答"旁边并排显示「建议操作：继续」，用户手点执行就会把那句
      //    我们刚判定为答非所问的话发出去。安全闸只拦自动发送，拦不住手动点击。
      suggestedAction: null,
      requireConfirmation: true,
      actionReason: isPanel
        ? `${escalated.actionReason || '屏上开着选项面板'}；监控 AI 此刻不可用，无法代为判断，请人工处理。`
        : 'CLI 提出了需要判断的问题，而监控 AI 此刻不可用。机械回"继续"等于没回答，请人工读屏答复。',
      _source: 'pending_question_no_ai'
    };
  }

  /**
   * CLI 回退分析：HTTP 路径拿不到凭证时用用户自己的 CLI 二进制跑一次。
   *
   * 为什么需要：官方 OAuth 登录的供应商 settings_config.env 是空的，没有 URL/key 可提取，
   * HTTP 路径结构上就用不了。CLI 则完全复用它自己的登录态（PlannerService 已用此法）。
   *
   * 为什么要节流：实测 CLI 单次固定开销约 4.3 万 input tokens（要加载全部 MCP/skill/plugin），
   * 折算 $0.04~$0.22。监控循环最快 15 秒一轮，不节流会烧钱。故同一会话限 5 分钟一次，
   * 且只在 HTTP 路径已经失败时才走到这里。
   */
  async _analyzeStatusViaCLI(prompt, sessionId, aiType, projectContext) {
    const now = Date.now();
    const key = sessionId || '_global';
    const last = this._cliFallbackAt.get(key) || 0;
    if (now - last < CLI_FALLBACK_INTERVAL) {
      console.log(`[AIEngine] CLI 回退节流中（${Math.round((CLI_FALLBACK_INTERVAL - (now - last)) / 1000)}s 后可再试）`);
      return null;
    }
    this._cliFallbackAt.set(key, now);

    try {
      console.log('[AIEngine] HTTP 路径不可用，改用 CLI 分析状态（复用 CLI 登录态）');
      const text = await this.generateTextViaCLI(prompt, {
        aiType: aiType || 'claude',
        // 用临时目录：避免加载项目 CLAUDE.md 进一步放大 token 开销
        cwd: os.tmpdir(),
        providerEnv: projectContext?.providerEnv || {},
        timeout: 120000
      });
      if (!text) return null;
      const parsed = this._parseStatusResponse(text);
      if (parsed) parsed._source = 'cli_fallback';
      return parsed;
    } catch (err) {
      console.error('[AIEngine] CLI 回退分析失败:', err.message);
      return null;
    }
  }

  /**
   * 构建 Sprint 的具体推进指令（替代笼统的"继续"）
   * 输出形如："请开始下一个任务: feature 名\n描述\n完成后请告诉我已完成第 N 个 feature"
   * 这样 AI 知道要做什么、做完后要说什么，便于 Sprint 自动推进
   */
  _buildSprintInstruction(progress) {
    if (!progress?.features?.length) return null;
    const features = progress.features;
    const done = features.filter(f => f.status === 'completed').length;
    const total = features.length;

    // 优先取 in_progress，否则取第一个 pending
    let cur = features.find(f => f.status === 'in_progress');
    let isNew = false;
    if (!cur) {
      cur = features.find(f => f.status === 'pending');
      isNew = true;
    }
    if (!cur) return null;

    const idx = features.indexOf(cur) + 1;
    const next = features.filter(f => f.status === 'pending' && f !== cur).slice(0, 2).map(f => f.name);
    const action = isNew ? '请开始' : '请继续完成';
    const desc = cur.description ? `\n要求: ${cur.description}` : '';
    const tail = next.length ? `\n完成后请继续: ${next.join('、')}` : '\n这是最后一个任务';
    return `${action}第 ${idx}/${total} 个任务: ${cur.name}${desc}${tail}\n完成后请明确说"已完成 ${cur.name}"`;
  }

  /** 构建进度上下文（注入到 AI 分析 prompt） */
  /** v1.2.85：hooks 实测的最近工具活动，注入 AI 判定 prompt。
   * 信号来自 CLI 进程自身（PreToolUse/PostToolUse hook），可信度高于截图正则；
   * 给「忙/闲」判定多一路独立证据。 */
  _buildHookContext(projectContext) {
    const recent = projectContext?.hookRecent;
    if (!Array.isArray(recent) || !recent.length) return '';
    const lines = recent.slice(-6).map(e => {
      const ago = Math.round((Date.now() - e.at) / 1000);
      const file = e.file ? ` ${String(e.file).split('/').slice(-2).join('/')}` : '';
      return `- ${ago}s前 ${e.event}${e.tool ? ` ${e.tool}` : ''}${file}`;
    });
    return `\n# CLI 最近工具活动（hooks 实测，可信度高于屏幕文本）\n${lines.join('\n')}\n（最近 ~30s 内有 PreToolUse 且其后无 Stop → 多半仍在干活，判忙碌。）\n`;
  }

  _buildProgressContext(projectContext) {
    if (!projectContext?.progress?.features?.length) return '';
    const p = projectContext.progress;
    const current = p.features.find(f => f.status === 'in_progress')
      || p.features.find(f => f.status === 'pending');
    if (!current) return '';
    const done = p.features.filter(f => f.status === 'completed').length;
    return `\n当前 Sprint 进度: ${done}/${p.features.length} 完成
当前任务: ${current.name}
任务描述: ${current.description}
注意: 判断"继续"时应聚焦于当前任务是否完成\n`;
  }

  _parseStatusResponse(content) {
    try {
      let jsonStr = content;
      // 尝试匹配 ```json ... ``` 或 ``` ... ``` 格式
      const jsonMatch = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1];
      }
      // 如果还不是有效 JSON，尝试提取第一个完整的 {} 对象
      if (!jsonStr.trim().startsWith('{')) {
        const braceMatch = content.match(/\{[\s\S]*?\}(?=\s*$|\s*[^,\s])/);
        if (braceMatch) {
          jsonStr = braceMatch[0];
        }
      }

      // 尝试解析 JSON，如果失败则尝试修复常见问题
      let parsed;
      try {
        parsed = JSON.parse(jsonStr);
      } catch (e) {
        // 尝试提取第一个有效的 JSON 对象（使用括号匹配）
        const firstBrace = jsonStr.indexOf('{');
        if (firstBrace !== -1) {
          let depth = 0;
          let endIndex = -1;
          for (let i = firstBrace; i < jsonStr.length; i++) {
            if (jsonStr[i] === '{') depth++;
            else if (jsonStr[i] === '}') {
              depth--;
              if (depth === 0) {
                endIndex = i;
                break;
              }
            }
          }
          if (endIndex !== -1) {
            const cleanJson = jsonStr.substring(firstBrace, endIndex + 1);
            parsed = JSON.parse(cleanJson);
          } else {
            throw e;
          }
        } else {
          throw e;
        }
      }

      return {
        currentState: parsed.currentState || '未知状态',
        workingDir: parsed.workingDir || '未知',
        recentAction: parsed.recentAction || '无',
        needsAction: parsed.needsAction || false,
        actionType: parsed.actionType || 'none',
        suggestedAction: parsed.suggestedAction || null,
        actionReason: parsed.actionReason || null,
        suggestion: parsed.suggestion || null,
        updatedAt: new Date().toISOString()
      };
    } catch (err) {
      console.error('解析状态响应失败:', err, content);
      return {
        currentState: '分析失败',
        workingDir: '未知',
        recentAction: '无',
        needsAction: false,
        actionType: 'none',
        suggestedAction: null,
        actionReason: null,
        suggestion: null,
        updatedAt: new Date().toISOString()
      };
    }
  }

  /**
   * 简单文本生成（不解析 JSON），带并发控制
   * @param {string} prompt - 提示词
   * @returns {Promise<string|null>} - 生成的文本
   */
  async generateText(prompt) {
    return this._withConcurrencyLimit(async () => {
      try {
        const content = await this._callApiWithFailover(prompt);
        return content || null;
      } catch (err) {
        console.error('[AIEngine] 文本生成失败:', err.message);
        return null;
      }
    });
  }

  /**
   * 解析指定 CLI 的可执行文件路径（兼容 Electron 打包后 PATH 受限）
   */
  _resolveCliExe(aiType = 'claude') {
    const home = os.homedir();
    const map = {
      claude: [join(home, '.local/bin/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude', join(home, '.claude/local/claude')],
      codex: [join(home, '.local/bin/codex'), '/opt/homebrew/bin/codex', '/usr/local/bin/codex'],
      gemini: [join(home, '.local/bin/gemini'), '/opt/homebrew/bin/gemini', '/usr/local/bin/gemini'],
      grok: [join(home, '.grok/bin/grok'), join(home, '.local/bin/grok'), '/opt/homebrew/bin/grok'],
    };
    for (const p of (map[aiType] || [])) {
      try { if (fs.existsSync(p)) return p; } catch {}
    }
    return aiType; // 兜底走 PATH
  }

  /**
   * 各 CLI 的非交互参数与输出解析模式。
   * claude 用 stream-json（结构化、可靠）；其余捕获 stdout 纯文本。
   */
  _cliArgs(aiType) {
    switch (aiType) {
      case 'codex': return { args: ['exec', '--dangerously-bypass-approvals-and-sandbox'], mode: 'text' };
      case 'gemini': return { args: ['-p'], mode: 'text' };
      case 'grok': return { args: ['-p'], mode: 'text' };
      default: return { args: ['--print', '--output-format', 'stream-json', '--verbose'], mode: 'stream-json' };
    }
  }

  /**
   * 通过 CLI 子进程生成文本（照搬 WhatRalph 原版方式）。
   * 复用对应 CLI 的供应商与登录态（官方订阅 / 中转 key 均可），不直连 HTTP API，
   * 因此不受单个中转 504 影响、官方登录也能用。支持每会话供应商：通过 providerEnv 注入。
   * @param {string} prompt
   * @param {object} options { timeout=180000, cwd, aiType='claude', providerEnv={} }
   *   providerEnv: 注入子进程的环境变量；值为 null 表示从继承 env 中删除该键（用于切官方登录）
   * @returns {Promise<string|null>} 最终文本，失败返回 null
   */
  generateTextViaCLI(prompt, options = {}) {
    const timeout = options.timeout || 180000;
    const aiType = options.aiType || 'claude';
    const cwd = (options.cwd && fs.existsSync(options.cwd)) ? options.cwd : os.tmpdir();
    const exe = this._resolveCliExe(aiType);
    const { args, mode } = this._cliArgs(aiType);

    // 构造 env：继承 process.env，叠加 providerEnv（值为 null 表示删除该键）
    const env = { ...process.env };
    for (const [k, v] of Object.entries(options.providerEnv || {})) {
      if (v == null) delete env[k];
      else env[k] = String(v);
    }

    return new Promise((resolve) => {
      let proc;
      try {
        proc = spawn(exe, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env });
      } catch (err) {
        console.error(`[AIEngine] 启动 ${aiType} CLI 失败:`, err.message);
        return resolve(null);
      }

      let finalText = null;
      let buf = '';
      let rawOut = '';
      let settled = false;
      const done = (val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { proc.kill('SIGTERM'); } catch {}
        resolve(val);
      };

      const timer = setTimeout(() => {
        console.error(`[AIEngine] ${aiType} CLI 超时(${timeout}ms)`);
        done(finalText || (rawOut.trim() || null));
      }, timeout);

      proc.stdout.on('data', (chunk) => {
        const s = chunk.toString('utf-8');
        rawOut += s;
        if (mode === 'stream-json') {
          buf += s;
          let nl;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            try {
              const obj = JSON.parse(line);
              if (obj.type === 'result' && typeof obj.result === 'string') {
                finalText = obj.result;
                if (obj.subtype === 'success' && !obj.is_error) done(finalText);
              }
            } catch { /* 非完整 JSON 行，忽略 */ }
          }
        }
      });

      proc.on('error', (err) => {
        console.error(`[AIEngine] ${aiType} CLI 进程错误:`, err.message);
        done(null);
      });
      proc.on('close', () => {
        // text 模式：用捕获的 stdout 全文；stream-json：用解析到的 result
        done(mode === 'text' ? (rawOut.trim() || null) : finalText);
      });

      try {
        proc.stdin.write(prompt);
        proc.stdin.end();
      } catch (err) {
        console.error('[AIEngine] 写入 prompt 失败:', err.message);
        done(null);
      }
    });
  }

  /**
   * 并发控制包装器
   */
  _withConcurrencyLimit(fn) {
    return new Promise((resolve, reject) => {
      const run = async () => {
        this._aiConcurrency++;
        try {
          resolve(await fn());
        } catch (err) {
          reject(err);
        } finally {
          this._aiConcurrency--;
          if (this._aiQueue.length > 0) {
            const next = this._aiQueue.shift();
            next();
          }
        }
      };

      if (this._aiConcurrency < this._aiMaxConcurrency) {
        run();
      } else {
        this._aiQueue.push(run);
      }
    });
  }

  /**
   * AI 分析 API 错误类型，决定修复策略
   * @param {string} errorContent - 错误内容（终端最近输出）
   * @returns {Promise<object>} - 分析结果
   */
  async analyzeApiError(errorContent) {
    const prompt = `分析以下 API 错误信息，判断错误类型并建议修复策略。

错误内容：
---
${errorContent}
---

请判断这是什么类型的错误，返回纯 JSON（不要 markdown 代码块）：

{
  "errorType": "错误类型，必须是以下之一：insufficient_balance（余额/额度不足）、server_unavailable（服务器不可用）、rate_limit（频率限制）、thinking_error（thinking模式不兼容）、auth_error（认证错误但非余额问题）、other（其他错误）",
  "action": "建议操作，必须是以下之一：switch_provider（切换供应商）、run_fixer（运行修复程序）、wait_and_retry（等待后重试）、none（无需操作）",
  "reason": "判断理由，简短说明",
  "waitSeconds": 等待秒数（仅当 action 为 wait_and_retry 时需要，默认 60）
}

判断规则：
1. 如果错误信息包含"余额不足"、"额度不足"、"credit"、"quota"、"balance"等与账户额度相关的词，且表示无法继续使用，则为 insufficient_balance，建议 switch_provider
2. 如果错误是 502、503、504 或明确说服务器不可用、超时、连接失败，则为 server_unavailable，建议 switch_provider
3. 如果错误是 429 或提到 rate limit、请求过于频繁，则为 rate_limit，建议 wait_and_retry
4. 如果错误涉及 thinking block、signature、不支持的模式，则为 thinking_error，建议 run_fixer
5. 如果是认证错误（401）但不涉及余额，则为 auth_error，建议 switch_provider
6. 其他错误默认 wait_and_retry

直接返回 JSON，以 { 开头：`;

    try {
      const content = await this._callApiWithFailover(prompt);
      if (!content) {
        return this._getDefaultErrorAnalysis();
      }

      // 解析 JSON 响应
      let jsonStr = content;
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        jsonStr = jsonMatch[0];
      }

      const result = JSON.parse(jsonStr);
      console.log(`[AIEngine] AI 错误分析结果: ${result.errorType} -> ${result.action} (${result.reason})`);

      return {
        errorType: result.errorType || 'other',
        action: result.action || 'wait_and_retry',
        reason: result.reason || '未知原因',
        waitSeconds: result.waitSeconds || 60,
        isInsufficientBalance: result.errorType === 'insufficient_balance',
        isServerUnavailable: result.errorType === 'server_unavailable',
        isRateLimitError: result.errorType === 'rate_limit',
        isThinkingError: result.errorType === 'thinking_error',
        shouldAutoFix: true,
        autoFixAction: result.action
      };
    } catch (err) {
      console.error('[AIEngine] AI 错误分析失败:', err.message);
      return this._getDefaultErrorAnalysis();
    }
  }

  /**
   * 获取默认的错误分析结果（AI 分析失败时使用）
   */
  _getDefaultErrorAnalysis() {
    return {
      errorType: 'other',
      action: 'wait_and_retry',
      reason: 'AI 分析失败，默认等待重试',
      waitSeconds: 60,
      isInsufficientBalance: false,
      isServerUnavailable: false,
      isRateLimitError: false,
      isThinkingError: false,
      shouldAutoFix: true,
      autoFixAction: 'wait_and_retry'
    };
  }
}
