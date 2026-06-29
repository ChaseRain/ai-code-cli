// src/skills/parse.ts
// SKILL.md 的极简 frontmatter 解析 —— 纯函数、可单测、不抛（错误即数据）。
// 取舍（less is more，见 docs/product-specs/skills.md）：**不引入 YAML 依赖**，
//   只支持「`---` 围栏内的简单 `key: value` 行」。不支持嵌套 / 列表 / 多行值 /
//   引号转义 / 锚点等 YAML 高级特性（spec 明确不做）。

/** parseFrontmatter 的返回：解析出的标量 meta + 围栏之后的正文。 */
export interface ParsedFrontmatter {
  /** `key: value` 行解析结果；缺围栏时为空对象。 */
  meta: Record<string, string>;
  /** 围栏之后的 markdown 正文；无围栏时为整文。 */
  body: string;
}

/**
 * 解析 SKILL.md 的 frontmatter。
 * 规则（与 skills.md「frontmatter 解析规则」一致）：
 * - 必须以**首行** `---` 开围栏，遇下一行 `---` 收尾；围栏之间逐行解析。
 * - 每行按**第一个 `:`** 切分为 key/value，两侧 trim；key 为空或行内无 `:` 的行忽略（不报错）。
 * - 同名 key 后者覆盖前者（最后一次为准）。
 * - 缺围栏：整文件视作正文，meta 为空对象（name 由调用方回落目录名）。
 * - body = 围栏之后的正文（去掉收尾 `---` 行后的内容，首个换行后开始）；无围栏时为整文。
 * 纯函数、不抛。
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  // 用 \n 切分，兼容 CRLF（逐行 trimEnd 掉 \r）。
  const lines = raw.split('\n');
  const first = (lines[0] ?? '').replace(/\r$/, '').trim();

  // 缺围栏：首行不是 `---` → 整文为正文，meta 空。
  if (first !== '---') {
    return { meta: {}, body: raw };
  }

  // 找收尾 `---`（从第二行起的首个 `---`）。
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? '').replace(/\r$/, '').trim() === '---') {
      closeIdx = i;
      break;
    }
  }

  // 有开无收（无收尾围栏）：按缺围栏处理——整文为正文，避免把整个文件当 meta。
  if (closeIdx === -1) {
    return { meta: {}, body: raw };
  }

  // 解析围栏之间的 key: value 行。
  const meta: Record<string, string> = {};
  for (let i = 1; i < closeIdx; i++) {
    const line = (lines[i] ?? '').replace(/\r$/, '');
    const colon = line.indexOf(':');
    if (colon < 0) continue; // 行内无 `:` → 忽略（不报错）。
    const key = line.slice(0, colon).trim();
    if (key.length === 0) continue; // key 为空 → 忽略。
    const value = line.slice(colon + 1).trim();
    meta[key] = value; // 同名后者覆盖前者。
  }

  // 正文 = 收尾 `---` 行之后的内容。
  const body = lines.slice(closeIdx + 1).join('\n');
  return { meta, body };
}
