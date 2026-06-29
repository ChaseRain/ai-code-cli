# Exec Plan: Phase 8 — grep 资源与正则安全硬化

> 状态：P8-A/P8-B/P8-C implemented（+测试+复现+黑盒） · 最后更新：2026-06-28
> 不做新功能，只硬化 grep 的资源与正则安全边界。承接 Phase-7 现状 `npm run build && npm test` = 174/174。
> 规格：[`../../product-specs/guardrails-hardening.md`](../../product-specs/guardrails-hardening.md)。

## 风险输入（独立复现）
- **P8-A** grep 绕过文件大小守护：read/edit/write 已受 `MAX_TOOL_FILE_BYTES=5MiB` 约束，但 `grep` 对 12MiB `big.txt` 仍 `fs.readFile` 整文件扫描，返回 ok:true `(无匹配)`，无跳过提示。
- **P8-B** JS 正则 ReDoS：`evil.txt='a'.repeat(34)+'!'` + `grep((a+)+$)`，外部 `timeout 3s` 仍不返回（同步正则卡死事件循环 / TUI）。
- **P8-C** 语义原子 / 分支 unwrap ReDoS 漏检：黑盒压测发现 `(\w|ab)+$`、`(\w|a\d)+$`、`(\d|11)+$`、`(\s|  )+$`、`([^b]|aa)+$`、`(.|aa)+$`、`((a)|aa)+$`、`((?:a)|aa)+$`、`(?:(a)|aa)+$`、`(a|(?:aa))+$` 在 Node `RegExp` 上明显退化/超时，但 P8-B 的 `isPotentiallyCatastrophicRegex` 仍放行（首 token 重叠只识别字面字符类、不处理语义原子与单分支 group 包裹）。

## 里程碑
- [x] **P8-A** grep stat-before-read：超 `MAX_TOOL_FILE_BYTES` 跳过并在结果提示跳过数量与上限。✅
- [x] **P8-B** grep 拒绝明显危险的 **nested quantifier / 歧义 alternation** 正则（`isPotentiallyCatastrophicRegex`；覆盖 捕获 / 非捕获 `?:` / 命名 `?<n>` / 一层包装 / 可选分支 `a?` 前缀重叠），`ok:false` 含「正则过于复杂/可能退化」。✅
- [x] **P8-C** 把首 token 重叠推广到**语义原子**（`\d`/`\w`/`\s`/`.`/否定类 `[^…]`）+ **一层分支 group unwrap**（`semanticAtom`/`tokenAt`/`unwrapOneGroup`），并修掉空白分支被 trim 误删的问题。✅

## 验收矩阵
| # | 验收点 | 验证 |
|---|---|---|
| P8-A1 | 12MiB 文件 + 不命中：ok:true，content 含 `(无匹配)` 与 `已跳过 1 个过大文件` | tests/guardrails.test.ts |
| P8-A2 | 12MiB 文件含 SECRET：`grep(SECRET)` 不泄漏 SECRET，仅提示跳过 | tests/guardrails.test.ts |
| P8-B1 | nested quantifier / 歧义 alternation（含可选分支与字符类首 token 重叠：`(a+)+$`、`(a|aa)+$`、`(?:a|aa)+$`、`(?<x>a|aa)+$`、`(?:(?:a|aa))+$`、`(a?|aa)+$`、`([a]|a)+$`、`([ab]|a)+$`、`([a]|aa)+$`、`([ab]|ab)+$`、`([a-c]|aa)+$`、`([a]|a?)+$`、`([a?]|aa)+$`、`([ab]|aa)+$`）→ ok:false，错误匹配 `/正则.*复杂|退化/`，不卡住 | tests/guardrails.test.ts |
| P8-B2 | 常见正则放行并能命中（`TODO|FIXME`、`export\s+const`、`(abc)+`、`(a|b)+`、`(?:a|b)+`、`(?<x>a|b)+`、`(?:(?:a|b))+$`、`(a?)+$`、`(a?|b)+$`、`(ab?|cd)+$`、`([b]|aa)+$`、`([a?]|b)+$`、`([ab]|cd)+$`、`([a]|ab)+$`、`([ab]|ac)+$`、`([a]|a\d)+$`、`([d]|\d\d)+$`、`([a]b|aa)+$`） | tests/guardrails.test.ts |
| P8-C1 | 语义原子首 token 重叠 + 一层分支 unwrap：`(\w|ab)+$`、`(\w|a\d)+$`、`(\d|11)+$`、`(\s|  )+$`、`([^b]|aa)+$`、`(.|aa)+$`、`((a)|aa)+$`、`((?:a)|aa)+$`、`(?:(a)|aa)+$`、`(a|(?:aa))+$` → helper=true、`grep` ok:false 且不卡死（implemented） | tests/guardrails.test.ts |
| P8-C2 | 不误伤：`(\d|ab)+$`、`(\w|!!)+$`、`([^a]|aa)+$`（含命中 `aa` 分支）→ helper=false、`grep` ok:true（小输入命中） | tests/guardrails.test.ts |
| P8-Z | 历史回归全绿 | `npm run build && npm test` |

