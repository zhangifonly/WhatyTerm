/**
 * Ralph 公开壳（loader）
 *
 * 自主开发（Ralph）属于付费闭源功能，其核心实现：
 *   - server/services/RalphEngine.js   （执行引擎）
 *   - server/services/ralph/prompts.js （Developer / Validator 提示词）
 * 这些文件已通过 .gitignore 从公开仓库中排除，不随开源代码发布。
 *
 * 本 loader 在核心缺失时优雅降级：RalphEngine 为 null、RALPH_CORE_PRESENT 为
 * false，服务端仍可正常启动，仅自主开发功能不可用。
 *
 * 正式安装包中，核心文件由 scripts/build-premium.js 混淆后随包分发，
 * 运行时由 electron-builder.yml 的覆盖条目放回原路径，故此处可正常加载。
 */
let RalphEngine = null;
let RALPH_CORE_PRESENT = false;

try {
  const engineMod = await import('../RalphEngine.js');
  RalphEngine = engineMod.default || engineMod.RalphEngine || null;
  RALPH_CORE_PRESENT = typeof RalphEngine === 'function';
} catch (e) {
  console.warn(
    '[Ralph] 私有核心未安装，自主开发功能不可用：' +
      (e && e.message ? e.message : String(e))
  );
}

export { RalphEngine, RALPH_CORE_PRESENT };
