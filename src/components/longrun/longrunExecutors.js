/**
 * 长程执行者在界面上的说法（新建表单、模型选择、侧栏卡片共用一份）。
 * 能力口径与服务端 server/services/longrunExecutor.js 的 EXECUTORS 一致。
 */
export const EXECUTOR_UI = {
  claude: {
    label: 'Claude Code（默认）', title: 'CLAUDE', account: '',
    modelsFrom: '当前供应商支持', defaultModel: '',
  },
  cursor: {
    label: 'Cursor CLI（Cursor 账号，订阅计费）', title: 'CURSOR', account: 'Cursor 官方', billing: 'Cursor 账号·订阅',
    modelsFrom: 'Cursor 账号可用', defaultModel: 'Auto',
    note: 'Cursor 按订阅计费，预算上限对它不生效；拿不到运行中的上下文水位，不做水位交接（Cursor 自己管上下文）；'
      + '插话会在工具间隙结束当前这发，再接着同一段对话发进去。',
  },
  kiro: {
    label: 'Kiro CLI（AWS 账号，credits 计费）', title: 'KIRO', account: 'Kiro 官方', billing: 'Kiro 账号·credits',
    modelsFrom: 'Kiro 账号可用', defaultModel: 'auto',
    note: 'Kiro 按 credits 计费，每发花了多少写在日志和统计里，预算上限（美元）对它不生效；上下文水位按模型窗口换算，水位交接照常；'
      + '插话会在工具间隙结束当前这发，再接着同一段对话发进去。',
  },
  opencode: {
    label: 'OpenCode（用下面选的 CC Switch 供应商）', title: 'OPENCODE', account: '', billing: 'CC Switch 供应商',
    modelsFrom: '当前供应商支持（Claude 系）', defaultModel: '',
    note: '用下面选的 CC Switch 供应商（不能是 Claude 官方登录），开跑前会真发一个请求验证；费用按价格表 × token 估算，'
      + '预算刹车与水位交接照常；插话在两次模型调用之间生效。每次调用固定带 3 万多 token 的系统提示，比 Claude Code 费钱。',
  },
};

export const executorUi = (ex) => EXECUTOR_UI[ex] || EXECUTOR_UI.claude;
export const MEMORY_NOTE = '记忆都在项目的 .memory/，换回 Claude 也接得上。';
