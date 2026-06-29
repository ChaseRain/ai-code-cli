# Product Spec — Guardrails / 边界硬化（Phase-7）

> 状态：implemented（P7-A~E 已实现+测试） · 最后更新：2026-06-28
> 模块：`src/tools/path-guard.ts`、`read-file/edit-file/write-file/list-dir/grep/glob`、`src/config/index.ts`、`src/tools/run-shell.ts`。

## 定位
对**已有功能**做边界硬化（非新功能）：路径沙箱抗符号链接逃逸、工具文件大小上限、配置硬上限、run_shell 进程树清理。

## P7-A 路径边界（symlink escape）
- 不变量：**工具/检查点/工作区的一切路径必须以 realpath 语义落在项目根内**——不仅 lexical `..` 防护，还要防经符号链接写出/读出 root。
- 实现：`resolveInRoot` 保留 `..` lexical 防护；再用 `realpath(root)` 与「目标的最近存在祖先」的 `realpath` 校验：
  - 目标存在 → `realpath(目标)` 必须在 `realpath(root)` 内；
  - 目标不存在（write/restore 新建）→ 取**最近存在祖先**目录，其 `realpath` 必须在 root 内（防经 symlink 目录写出）。
- `grep`/`glob`（fast-glob）设 `followSymbolicLinks: false`，不经符号链接遍历出 root。
- 覆盖入口：read_file / write_file / edit_file / list_dir / grep / glob / checkpoint（targets/快照/restore）/ workspace（diff/untracked/fallback）。

## P7-E glob/grep pattern/cwd 逃逸防护
- 不变量：`glob` 的 `cwd`/`pattern` 与 `grep` 的 `include` **不得经 `..`、绝对路径、symlink 遍历/读取 root 外**。
- 实现（复用 path-guard）：
  - `assertGlobInRoot(p)`：拒绝绝对路径与含 `..` 段的 glob（fast-glob 不净化 `..`）→ 越界 `ok:false`。
  - `globLiteralPrefix(p)`：取首个 glob meta 段之前的 literal 前缀（`link/**/*.txt`→`link`、`src/**/*.ts`→`src`、`**/*.ts`→空）；非空前缀经 `resolveInRoot` 校验——**literal 前缀是 root 内 symlink 且 realpath 到 outside 时显式 `ok:false`（越界）**，可审计。
  - `glob` 的 `cwd` 额外经 `resolveInRoot`（realpath 校验，防 symlink cwd）。
  - 后置防御：对 fast-glob 命中结果逐一 `resolveInRoot` 过滤，越界项丢弃（symlink 等兜底）。
- 正常 root 内 glob/grep 保持兼容；`followSymbolicLinks:false` 仍保留。

## P8-A grep 资源上限（stat-before-read）
- `grep` 必须 **stat-before-read**，复用 `MAX_TOOL_FILE_BYTES`(5 MiB)：超上限文件**不读**、累计 skipped。
- 结果须提示跳过：`…(已跳过 N 个过大文件，单文件上限 5242880 bytes)`；
  无匹配但有跳过时仍 `ok:true`，content 同时含 `(无匹配)` 与跳过提示（不静默假装“无匹配”）。

## P8-B grep 正则安全（轻量 ReDoS guard）
`grep` 在编译/扫描前（字符串级）拒绝明显危险的正则，返回 `ok:false`、文案含「正则过于复杂/可能退化」，避免病态回溯卡死事件循环 / TUI。覆盖两类：
- **(a) nested quantifier**：group 内部含量词（`*` / `+` / `{m,n}` / `{m,}`），group 外部又被 `*` / `+` / `{...}` 量化。
  覆盖 `(a+)+$`、`(.+)*`、`(.*)+`、`(\d+){2,}`、`(a{1,})+$`。
