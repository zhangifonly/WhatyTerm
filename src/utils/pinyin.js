/**
 * 轻量汉字拼音首字母工具（零依赖、离线）
 *
 * 用 Intl.Collator 的中文拼音排序 + 26 段"边界汉字"二分归属，得到每个汉字的
 * 拼音首字母。Electron/Chromium 内置 Intl，无需引入拼音字典库；覆盖常用汉字。
 * 用于历史记录/项目搜索：输入 "xj" 即可匹配「心镜」。
 */

const collator = new Intl.Collator('zh-CN');

// 各拼音首字母段的起始边界汉字（升序）。拼音无 i/u/ü 开头的音节，故缺 i u v。
const BOUNDS = [
  ['a', '啊'], ['b', '八'], ['c', '嚓'], ['d', '搭'], ['e', '蛾'],
  ['f', '发'], ['g', '噶'], ['h', '哈'], ['j', '击'], ['k', '喀'],
  ['l', '垃'], ['m', '妈'], ['n', '拿'], ['o', '哦'], ['p', '啪'],
  ['q', '期'], ['r', '然'], ['s', '撒'], ['t', '塌'], ['w', '挖'],
  ['x', '昔'], ['y', '压'], ['z', '匝'],
];

const isHan = (ch) => /[一-鿿]/.test(ch);

/** 单字符 → 首字母：英文/数字原样小写，汉字取拼音首字母，其它返回空串 */
function charInitial(ch) {
  if (/[a-z0-9]/i.test(ch)) return ch.toLowerCase();
  if (!isHan(ch)) return '';
  let letter = '';
  for (const [l, b] of BOUNDS) {
    if (collator.compare(ch, b) >= 0) letter = l;
    else break;
  }
  return letter;
}

/** 整串 → 拼音首字母串（汉字逐字取首字母，英文数字保留，其它忽略） */
export function getInitials(str) {
  if (!str) return '';
  let out = '';
  for (const ch of String(str)) out += charInitial(ch);
  return out;
}

/**
 * 拼音/文本模糊匹配：query 命中 text 任意一种即为真——
 * ① 普通子串（不区分大小写，支持中文原文/英文）
 * ② text 的拼音首字母串包含 query（如 "xj" 命中「心镜」）
 */
export function matchPinyin(text, query) {
  if (!query) return true;
  if (!text) return false;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const lower = String(text).toLowerCase();
  if (lower.includes(q)) return true;
  return getInitials(text).includes(q);
}
