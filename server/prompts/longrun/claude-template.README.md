# 沙箱 .claude 模板

长程任务每建一个沙箱，都把本目录复制进 `<沙箱>/.claude/`，给执行者一份权限配置。

来源：长程编排器 `examples/settings.local.json.template`（84 条 Bash 白名单、
5 条 deny、`defaultMode: acceptEdits`），**唯一改动**是 allow 里加了 `mcp__puppeteer` ——
本机唯一装了的 MCP，不放行它执行者就看不了渲染结果（原版 spaceX 那轮就是这么退化成
"只能靠代码审查交付"的）。

⚠ 这里**只放权限与技能，绝不放凭据**。早期实现曾把整个 `~/.claude` 当模板复制，
会把 `config.json` 里的密钥、带 token 的 settings 备份、全部历史提示词带进沙箱并提交进快照。

- `permissions.allow` 里的 `mcp__*` 是 **MCP 白名单的唯一真相**：写了就放行，没写的用户级
  MCP 服务器会被逐个写进 deny（整个从工具列表消失，执行者不会去自造替代方案）
- `autoMemoryDirectory` 是占位值，建沙箱时一律被覆盖成 `<沙箱>/.memory`
- 要给执行者 skill：把技能目录放进 `skills/`，会按 `SKILL.md` 的 `name:` 写具名授权