## 回归隔离修复（2026-06-28，全量 npm test 稳定性）
- 现象：全量并跑时 `diff-git.test.ts > P6-B1` 偶发失败（期望「diff 不可用」实得「非 Git 仓库」），单跑通过。
- 根因：P6-B1 用 fake git + `AICODE_GIT_TIMEOUT_MS=1000`；并行 CPU 争用下，**rev-parse 的进程启动**偶尔 > 1000ms 被判超时 → `isGitRepo` 误判 false → 走非 Git 降级分支（与超时诊断无关）。pool=forks 已隔离各文件 env，非 PATH 竞态。
- 修复目标：**全量 `npm test` 必须稳定绿**；不放宽断言（仍要求「diff 不可用 + 超时」诊断）。
- 修复手段：把「root 判定」与「diff 超时」解耦——超时放宽到 4000ms（rev-parse 启动有 ~40× 余量、不会误超时），fake git `diff` 改 `sleep 10`（仍必然在 4s 触发超时）。

## P8-B 回归补洞（2026-06-28，验收发现）
- 复现 1：`(a{1,})+$` —— 旧检测内层只认 `*`/`+`，**漏 `{}` 量词**；34×`a`+`!` 小文件下被 3s alarm 杀掉（exit 142），仍卡死事件循环。
- 复现 2：`(a|aa)+$` —— 歧义 alternation（分支 `a` 是 `aa` 的前缀）+ 外层量词，相同输入耗时 ~2264ms，超线性退化；旧 guard 漏掉。
- 复现 3：`(?:a|aa)+$` —— **非捕获分组**写法的同类歧义 alternation；alternation 检测未剥离 `?:`，在 evil.txt 上耗时 ~4030ms 后 ok:true `(无匹配)`，漏网。
- 复现 4：`(?<x>a|aa)+$` —— **命名捕获**绕过；约 2281ms 后 ok:true `(无匹配)`。
- 复现 5：`(?:(?:a|aa))+$` —— **一层非捕获包装**绕过（外层组含内层括号，旧单 regex 因 `[^()]` 无法跨括号）；约 1481ms 后 ok:true `(无匹配)`。
- 根因：旧实现用单条 regex 检测 alternation，只认捕获分组、未处理 `?:`/`?<name>` 前缀，也不能穿透一层括号包装。
- 修复：抽小 scanner——对「`)` 紧跟外层量词」的分组，回溯匹配 `(`，取 body 规范化（去 `?:`/`?<name>`、一层单组解包）后按 top-level `|` 拆分支查前缀重叠。**不放宽断言、不引重依赖、非完整 parser**；常见安全正则不误伤。
- 验收用例：helper 命中 `(a+)+$`/`(.+)*`/`(.*)+`/`(\d+){2,}`/`(a{1,})+$`/`(a|aa)+$`/`(?:a|aa)+$`/`(?<x>a|aa)+$`/`(?:(?:a|aa))+$`；`grep.execute` 对 `(a{1,})+$`/`(a|aa)+$`/`(?:a|aa)+$`/`(?<x>a|aa)+$`/`(?:(?:a|aa))+$` 扫描前 `ok:false` 不卡死；放行 `TODO|FIXME`/`export\s+const`/`hello.*world`/`^foo$`/`(abc)+`/`(a|b)+`/`(?:a|b)+`/`(?<x>a|b)+`/`(?:(?:a|b))+$`。