- **(b) 歧义 alternation**：被外部量词量化的分组里，某个分支是另一个分支的前缀（如 `(a|aa)+$`、`(a|ab)*`）；
  前缀比较同时对 **raw 分支** 与 **去掉未转义 `?`（非字符类内）的 normalized 分支** 进行，覆盖「可选分支导致的前缀重叠」如 `(a?|aa)+$`。
  另外覆盖「**简单字符类首 token 重叠**」：某分支整体是单个**非否定**字符类原子（如 `[a]`、`[a?]`、`[ab]`、`[a-c]`），
  设另一分支首个**字面字符** a0；**仅当 a0 在该字符集合内、且满足下列之一**才判为重叠：
    (a) 另一分支**仅有这一个字面**（如 `([a]|a)+$`、`([ab]|a)+$`）——等长等价切分歧义；
    (b) 另一分支**第二个字面字符 a1 也在集合内**（如 `([a]|aa)+$`、`([ab]|ab)+$`、`([a-c]|aa)+$`、`([d]|dd)+$`）——重复切分歧义；
    (c) 另一分支是**单可选字面 a0?**（a0 后紧跟未转义 `?` 且分支到此结束，如 `([a]|a?)+$`）——`a?` 等价「a 或空」，与 `[a]` 在外层 `+` 下形成大量切分（实测原生 JS regex `([a]|a?)+$` 对 `a^N!`：N=16≈43ms、N=18≈160ms、N=20≈610ms，超线性增长）。
  拒绝示例：`([a]|a)+$`、`([ab]|a)+$`、`([a]|aa)+$`、`([ab]|ab)+$`、`([a-c]|aa)+$`、`([d]|dd)+$`、`([a]|a?)+$`、`([a?]|aa)+$`、`([ab]|aa)+$`。
  **不误伤**：
  - a1 存在但**不在集合内** `([a]|ab)+$`、`([ab]|ac)+$`——选短的 class 分支后，下一字符立即失败（实测原生 JS regex `a^N!`/`ab^N!`/`ac^N!`，N≤28 均 0ms），非指数回溯形态；
  - 语义类 escape `([d]|\d\d)+$`（`\d` 首 token 为 null，不参与字面重叠；同理 `([?]|\d\d)+$` 放行）；a1 为语义 escape 且其后仍有内容时**保守放行**（如 `([a]|a\d)+$`，`a\d` 至少消费 a+数字、不等价空，实测 `a^N!`/`(a1)^N` N≤28 均 0ms）；
  - 类分支非单原子 `([a]b|aa)+$`（`[a]b` 不是单个字符类原子）；
  - a0 不在集合内 `([b]|aa)+$`、`([a]|b)+$`、`([ab]|cd)+$`。
  （`\d \D \s \S \w \W \b \B` 等语义 escape 不参与字面前缀判断；仅真正的 escaped literal 如 `\?`、`\.` 计字面。）
  **捕获 / 非捕获 / 命名捕获 / 一层非捕获包装均同等对待**：`(?:a|aa)+$`、`(?<x>a|aa)+$`、`(?:(?:a|aa))+$`、`(a?|aa)+$` 都拒绝；
  常见安全写法不误伤：`(a|b)+`、`(?:a|b)+`、`(?<x>a|b)+`、`(?:(?:a|b))+$`、`(a?)+$`、`(a?|b)+$`、`(ab?|cd)+$`（不把所有 `?` 内层量词当危险）。
- **(c) 边界声明**：这是**保守轻量 guard，非完整 regex sandbox / 非 RE2**，不引入重型依赖；常见安全写法仍放行：
  `TODO|FIXME`、`export\s+const`、`hello.*world`、`^foo$`、`(abc)+`、`(a|b)+`。

## P8-C grep 正则安全（语义原子 / 分支 unwrap 补洞）
> 状态：implemented（+测试+黑盒） · 最后更新：2026-06-28
> 承接 P8-B：P8-B 的「首 token 重叠」只识别**字面字符类**（`[a]`/`[a-c]`），对**语义原子**（`\d`/`\w`/`\s`/`.`/否定类 `[^...]`）与**分支整体被一层 group 包裹**的写法仍漏检。黑盒压测在 Node `RegExp` 上可复现明显退化/超时。

把 P8-B (b) 的「单字符类原子 vs 另一分支首字面」重叠判定，**推广**到两个维度——仍是字符串级轻量启发式、**非完整 regex parser**：

- **(d) 语义原子首 token 重叠**：某分支整体是单个**语义原子** A —— `\d`、`\w`、`\s`、`.`、或简单**否定字符类** `[^…]`；
  定义「A 覆盖 token t」：
  - `.` 覆盖任意字符与任意 escape；
  - `\d` 覆盖数字字面与 `\d`；`\w` 覆盖 `[A-Za-z0-9_]` 字面、`\d`、`\w`；`\s` 覆盖空白字面与 `\s`；
  - `[^X]` 覆盖「不在 X 集合内」的字面字符（X 取 P8-B 的 `classCharSet` 语义）。
  **判重叠**：另一分支首 token a0 被 A 覆盖，**且**第二 token a1 也被 A 覆盖（a1 可为字面，或被 A 覆盖的语义 escape）→ 拒绝。
  拒绝示例：`(\w|ab)+$`、`(\w|a\d)+$`、`(\d|11)+$`、`(\s|  )+$`、`([^b]|aa)+$`、`(.|aa)+$`。
  **不误伤**：a0 未被 A 覆盖即放行 —— `(\d|ab)+$`（`a` 非数字）、`(\w|!!)+$`（`!` 非 word）、`([^a]|aa)+$`（`a` 被 `[^a]` 排除）。
