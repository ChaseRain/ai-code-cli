# 项目级配置

`loadConfig` 会读取本目录下的 `config.json`（`<cwd>/.ai-code-cli/config.json`），
合并顺序：**DEFAULTS ← 用户级(`~/.config/ai-code-cli/config.json`) ← 项目级(本文件)**。

## 用法

1. 复制模板：`cp config.example.json config.json`
2. **只保留你想覆盖的字段**，其余删掉即可回落默认值（深合并，缺失字段不影响上层）。
3. 不写 `config.json` 也能正常运行——全部走 `DEFAULTS`。

## 注意

- 文件是**严格 JSON**（`JSON.parse`），**不能写注释**，否则报「JSON 解析失败」。
- **密钥不要写这里**：优先用 `.env` 的 `ANTHROPIC_AUTH_TOKEN`。虽然 schema 允许 `apiKey` 兜底，
  但为避免密钥入库，`config.json` 已被 `.gitignore` 忽略。
- 可覆盖字段与上限见 `docs/product-specs/config.md`。