## P8-B 回归补洞 ②（2026-06-28，第四轮验收）
- 复现 6：`(a?|aa)+$` + evil.txt —— 可选分支 `a?` 使两分支在「a」处重叠，外层 `timeout 5s` 被杀（exit 124）；
  旧检测只比 raw 分支（`aa`.startsWith(`a?`)=false）漏掉。
- 修复：`hasAmbiguousAlternation` 前缀比较时，额外对「去掉未转义、非字符类内 `?` 的 normalized 分支」再比一次（`stripOptionalQuantifiers`）。
- 设计取舍：**只做简单 branch-normalization**，不把所有 `?` 内层量词当危险 → 不误伤 `(a?)+$`、`(a?|b)+$`、`(ab?|cd)+$`（实测 ~8ms 快速 ok:true）；不改动 (a) nested-quantifier 正则（避免误伤 `(ab?|cd)+$`）。

## P8-B 回归补洞 ③（2026-06-28，第五轮验收）
- 复现 7：字符类首 token 与长分支首字面量等价导致的前缀重叠（evil.txt=`'a'.repeat(34)+'!'`）：
  `([a]|aa)+$` ~2357ms、`(?:[a]|aa)+$` ~1424ms、`(?<x>[a]|aa)+$` ~2368ms、`(?:(?:[a]|aa))+$` ~1468ms、`([a?]|aa)+$` ~2557ms、`([ab]|aa)+$` ~2412ms（均 helper=false 后 ok:true 退化）。
- 安全对照（不应误伤）：`([b]|aa)+$` ~2ms、`([a?]|b)+$` ~2ms。
- 根因：分支前缀比较未理解「字符类原子」；`[a]` 与 `aa` 在「a」处等价重叠未被识别。
- 修复：新增小 helper——若某分支整体是**单个非否定简单字符类**（`[a]`/`[a?]`/`[ab]`/简单 `a-c` range），其字符集合包含另一分支的首个字面字符，则判定重叠。**只用于 alternation 分支比较，不改 nested-quantifier 大正则**。
- 设计取舍：只识别「单字符类原子 + 长分支首字面量」这一窄形态；不解析否定类 `[^...]`、不消费多字符、不做完整 parser；故 `([b]|aa)+$`、`([a?]|b)+$`、`([ab]|cd)+$`、`(a\?|aa)+$` 不误伤。

## P8-B 回归补洞 ④（2026-06-28，第六轮验收 —— 收窄字符类规则、消除误伤）
- ~~误伤 1：`([a]|a)+$` 被错判 true（等长等价分支，非 ReDoS）~~ **该判断后续被补洞⑤证伪**：`([a]|a)+$` 实为等价/重叠分支，放行后会卡死，必须拒绝（见 ⑤）。本条仅作历史记录。
- 误伤 2：`([d]|\d\d)+$` 被错判 true——`firstLiteralChar` 把 `\d` 当成字面 `d`；语义类 escape 不应参与字面前缀判断。**此条结论正确并保留至今**。
- 安全对照仍放行：`([a]b|aa)+$`（类分支非单原子）。仍拒绝：`([a]|aa)+$`、`([a-c]|aa)+$`、`([d]|dd)+$`。
- 修复：① 收窄规则——另一分支须以**两个都在类集合内的字面字符**开头（构成长度歧义），等长单字符不触发；
  ② `literalAt`/`firstLiteralChar` 对 `\d \D \s \S \w \W \b \B`、`\n \r \t`、`\xNN`/`\uNNNN`、反向引用 `\1` 等返回 null，仅 escaped literal 计字面。

## P8-B 回归补洞 ⑤（2026-06-28，第七轮验收 —— 收窄过头，等长等价误判为 safe）
- 复盘：补洞 ④ 的「两个字面字符」收窄**矫枉过正**——把 `([a]|a)+$` 当成「等长无歧义」放行，但它是**等价/重叠分支**（`[a]` 与 `a` 在外层 `+` 下等价），实测放行后 `vitest -t 'P8'` 直接卡住（同 `(a|a)+$`/`(a|aa)+$` 一类退化）。
- 误伤 2 仍需避免：`([d]|\d\d)+$` —— `\d` 是语义类、不是字面 `d`，必须 helper=false、grep ok:true。这是本轮真正要保住的「不误伤」。
- 修复：**回退「两个字面字符」为「一个字面字符」**——类集合含另一分支首个**字面字符**即判重叠（无论等长 `([a]|a)+$`/`([ab]|a)+$` 还是更长 `([a]|aa)+$`）；
  **保留** ④ 对 `literalAt` 语义 escape 返回 null 的修复，故 `([d]|\d\d)+$` 首 token=null 不触发、`([a]b|aa)+$` 类分支非单原子不触发。
