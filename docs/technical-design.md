# MonoShell 技术设计文档

> 版本：v1.0
> 范围：AI 核心层三个新模块（排障方法论、命令解释、排查注记）的设计与实现口径；SSH 连接策略；配置扩展；测试策略。
> 配套产品文档：见 `docs/PRODUCT.md`（产品能力、验收标准）。

---

## 1. 设计基线（复用现有模块）

以下现有模块直接复用，不做改动：

| 模块 | 文件 | 复用内容 |
|---|---|---|
| ReAct 编排 | `src/core/agent.ts` | 规划-执行-看输出-再规划闭环，`maxRounds`/`retries`/`timeoutMs` 控制，可注入假模型测试 |
| 系统提示词 | `src/core/prompt.ts` | 环境描述、决策 JSON 协议、历史块 |
| 双重安全门禁 | `src/core/safety.ts` | 高危黑名单、写重定向拦截、只读白名单、双档判定 |
| 交互密码嗅探 | `src/core/safety.ts` | `detectInteractiveAuth` / `sniffPasswordPrompt` |
| 配置系统 | `src/config.ts` | 默认值合并、`.bak` 备份、`chmod 600` |
| 输出捕获擦除 | `src/term/capture.ts` | 标记注入 + 流式 Scrubber |
| 会话抽象 | `src/session/types.ts` | `SessionContext`（环境描述）与 `Session`（IO）分离 |
| 连接选择器 | `src/app/picker.ts` | 本地 + 远程主机库 |

---

## 2. 网络与连接策略

### 2.1 连接层

- 协议与认证使用 `ssh2` 库，私钥优先、密码兜底。
- 握手规范化（`src/session/handshake.ts`）只保留必要的握手任务分隔，不做终端回显规范化。
- 全屏直通嗅探（`src/term/passthrough.ts`）退出主线，不再拦截全屏切换。

### 2.2 会话通道

- 开通远端 PTY 通道，命令与输出原生透传，不手工纠正远端回显。
- 全屏程序由远端 PTY 语义原生支持，不自行嗅探备用屏序列。
- 用户输入回显与提示符由本地终端渲染；AI 生成命令命中安全门禁或需要交互密码时，保持既有的行内确认与交回终端逻辑。

### 2.3 安全底线（不改动）

- `detectInteractiveAuth`（sudo / su / passwd / mysql -p 等密码命令预判）。
- `checkRisk`（高危门禁，`full` / `dangerous` 双档）。
- `sniffPasswordPrompt`（运行时输出嗅探）。
- 以上作用于"命令是否执行"，与终端渲染无关，必须保留。

---

## 3. 模块设计

### 3.1 `src/core/triage.ts` — 排障方法论

将四象限探查模型注入模型上下文，约束 AI 排查顺序。

```ts
export type Quadrant = 'resource' | 'service' | 'network' | 'log';
export const QUADRANT_ORDER: Quadrant[] = ['resource', 'service', 'network', 'log'];

/** 返回注入 systemPrompt 的方法论片段 */
export function triageSystemSnippet(): string;

/** 返回指定象限的常用只读命令提示 */
export function quadrantHint(q: Quadrant): string;

/** 依据已执行步骤粗略判断当前进度象限 */
export function currentQuadrant(steps: Step[]): Quadrant;
```

四象限顺序与默认只读命令：

| 层 | 定位 | 默认命令 |
|---|---|---|
| L1 资源 | 磁盘 / 内存 / CPU / 负载 | `df -h` `free -m` `uptime` `top` |
| L2 服务 | 进程 / 服务状态 | `systemctl status` `ss -tlpn` `ps` |
| L3 网络 | 端口 / 连通性 | `ss -tn` `curl -v` `ping` |
| L4 日志 | 应用 / 系统日志 | `journalctl` `tail /var/log` `dmesg` |

实现方式：V0 通过 `triageSystemSnippet()` 拼入 `systemPrompt`，并在 `historyBlock` 中标注当前所处象限。`currentQuadrant()` 依据已执行命令所属层判断进度。

### 3.2 `src/core/explain.ts` — 命令解释

决策 JSON 增加可选字段，命令下方渲染原理注释。

```ts
export type ExplainedDecision = {
  note: string;      // 一句话说明要做什么
  command: string;   // 要执行的命令
  done: boolean;     // 是否收尾
  why?: string;      // 原理注释，≤40 字，中文
  expect?: string;   // 预期输出说明
};

/** 清洗 why，超长截断、去除控制字符，防注水与终端转义注入 */
export function sanitizeWhy(s: string, max = 40): string;

/** 校验 expect，同上做清洗 */
export function sanitizeExpect(s: string, max = 60): string;
```

渲染示例：

```text
$ ps aux --sort=-%mem | head -n 6
· 原理：ps 列进程，--sort 按内存降序，head 取前 6 行
· 预期：看到 %MEM 最高的 6 个进程
```

行为约定：`agent.explain:true` 时，模型输出的每条非 `done` 命令都附加 `why`；模型未输出 `why`/`expect` 时跳过渲染，不中断流程。`agent.explain:false` 时不要求模型生成，也不渲染。

### 3.3 `src/core/notes.ts` — 排查注记

#### 存储结构

```text
~/.ai-shell/notes/
  <host-slug>/
    <yyyy-mm-dd>_<seq>.md
```

纯文件系统存储，内存索引；不引入数据库。

#### 注记文件模板

