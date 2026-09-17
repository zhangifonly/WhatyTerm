/**
 * 长程编排：沙箱隔离层
 *
 * 移植自长程编排器 orchestrator/isolation.py。**这是整套东西里风险最高的模块** ——
 * 它决定无人值守跑几十小时的执行者能碰到什么。配错了不会报错，只会静默污染。
 *
 * 三个职责，每个都有实测代价（见各函数注释）：
 *   1. 双向路径断言：拒绝受保护根内、要求在沙箱白名单内
 *   2. MCP 授权闸：必须**显式 deny**，不能"不 allow 就行"
 *   3. 用户级 ~/.claude.json 标记信任：否则写进沙箱的 skill 规则整份静默失效
 */

import {
  existsSync, statSync, mkdirSync, readFileSync, writeFileSync, readdirSync,
  copyFileSync, cpSync, renameSync, unlinkSync, realpathSync,
} from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { IsolationViolation } from './LongRunPrompts.js';

export { IsolationViolation };

/**
 * WebTmux 仓库根。**从代码位置推导，不取 process.cwd()**：从别的目录启动
 * （launchd、pm2、打包后）时 cwd 不是仓库，写死或取 cwd 都会让 isWithin 恒假 ——
 * 整道防线静默失效，不报错，只是不再拦任何东西（原版 case_paths_derived_not_hardcoded）。
 */
export const WEBTMUX_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 长程编排器（Python 原版）所在目录。沙箱默认建在它的**同级** `_sandbox_longrun/`，
 * 与原版同一位置 —— `python view.py --sandbox` / `transcript.py` 能直接回放 WebTmux 跑出的沙箱。
 * 它自己的 memory/ 是真实记忆库，所以也是受保护根。
 */
export function orchestratorRoot() {
  return path.resolve(process.env.LONGRUN_ORCHESTRATOR_ROOT
    || path.join(os.homedir(), 'Documents', '长程编排器'));
}

/**
 * 解析路径并跟随符号链接（对应 Python Path.resolve()）。
 * 路径还不存在时，解析到最长的已存在祖先再拼回剩余部分 —— 否则经符号链接
 * 指进受保护目录的沙箱根会被放行。
 */