- 验收：helper=true 且 grep ok:false（快速）：`([a]|a)+$`、`([ab]|a)+$`、`([a]|aa)+$`、`([a-c]|aa)+$`、`([d]|dd)+$`；
  helper=false 且 grep ok:true（小输入快速）：`([d]|\d\d)+$`、`([a]b|aa)+$`、`([b]|aa)+$`。

## P8-B 回归补洞 ⑥（2026-06-28，第八轮验收 —— 减少 class-prefix false positive）
- 误伤复现：补洞⑤回退为「首个字面字符在类集合内即拒绝」后，`([a]|ab)+$`、`([ab]|ac)+$` 被一并拒绝；但原生 JS regex 子进程实测 `a^N!`/`ab^N!`/`ac^N!`，N≤28 均 **0ms**——这类「短 class 分支 + 长分支第二个字面不在集合内」选短分支后下一字符立即失败，不是指数回溯形态，应放行。
- 仍须拒绝：`([a]|a)+$`、`([ab]|a)+$`（等长等价）、`([a]|aa)+$`、`([ab]|ab)+$`、`([a-c]|aa)+$`（第二字面仍在集合内 → 重复切分歧义）。
- 修复（窄判定，非完整 parser）：classCharSet 分支取另一分支首个字面 a0；a0 不在 set → 放行；a0 在 set 时——
  ① 另一分支仅此单字面（a0 之后到末尾再无内容）→ 拒绝（等长等价）；
  ② 第二个字面 a1 在 set → 拒绝（重复切分）；
  ③ a1 存在但不在 set → 放行；④ a1 为量词/语义 escape（literalAt=null）但其后仍有内容 → **保守放行**（不构成纯单字面歧义，避免误伤 `([?]|\d\d)+$`）。
- 保留补洞④对 `literalAt` 语义 escape 返回 null 的修复（`([d]|\d\d)+$` 首 token=null → a0 不在 set → 放行）。
- 验收：helper=true + grep ok:false（快速）：`([a]|a)+$`、`([ab]|a)+$`、`([a]|aa)+$`、`([ab]|ab)+$`、`([a-c]|aa)+$`；
  helper=false + grep ok:true（小输入快速）：`([a]|ab)+$`、`([ab]|ac)+$`、`([d]|\d\d)+$`、`([a]b|aa)+$`。

## P8-B 回归补洞 ⑦（2026-06-28，第九轮验收 —— 单可选字面 class-overlap 漏检）
- 漏检复现：补洞⑥后 `([a]|a?)+$` 仍 helper=false 被放行，但原生 JS regex `new RegExp('([a]|a?)+$').test('a'.repeat(N)+'!')` 超线性增长——N=16≈43ms、N=18≈160ms、N=20≈610ms；grep 放行有卡顿风险。
- 根因：`a?` 首字面 a0='a' 在集合内，但其后是量词 `?`（literalAt=null），落入补洞⑥「a1 为量词/语义 escape → 保守放行」分支，未识别「单可选字面等价『a 或空』」这一与 `[a]` 的切分歧义。
- 对照（仍放行）：`([a]|a\d)+$` —— `a\d` 至少消费 a+数字、不等价空，实测 `a^N!`/`(a1)^N` 到 N=28 均 0ms。
- 修复（窄判定）：classCharSet 分支中 a0 在 set 时新增 (c)：a0 后**紧跟未转义 `?` 且分支到此结束**（单可选字面 `a?`）→ 拒绝。仍**不**重新扩大为拒绝所有 `?`——`(a?)+$`（单分支）、`(a?|b)+$`（norm 前缀不重叠）、`([a]|a\d)+$`（a1 语义 escape、非单可选）保持 safe。
- 验收：helper=true + grep ok:false（快速）：`([a]|a?)+$`；helper=false + grep ok:true：`([a]|ab)+$`、`([ab]|ac)+$`、`([a]|a\d)+$`、`(a?)+$`、`(a?|b)+$`、`(ab?|cd)+$`。

