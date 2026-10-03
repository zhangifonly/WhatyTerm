/**
 * 会话上按 CLI 类型存的供应商字段名（claudeProvider / codexProvider …）。
 * 原来 index.js 里 7 处各写一串 if-else，每接一个 CLI 就要全改一遍（v1.4.89 起统一走这里）。
 */
export const PROVIDER_FIELDS = {
  claude: 'claudeProvider', codex: 'codexProvider', gemini: 'geminiProvider', grok: 'grokProvider',
  kiro: 'kiroProvider', cursor: 'cursorProvider', opencode: 'opencodeProvider', droid: 'droidProvider',
};
export const providerFieldOf = (aiType) => PROVIDER_FIELDS[aiType] || 'claudeProvider';