```markdown
# <日期> <标题症状> (<主机名>)
## 症状
<用户原话>
## 排查链路
1. <命令> → <结论>
2. ...
## 根因
<AI 归纳>
## 处置
<执行的写入/修复命令，含 confirm>
## 标签
#<主机> #<标签>
```

#### 数据模型与接口

```ts
export interface Note {
  host: string;        // 主机名/别名
  path: string;        // 文件绝对路径
  title: string;       // 标题
  created: number;     // 时间戳
  tags: string[];      // 标签
  content: string;     // 完整 markdown
}

interface NoteDraftInput {
  title: string;
  symptom: string;
  steps: { command: string; note: string; exitCode: number }[];
  rootCause: string;
  actions: string[];
  tags: string[];
}

/** 生成注记草稿，不写盘。调用方仅在用户确认后保存。 */
export function buildNoteDraft(input: NoteDraftInput): Note;

/** 将草稿写入磁盘；仅在用户确认后调用。 */
export async function saveNote(draft: Note): Promise<Note>;

export async function listNotes(host?: string): Promise<Note[]>;
export async function getNote(host: string, id: string): Promise<Note | null>;
export async function searchNotes(query: string): Promise<Note[]>;
```

#### 触发与保存

- 触发：ReAct 循环到达 `done:true` 或 `maxRounds` 时，调用 `buildNoteDraft` 生成草稿。
- 保存：询问用户（y 保存 / N 不保存），确认后调用 `saveNote`；`agent.noteConfirm:false` 时直接不生成不询问。

### 3.4 `src/app/note.ts` — CLI 子命令

```text
ai note ls [<主机>]           # 列出注记
ai note show <id>            # 查看单条
ai note search <关键词>       # 全文/标签检索
ai note rm <id>              # 删除
```

### 3.5 `src/app/inspect.ts` — 多主机巡检（V1）

对已保存主机并发执行只读命令集，汇总回显。

```ts
interface InspectResult {
  host: string;
  ok: boolean;
  error?: string;
  metrics: Record<string, string>;
  alert: boolean;            // 命中阈值（如磁盘 > 90%）
}
```

- 并发台数、超时、keepalive 间隔取自 `inspect` 配置段。
- 只读命令集为固定白名单（`df` / `free` / `uptime` / `ss` 等），不执行任何写入。
- 结果只回显，不落盘。

---

## 4. 配置扩展

`src/config.ts` 扩展：

```ts
export type AgentConfig = {
  maxRounds: number;
  retries: number;
  timeoutMs: number;
  explain: boolean;        // 默认 true，命令附原理注释
  triage: boolean;         // 默认 true，注入排障方法论
  noteConfirm: boolean;    // 默认 true，排查结束确认后存注记
};

export type NotesConfig = {
  dir: string;             // 默认 ~/.ai-shell/notes
};

export type InspectConfig = {
  parallel: number;        // 默认 5
  timeoutMs: number;       // 默认 15000，单台巡检超时
  keepaliveMs: number;     // 默认 30000，TCP keepalive 间隔
  cmdTimeoutMs: number;    // 默认 10000，单条命令超时
};
```

`mergeConfig` 与默认值构造同步补充上述字段，保持老配置平滑合并。

---

## 5. 提示词协议扩展

`src/core/prompt.ts`：

1. 决策 JSON 协议增加 `why`、`expect` 字段（可选，向后兼容；模型不输出则跳过）。
2. `systemPrompt` 追加 `triageSystemSnippet()` 返回的方法论片段（受 `agent.triage` 控制）。
3. `historyBlock` 末尾追加当前象限标注（由 `currentQuadrant` 提供，受 `agent.triage` 控制）。

---

## 6. 数据流

单次排查（V0）：

```text
用户输入「ai 磁盘满了」
  → Agent.run(goal)
      1. systemPrompt 注入 triage 方法论
      2. 循环（至多 maxRounds 次）：
         模型 → {"note","command","why","expect","done"}
         → explain 渲染 why/expect 注释（受 agent.explain 控制）
         → safety 校验 checkRisk / detectInteractiveAuth
         → 执行捕获 → 回灌 historyBlock（含象限进度）
      3. done:true 或 maxRounds：
         → notes.buildNoteDraft 生成草稿（不写盘）
         → 询问用户 → 确认后 saveNote（受 agent.noteConfirm 控制）
```

多主机巡检（V1）：

```text
选中多台主机 → 下发只读命令集（并行，受 inspect.parallel 控制）
  → 每台 keepalive 保活、超时中断 → 汇总 InspectResult 表格 → 回显（不写盘）
```

---

## 7. 测试策略

沿用现有 `tsx 直跑 + process.exit(failures ? 1 : 0)` 模式。

```
test/triage.ts     # 象限顺序、方法论片段、进度判断
test/explain.ts    # why/expect 渲染、超长截断、控制字符清洗、开关行为
test/notes.ts      # 草稿生成、确认后落盘、列表、检索、标签匹配、取消不写盘
test/inspect.ts    # (V1) 多主机并发、超时、keepalive 保活
```

切入 `package.json` 的 `test` 链与各 `test:*` 脚本。

---

## 8. 交付清单

1. `triage.ts` / `explain.ts` / `notes.ts` 三个新模块。
2. `prompt.ts` / `config.ts` 增强。
3. `note.ts` CLI 子命令（V0）；`inspect.ts` 巡检模块（V1）。
4. 四套单元测试，全量 `npm test` 通过。