- **(e) 一层分支 group unwrap**：在按 top-level `|` 拆分后，对**每个分支**若其整体是单个 group（`(…)`/`(?:…)`/`(?<n>…)`）则**解包一层**再参与 (b)/(d) 的前缀/重叠比较（P8-B 既有「整段 body 解包」只处理 body 外层一层，不处理单个分支被包裹）。
  拒绝示例：`((a)|aa)+$`、`((?:a)|aa)+$`、`(?:(a)|aa)+$`、`(a|(?:aa))+$`（解包后等价 `(a|aa)+$`）。
- **(f) 边界声明**：语义原子覆盖关系只取**明显子集**（上面列出的几条），不做 `\D`/`\S`/`\W`/Unicode 属性/区间求交等完整集合代数；分支 unwrap 只做**一层**；否定类只解析简单 `[^…]`（不含嵌套/转义复杂形态）。**仍是保守轻量启发式，非 RE2 / 非完整 parser**；宁可漏检也不误伤常见安全写法。

## P7-B 工具文件大小上限
- 常量集中 `src/tools/limits.ts`：`MAX_TOOL_FILE_BYTES = 5 MiB`。
- `read_file`：先 `stat`，超上限**直接拒绝**（不整文件读入再截断）。
- `edit_file`：先 `stat`，超上限拒绝（不全读）。
- `write_file`：`content` 字节数超上限拒绝。
- 错误文案明确含「文件过大 / 内容过大」+ 字节数与上限。

## P7-C 配置硬上限
- Loop 工程不能失控；`config.md` 字段加硬上限，zod `.max()`：
  - `timeoutMs ≤ 120000`（与 run_shell 上限一致）、`maxTurns ≤ 50`、`maxRetries ≤ 5`。
- 超限报错指出字段与上限；边界值（=上限）通过。

## P7-D run_shell 进程树清理
- 不变量：**timeout/abort 必须结束 shell 进程树**，run_shell Promise 不得悬挂。
- 实现：POSIX 用 `spawn(..,{detached:true})` 建独立进程组，超时/中断时 `process.kill(-pid, SIGKILL)` 杀整组；失败 fallback `child.kill('SIGKILL')`。不引入重型依赖。
- 保留正常 echo 与大输出截断（LH2）行为。

## 验收（测试，确定性）
| # | 用例 |
|---|---|
| P7-A | symlink 读/写/编辑/列目录被拒，root 外文件未被读写；checkpoint/workspace 经 symlink 入口被拒 |
| P7-E | glob cwd=`..`/pattern=`../outside`/grep include=`../outside`/绝对路径/经 root 内 symlink 均越界 `ok:false`；root 内回归正常 |
| P8-A | grep 12MiB 文件不读、结果含 `(无匹配)`+`已跳过 N 个过大文件`；含 SECRET 也不泄漏 |
| P8-B | grep nested quantifier / 歧义 alternation（含可选分支 `(a?|aa)+$`、字符类首 token `([a]|a)+$`/`([ab]|a)+$`/`([a]|aa)+$`/`([ab]|ab)+$`/`([a-c]|aa)+$`/`([a]|a?)+$`/`([a?]|aa)+$`/`([ab]|aa)+$`，及捕获/非捕获/命名/一层包装变体）`ok:false`（正则过于复杂/可能退化），不卡死；常见正则（`(a|b)+`、`(?:a|b)+`、`(?<x>a|b)+`、`(?:(?:a|b))+$`、`(a?)+$`、`(a?|b)+$`、`(ab?|cd)+$`、`([b]|aa)+$`、`([a?]|b)+$`、`([ab]|cd)+$`、`([a]|ab)+$`、`([ab]|ac)+$`、`([a]|a\d)+$`、`([d]|\d\d)+$`、`([a]b|aa)+$`）不误伤 |
| P8-C | grep 语义原子首 token 重叠（`(\w|ab)+$`、`(\w|a\d)+$`、`(\d|11)+$`、`(\s|  )+$`、`([^b]|aa)+$`、`(.|aa)+$`）与一层分支 unwrap（`((a)|aa)+$`、`((?:a)|aa)+$`、`(?:(a)|aa)+$`、`(a|(?:aa))+$`）`ok:false`、不卡死；不误伤 `(\d|ab)+$`、`(\w|!!)+$`、`([^a]|aa)+$`（implemented） |
| P7-B | 12MiB 文件 read_file/edit_file 快速拒绝；12MiB content write_file 拒绝；错误清晰 |
| P7-C | timeoutMs/maxTurns/maxRetries 边界值通过、超限报错并指出字段 |
| P7-D | timeout 命令在外层 Promise.race 内返回（不假死）；唯一 marker 进程结束后 pgrep 无残留 |

## 关联
- 路径沙箱 → [`tools.md`](tools.md) · 配置 → [`config.md`](config.md) · 资源上限 → [`load-hardening.md`](load-hardening.md)
- 计划 → [`../exec-plans/active/phase-7.md`](../exec-plans/active/phase-7.md)