export function realResolve(p) {
  let cur = path.resolve(p);
  const rest = [];
  for (;;) {
    try {
      return path.join(realpathSync(cur), ...rest.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * 受保护根：这些目录下**绝不允许**子进程活动。
 * WebTmux 仓库与原版编排器目录（两处都有真实记忆库）。
 * LONGRUN_PROJECT_ROOT 可覆盖前者（原版同名变量），LONGRUN_PROTECTED_ROOTS 追加。
 */
export function protectedRoots() {
  const roots = [
    realResolve(process.env.LONGRUN_PROJECT_ROOT || WEBTMUX_ROOT),
    realResolve(orchestratorRoot()),
  ];
  for (const p of (process.env.LONGRUN_PROTECTED_ROOTS || '').split(path.delimiter).filter(Boolean)) {
    roots.push(realResolve(p));
  }
  return [...new Set(roots)];
}

/** 沙箱白名单。默认原版编排器同级的 `_sandbox_longrun/`；LONGRUN_SANDBOX_BASE 可指到别处。 */
export function sandboxRoots() {
  return [realResolve(process.env.LONGRUN_SANDBOX_BASE
    || path.join(path.dirname(orchestratorRoot()), '_sandbox_longrun'))];
}

/** 用户级 CLI 配置。项目的「已信任」状态与用户级 MCP 服务器都在这里。 */
export function userClaudeJson() {
  // 覆盖仅供测试：服务层测试要建很多沙箱，不能往真实配置里留信任条目
  return process.env.LONGRUN_CLAUDE_JSON || path.join(os.homedir(), '.claude.json');
}

/**
 * 沙箱 `.claude` 模板（只读取，不写入）。仓库内 server/prompts/longrun/claude-template/，
 * 来自原版 examples/settings.local.json.template。
 *
 * ⚠ **绝不能是 ~/.claude**：那里有 config.json 的密钥、带 token 的 settings 备份、
 *   全部项目的历史提示词。复制进沙箱等于交给能跑任意命令的执行者，还会被
 *   git add -A 提交进快照、永久留在历史里。早期移植犯过这个错（审计 G1）。
 */
export function templateClaudeDir() {
  return process.env.LONGRUN_CLAUDE_TEMPLATE
    || path.join(WEBTMUX_ROOT, 'server', 'prompts', 'longrun', 'claude-template');
}

/** 复制模板时跳过（与原版一致）：编译缓存没有意义，会话/待办是模板自己的运行状态 */
const SKIP_NAMES = new Set(['__pycache__', '.DS_Store']);
const SKIP_TOP = new Set(['settings.json', 'todos', 'sessions', 'history', 'shell-snapshots']);

/** MCP 规则前缀。拼字符串的地方有三处，散着写迟早不一致。 */
const MCP_RULE_PREFIX = 'mcp__';

/** child 是否在 parent 之内（或就是它）。两边都跟随符号链接。 */
function isWithin(child, parent) {
  const c = realResolve(child), p = realResolve(parent);
  return c === p || c.startsWith(p + path.sep);
}

/**
 * 校验 path 位于沙箱内且不在受保护项目内。返回解析后的绝对路径。
 * @throws {IsolationViolation}
 */
export function assertSandboxed(p, what = '路径') {
  const rp = realResolve(p);
  for (const guarded of protectedRoots()) {
    if (isWithin(rp, guarded)) {
      throw new IsolationViolation(
        `${what} 位于受保护项目内，拒绝启动：\n`
        + `  ${what}: ${rp}\n  受保护根: ${guarded}\n`
        + `子进程会读写该目录下的记忆库，可能污染真实记忆。`
      );
    }
  }
  const roots = sandboxRoots();
  if (!roots.some((r) => isWithin(rp, r))) {
    throw new IsolationViolation(
      `${what} 不在沙箱白名单内，拒绝启动：\n`
      + `  ${what}: ${rp}\n  允许的沙箱根: ${roots.join(', ')}`
    );
  }
  return rp;
}

/**
 * 一次长程运行的沙箱。所有路径在构造时即完成校验。
 *
 * ⚠ create() 里的**顺序不能颠倒**：先复制 .claude 模板，再写 settings 覆盖
 *   autoMemoryDirectory。反过来会让模板里指向真实记忆库的那个值活下来。
 */
export class LongRunSandbox {
  constructor({ root, memoryDir, runDir }) {
    this.root = root;
    this.memoryDir = memoryDir;
    this.runDir = runDir;
    this.claudeCopied = [];    // 从模板复制进来的条目名，供启动时打印
    this.skillsGranted = [];   // 已写入具名 allow 规则的 skill 名
    this.trustGranted = false; // 是否已在用户级 .claude.json 标记信任
    this.mcpAllowed = [];      // 放行的 MCP 服务器
    this.mcpDenied = [];       // 已屏蔽的 MCP 服务器
    // 需求文档里指名的外部参考路径，通过 --add-dir 挂给执行者。
    // ⚠ --add-dir 给的是**读写**权限，不是只读：执行者能改这些目录里的文件。
    //   用户已明确选择信任这些路径，故不做改动检查，只在启动时提示。
    this.extraDirs = [];
  }

  static create(name, base = null) {
    if (!name || /[\\/]/.test(name)) {
      throw new IsolationViolation(`沙箱名不合法（不能含路径分隔符）: ${name}`);
    }
    const basePath = base ? path.resolve(base) : sandboxRoots()[0];
    const root = assertSandboxed(path.join(basePath, name), '沙箱工作目录');
    const spec = new LongRunSandbox({
      root,
      memoryDir: assertSandboxed(path.join(root, '.memory'), '沙箱记忆目录'),
      runDir: assertSandboxed(path.join(root, '.run'), '运行现场目录'),
    });
    for (const d of [spec.root, spec.memoryDir, spec.runDir]) {
      mkdirSync(d, { recursive: true });
    }
    // 顺序要紧：先复制模板，再写 settings 覆盖 autoMemoryDirectory
    spec.claudeCopied = spec._copyClaudeTemplate();
    spec._writeSettings();
    // 写完 settings 还要让它真的被加载：未信任的项目整份 settings.local.json
    // 都不生效，permissions.allow 白写
    spec.trustGranted = spec._trustProject();
    return spec;
  }

  /**
   * 把模板 .claude 复制进沙箱（skills、权限配置等）。
   *
   * 执行者需要 skills（如浏览器 skill 自己看渲染结果）和一份 permissions.allow，
   * 否则每个 Bash 都会被 `--permission-prompts none` 自动拒绝。
   * **复制而非 --add-dir 挂载**：挂载给的是读写权限，执行者改坏模板会影响后续所有运行。
   *
   * ⚠ 复制来的 settings.local.json 里 autoMemoryDirectory 指向**真实记忆库**。
   *   _writeSettings 随后会强制覆盖它 —— 顺序不能颠倒。
   */
  _copyClaudeTemplate() {
    const src = templateClaudeDir();
    if (!existsSync(src) || !statSync(src).isDirectory()) return [];
    const dst = path.join(this.root, '.claude');
    mkdirSync(dst, { recursive: true });
    const copied = [];
    for (const name of readdirSync(src)) {
      if (SKIP_NAMES.has(name) || SKIP_TOP.has(name)) continue;
      const from = path.join(src, name), to = path.join(dst, name);
      try {
        if (statSync(from).isDirectory()) {
          cpSync(from, to, {
            recursive: true, force: true, dereference: false,
            filter: (s) => !SKIP_NAMES.has(path.basename(s)),
          });
        } else {
          copyFileSync(from, to);
        }
        copied.push(name);
      } catch {
        // 单个条目复制失败不该拖垮整次启动（权限、符号链接指向不存在等）
      }
    }
    return copied;
  }

  /**
   * 为沙箱里每个 skill 写一条**具名** allow 规则。
   *
   * 实测（2026-09-05）：`Skill(*)` 通配**不能**放行 skill 执行 —— 带它跑仍报
   * "Execute skill: agent-browser 需要授权"，而 `--permission-prompts none` 下
   * 无人可批，于是自动拒绝。换成 `Skill(agent-browser)` 具名规则当场放行。
   *
   * 代价很实：bodhi2 那轮执行者调 agent-browser 被拒后（它被告知"不要重试"），
   * 只能自己用 puppeteer/CDP 手写 8 个验证脚本，skill 白给了。
   *
   * 名字取自 SKILL.md 的 `name:` 字段**而非目录名** —— 两者可以不同
   * （agent-browser-skill/ 里写的是 name: agent-browser），认错就白写。
   */
  _grantSkills(payload) {
    const skillsDir = path.join(this.root, '.claude', 'skills');
    if (!existsSync(skillsDir) || !statSync(skillsDir).isDirectory()) return;

    const names = [];
    for (const entry of readdirSync(skillsDir).sort()) {
      const md = path.join(skillsDir, entry, 'SKILL.md');
      if (!existsSync(md) || !statSync(md).isFile()) continue;
      let name = entry;                    // 兜底：读不到 name: 就用目录名
      const head = readFileSync(md, 'utf8').split(/\r?\n/).slice(0, 15);
      for (const line of head) {
        if (line.startsWith('name:')) {
          const v = line.slice(5).trim();
          if (v) name = v;
          break;
        }
      }
      names.push(name);
    }
    if (!names.length) return;

    const perms = (payload.permissions ||= {});
    const allow = (perms.allow ||= []);
    for (const name of names) {
      const rule = `Skill(${name})`;
      if (!allow.includes(rule)) allow.push(rule);
    }
    this.skillsGranted = names;
  }

  /**
   * 放行白名单里的 MCP 服务器，其余**全部写进 deny**。
   *
   * 为什么必须显式 deny 而不是"不 allow 就行"：用户级 `mcpServers` 是**继承**来的，
   * 不 allow 只会让执行者在调用时被拒 —— 而它**看得见工具、会去调、被拒后转向自造
   * 替代方案**，并把"这条路走不通"写进长期记忆（qingming 那例自造了无头 Chrome）。
   * 写进 deny 则工具从列表里整个消失，它根本不会往那个方向想。
   *
   * **deny 优先于 allow**，所以白名单里的服务器绝不能同时出现在 deny 里。
   * 每次重建前先清掉所有 mcp__ 规则：模板里手写的 deny 格式可能不统一，
   * 且模板 allow 里的 mcp 条目是**白名单声明**（已读进 allowed），
   * 不清掉会在服务器改名后留下过期规则。
   */
  _gateMcp(payload) {
    const allowed = this._readAllowedMcp();
    const denied = this._userMcpServers().filter((s) => !allowed.includes(s));

    const perms = (payload.permissions ||= {});
    const allow = (perms.allow ||= []);
    const deny = (perms.deny ||= []);
    // 先清后建（理由见上）
    perms.allow = allow.filter((r) => !String(r).startsWith(MCP_RULE_PREFIX));
    perms.deny = deny.filter((r) => !String(r).startsWith(MCP_RULE_PREFIX));
    for (const name of allowed) perms.allow.push(`${MCP_RULE_PREFIX}${name}`);
    for (const name of denied) perms.deny.push(`${MCP_RULE_PREFIX}${name}`);

    this.mcpAllowed = allowed;
    this.mcpDenied = denied;
  }

  /**
   * 从模板 settings 的 permissions.allow 里读出放行的 MCP 服务器名。
   *
   * 唯一真相就是那个文件：写 mcp__blender 就放行 blender。不在代码里另写一份常量 ——
   * "同一份常量散落两处、改一处不够"是原版已经犯过的错。
   *
   * ⚠ **读不到时抛异常，不返回空列表**。空列表 = 什么都不放行，会静默吊销授权，
   *   失败表现是执行者说"我没有这个工具" —— 几小时无人值守里几乎不可能归因。宁可启动前就炸。
   */
  _readAllowedMcp(template = null) {
    const file = template || path.join(templateClaudeDir(), 'settings.local.json');
    if (!existsSync(file) || !statSync(file).isFile()) {
      throw new IsolationViolation(
        `读不到模板 settings，无法确定 MCP 白名单：${file}\n`
        + `该文件的 permissions.allow 里的 mcp__* 条目就是白名单。`);
    }
    let data;
    try { data = JSON.parse(readFileSync(file, 'utf8')); } catch (e) {
      throw new IsolationViolation(`模板 settings 解析失败，无法确定 MCP 白名单：${file}\n  ${e.message}`);
    }
    const allow = data?.permissions?.allow || [];
    const names = [];
    for (const rule of allow) {
      if (typeof rule !== 'string' || !rule.startsWith(MCP_RULE_PREFIX)) continue;
      // mcp__blender → blender；mcp__blender__some_tool 只取服务器名。
      // ⚠ 按 "__" 切而不是遇到 "_" 就截：mcp__claude_ai_Claude_Docs 的服务器名含单下划线
      const name = rule.slice(MCP_RULE_PREFIX.length).split('__')[0].trim();
      if (name && name !== '*' && !names.includes(name)) names.push(name);
    }
    return names;
  }

  /** 用户级配置里已注册的 MCP 服务器名（这些是**继承**来的，必须逐个表态）。 */
  _userMcpServers() {
    const f = userClaudeJson();
    if (!existsSync(f)) return [];
    try {
      const j = JSON.parse(readFileSync(f, 'utf8'));
      const servers = j?.mcpServers;
      return servers && typeof servers === 'object' && !Array.isArray(servers)
        ? Object.keys(servers).sort() : [];
    } catch { return []; }
  }

  /**
   * 在沙箱内显式写入记忆目录配置。
   *
   * 不依赖从父进程继承 —— 继承会读到真实项目的 autoMemoryDirectory。
   * 若 .claude 模板已复制进来，就在它基础上改，保留 permissions 等配置，
   * 但 **autoMemoryDirectory 一律强制覆盖为沙箱路径**：模板里的原值指向真实
   * 记忆库，照抄会让子进程直接写进去。
   */
  _writeSettings() {
    const claudeDir = path.join(this.root, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    const settings = path.join(claudeDir, 'settings.local.json');

    let payload = {};
    if (existsSync(settings)) {
      try {
        const loaded = JSON.parse(readFileSync(settings, 'utf8'));
        if (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) payload = loaded;
      } catch {
        payload = {};      // 读不动就重写一份干净的，不猜内容
      }
    }

    payload.autoMemoryDirectory = this.memoryDir;
    this._grantSkills(payload);
    this._gateMcp(payload);
    writeFileSync(settings, JSON.stringify(payload, null, 2) + '\n', 'utf8');

    // 写完立刻自查：这是隔离的最后一道，配错了不会报错只会静默污染
    const written = JSON.parse(readFileSync(settings, 'utf8'));
    assertSandboxed(written.autoMemoryDirectory, '沙箱 settings 里的记忆目录');
  }

  /**
   * 在用户级 ~/.claude.json 里把本沙箱标记为已信任。
   *
   * **为什么必须做**（2026-09-06 实测定位）：未信任的项目**不加载**它自己的
   * settings.local.json，于是 _grantSkills 写的具名 allow 规则整份失效。
   * 表现极具误导性 —— 规则明明在、一字不差，但调 skill 仍被拒，理由是
   * "no approval surface in this session"，看起来像 skill 名字写错。
   * 实测：同一条命令同一目录，仅把 hasTrustDialogAccepted 由 false 改 true，
   * 结果从"自动拒绝"变成 "Launching skill"。
   *
   * ⚠ 这个文件有几十个项目条目、上百 KB，**写坏了影响所有项目**：
   *   先写临时文件再原子替换，中途失败原文件不动。
   *   只改本沙箱那一个 key，且路径必须先过 assertSandboxed。
   */
  _trustProject() {
    // 这个函数是全模块唯一伸出沙箱的动作，不能靠调用方记得校验
    assertSandboxed(this.root, '信任标记目标');

    const file = userClaudeJson();
    if (!existsSync(file) || !statSync(file).isFile()) return false;  // 不去创建
    let data = null;
    try { data = JSON.parse(readFileSync(file, 'utf8')); }
    catch { return false; }                    // 读不动就不动它，宁可少一层信任
    if (!data || typeof data.projects !== 'object' || data.projects === null) return false;

    // CLI 用**正斜杠**形式做 key（实测）。认错等于新加一个无用条目，
    // 而真正那条仍未信任
    const key = String(this.root).replace(/\\/g, '/');
    const entry = (data.projects[key] ||= {});
    if (entry.hasTrustDialogAccepted === true) return true;   // 已信任，不必写盘

    entry.hasTrustDialogAccepted = true;
    const tmp = file + '.longrun-tmp';
    try {
      writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      renameSync(tmp, file);                   // 原子替换
    } catch {
      try { unlinkSync(tmp); } catch {}
      return false;
    }
    return true;
  }

  /**
   * 登记一个外部参考目录，供 --add-dir 使用。
   *
   * 不要求它在沙箱内 —— 这类路径本就是用户指名的项目外资料。但**仍不允许落在
   * 受保护项目内**：那会让执行者拿到真实记忆库的写权限，是整个隔离设计的初衷。
   */
  addExtraDir(p) {
    const rp = realResolve(p);
    for (const guarded of protectedRoots()) {
      if (isWithin(rp, guarded)) {
        throw new IsolationViolation(
          `参考路径落在受保护项目内，拒绝挂载：\n`
          + `  路径: ${rp}\n  受保护根: ${guarded}\n`
          + `--add-dir 给的是读写权限，挂载它意味着执行者能改写本项目的记忆库与源码。`
        );
      }
    }
    if (!existsSync(rp)) throw new IsolationViolation(`参考路径不存在: ${rp}`);
    if (!this.extraDirs.includes(rp)) this.extraDirs.push(rp);
    return rp;
  }

  /** 运行前复核：受保护记忆库不应出现在沙箱可达范围内。 */
  verifyClean() {
    for (const guarded of protectedRoots()) {
      if (isWithin(this.root, guarded)) {
        throw new IsolationViolation(`沙箱根 ${this.root} 落在受保护项目 ${guarded} 内`);
      }
    }
    assertSandboxed(this.root, '沙箱工作目录');
    assertSandboxed(this.memoryDir, '沙箱记忆目录');
    // 外部目录每次运行前都复核一遍，防止中途被改成受保护路径
    for (const extra of this.extraDirs) {
      for (const guarded of protectedRoots()) {
        if (isWithin(extra, guarded)) {
          throw new IsolationViolation(`参考路径 ${extra} 落在受保护项目 ${guarded} 内`);
        }
      }
    }
  }

  /**
   * 构造子进程环境变量。
   *
   * 清掉可能把子进程指回真实项目的变量，避免通过环境泄漏；
   * 也清掉监督者凭据 —— 执行者跑任意 Bash、写任意文件，没有任何理由拿到那把 key。
   */
  childEnv(base = process.env) {
    const env = { ...base };
    for (const key of Object.keys(env)) {
      const upper = key.toUpperCase();
      if (upper.includes('CLAUDE') && upper.includes('MEMORY')) delete env[key];
      else if (upper.startsWith('SUPERVISOR_')) delete env[key];
    }
    env.CLAUDE_PROJECT_DIR = this.root;
    return env;
  }
}
