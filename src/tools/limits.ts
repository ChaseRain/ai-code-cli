// src/tools/limits.ts
// 工具资源上限常量集中处（Phase-7 P7-B）。
// 工具读写的单文件/内容大小硬上限——超限直接拒绝，避免把超大文件整块读入内存。

/** 工具单文件 / 写入内容字节上限：5 MiB。 */
export const MAX_TOOL_FILE_BYTES = 5 * 1024 * 1024;

/** 人类可读的字节数（用于错误文案）。 */
export function humanBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KiB`;
  return `${n}B`;
}
