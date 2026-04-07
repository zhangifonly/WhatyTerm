# 版本号规范（SemVer）

WhatyTerm 遵循 [语义化版本 2.0](https://semver.org/lang/zh-CN/)：`MAJOR.MINOR.PATCH`

## 何时升哪一位

| 位 | 触发条件 | 示例 |
|----|---------|------|
| **MAJOR** (`X.0.0`) | 不兼容的破坏性变更 | API 协议变更、用户数据格式不兼容、需要重新激活、配置文件不可读 |
| **MINOR** (`x.X.0`) | 新增功能（向下兼容） | 新平台支持、新插件、新页面、Sprint 整合等 |
| **PATCH** (`x.x.X`) | Bug 修复、性能优化 | 图标修复、Tab 卡死、Hooks 修复、UI 微调 |

升级 MINOR 时 PATCH 归零；升级 MAJOR 时 MINOR 和 PATCH 都归零。

## 历史版本

| 版本 | 类型 | 关键变更 |
|------|------|---------|
| 1.2.0 | minor | Sprint 进度整合到监控策略，accept_edits 发"继续"替代 Tab |
| 1.1.0 | minor | Linux AppImage 支持、遥测+IP地域、崩溃日志上报、管理后台用户分析 |
| 1.0.x | patch | 各类 bug 修复 |

## 升级流程

1. 改动完成后判断属于 MAJOR/MINOR/PATCH
2. 修改 `package.json` 的 `version` 字段
3. `git commit -m "chore: 版本更新至 X.Y.Z"`
4. 构建 + 部署 + 创建 GitHub Release（tag 格式 `vX.Y.Z`）

## 版本快速判断

- 只是改了几个文字、修了 bug → **PATCH**
- 加了用户能看到的新功能、新页面 → **MINOR**
- 老用户升级会出问题、需要迁移 → **MAJOR**
