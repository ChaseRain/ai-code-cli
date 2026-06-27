// deliverables/snake/extract.mjs
// 解析 Anthropic SSE 原始流，累积 content_block_delta(text_delta) 为完整文本，
// 再抽出第一个 ```html ... ``` 代码块（无围栏则在出现 <!doctype/<html 时取整段）写入目标文件。
// 用法：node extract.mjs <response.sse> <out.html>
import { readFileSync, writeFileSync } from 'node:fs';

const [, , ssePath, outPath] = process.argv;
if (!ssePath || !outPath) {
  console.error('用法: node extract.mjs <response.sse> <out.html>');
  process.exit(1);
}

const raw = readFileSync(ssePath, 'utf8');
let text = '';
for (const line of raw.split(/\r?\n/)) {
  if (!line.startsWith('data:')) continue;
  const data = line.slice(5).replace(/^ /, '');
  if (data === '[DONE]') continue;
  let evt;
  try {
    evt = JSON.parse(data);
  } catch {
    continue;
  }
  if (evt?.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
    text += evt.delta.text ?? '';
  }
}

if (!text.trim()) {
  console.error('[extract] 未从 SSE 中解析到任何文本；请检查 response.sse');
  process.exit(2);
}

// 抽取 ```html ... ``` 代码块；没有围栏就退而取 <!doctype/<html 到结尾。
let html = null;
const fence = text.match(/```(?:html)?\s*\n([\s\S]*?)```/i);
if (fence) {
  html = fence[1].trim();
} else {
  const idx = text.search(/<!doctype html|<html[\s>]/i);
  if (idx !== -1) html = text.slice(idx).trim();
}

if (!html) {
  console.error('[extract] 未找到 HTML 文档/代码块，原样保存模型文本以便排查');
  writeFileSync(outPath.replace(/\.html$/, '.fulltext.txt'), text, 'utf8');
  process.exit(3);
}

writeFileSync(outPath, html + '\n', 'utf8');
console.log(`[extract] 写入 ${outPath}（${html.length} chars）`);