## P8-C 实现（2026-06-28，第十轮 —— 语义原子 / 分支 unwrap，已落地）
- 漏检根因：
  - P8-B 的首 token 重叠只认**字面字符类** `classCharSet`（`[a]`/`[a-c]`），对语义原子 `\d`/`\w`/`\s`/`.`/否定类 `[^…]` 不识别 → `(\w|ab)+$`、`(\w|a\d)+$`、`(\d|11)+$`、`(\s|  )+$`、`(.|aa)+$`、`([^b]|aa)+$` 漏；
  - 分支前缀比较未对**单个分支被一层 group 包裹**做 unwrap（既有只解「整段 body 外层一层」）→ `((a)|aa)+$`、`((?:a)|aa)+$`、`(?:(a)|aa)+$`、`(a|(?:aa))+$` 漏。
- 实现（不引重依赖、保持轻量启发式，全在 `src/tools/grep.ts`）：
  1. `semanticAtom(branch)`：识别 branch 整体是否为 `\d`/`\w`/`\s`/`.`/简单 `[^…]`，返回「覆盖判定」`covers(token)`；
     `.` 覆盖一切；`\d`→数字字面+`\d`；`\w`→`[A-Za-z0-9_]`字面+`\d`+`\w`；`\s`→空白字面+`\s`；`[^X]`→不在 `classCharSetFromContent(X)` 内的字面（语义 escape 保守不覆盖）。
  2. `tokenAt(s,i)`：读单 token（字面 `lit` 或语义 escape `esc`，通配 `.` 记为 esc='.'，`\n\r\t\f\v` 归一为空白字面），分组/类/锚点/量词起始返回 null。
  3. `hasAmbiguousAlternation` 两两比较里扩展一支：若 alts[i] 是 semanticAtom，且 alts[j] 前两个 token（t0、t1）均被 `covers` → return true。
  4. `unwrapOneGroup(branch)`：分支整体是单个 `(…)`/`(?:…)`/`(?<n>…)` 时解包一层 + `stripGroupPrefix`，拆分支后对每个分支先 unwrap 再参与 prefix/class/semantic 比较（覆盖 `((a)|aa)` 等）。
  5. **修掉空白分支误删**：`hasAmbiguousAlternation` 不再对分支 `trim()`（正则里空白是字面字符），改为 `splitTopLevel(...).filter((s) => s.length > 0)`——既保住 `(\s|  )` 的 `"  "` 分支，又过滤真正空分支（如 `(a|)`）避免 `''.startsWith` 误判；whole-body 解包处的 `.trim()` 也一并去掉。
  6. 覆盖关系仅取明显子集、unwrap 只一层、否定类只简单 `[^…]`——非完整集合代数 / 非 RE2，宁漏不误伤。
- 已知**不覆盖**（诚实声明，留待后续或 RE2）：`\D`/`\S`/`\W`、Unicode 属性 `\p{…}`、区间求交（如 `([a-m]|n)`）、两层以上 group 包裹、`a*`/`a{0,n}` 形态可选量词与语义原子组合、语义原子分支以 `[^X]` 覆盖语义 escape（保守放行）。
- 复现/黑盒：独立脚本对 dist `grep` 跑 10 danger（均 `ok:false`、<1ms，不卡死）+ 3 safe（`ok:true` 命中），ALL PASS。

## 设计取舍
- **轻量 guard，非 RE2**：nested-quantifier 检测是保守启发式（覆盖常见灾难式回溯），**不宣称完整替代 RE2**，不引入重型依赖；正常常见正则不误伤。
- 不把 grep 改成 worker/子进程系统——简单 stat + 字符串级正则检测即可关闭两个风险，可测、改动小。
- 复用 `MAX_TOOL_FILE_BYTES`（`src/tools/limits.ts`），与 Phase-7 文件大小守护一致。

## 复现脚本记录（临时脚本对 dist，2026-06-28）
- **P8-A** 12MiB `big.txt` 含 `SECRET_MARKER` + `grep(SECRET)`：`ok:true`、**泄漏=false**、content 含「已跳过 1 个过大文件」。
- **P8-B** `grep((a+)+$)`（evil.txt 40×a+!）：**0ms** 返回 `ok:false`、文案命中 `/正则.*复杂|退化/`，不卡死。
- 回归：`npm run build && npm test` = **213/213**、`build` exit 0、`git diff --check` 干净。
