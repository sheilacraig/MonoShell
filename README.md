# MonoShell (ai / mono) — 自带 Shell 的单窗口 AI 运维终端

[![Node.js Version](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7+-blue.svg)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux%20%7C%20macOS-lightgrey.svg)]()

> **单窗口 AI 终端：直接敲命令，也直接说人话。高危命令强制二次确认。**  
> 没有左右分栏，没有聊天气泡，没有笨重的 Electron 壳——始终保持原生终端的纯粹与高效。

---

## 目录

- [为什么选择 MonoShell？](#为什么选择-monoshell)
- [交互流演示](#交互流演示)
- [核心特性](#核心特性)
- [系统架构与原理](#系统架构与原理)
- [安装与运行](#安装与运行)
- [配置说明](#配置说明)
  - [配置文件位置](#配置文件位置)
  - [完整配置示例](#完整配置示例)
  - [主流大模型接入指南](#主流大模型接入指南)
- [使用手册](#使用手册)
  - [CLI 命令速查](#cli-命令速查)
  - [配置引导（推荐）](#配置引导推荐)
  - [启动：选择连接](#启动选择连接)
  - [本地 Shell 与快捷键](#本地-shell-与快捷键)
  - [SSH 远程主机管理](#ssh-远程主机管理)
  - [AI 触发与 ReAct 闭环](#ai-触发与-react-闭环)
  - [AI 执行策略（轮数 / 重试）](#ai-执行策略轮数--重试)
  - [需要密码的命令（sudo / su 等）](#需要密码的命令sudo--su-等)
  - [高危命令二次确认机制](#高危命令二次确认机制)
- [实战运维场景](#实战运维场景)
- [内置命令支持列表](#内置命令支持列表)
- [项目目录结构](#项目目录结构)
- [已知限制与设计权衡](#已知限制与设计权衡)
- [本地开发与测试](#本地开发与测试)

---

## 为什么选择 MonoShell？

在日常开发与服务器运维中，传统 AI 工具往往面临如下痛点：

1. **界面割裂**：多数 AI 运维工具基于 Electron 或 Web 页面（如左右分栏、聊天抽屉、对话气泡），破坏了命令行终端的沉浸感与原有工作习惯；
2. **跨平台环境怪癖**：在 Windows 平台下，通过脚本驱动 PowerShell 极其容易被 `PSReadLine` 语法高亮回显污染、换行续行卡死（`>>` 模式）、退出码丢失；
3. **安全隐患**：许多 AI 命令行工具直接代为执行大模型生成的脚本，一旦模型产生幻觉给出 `rm -rf /`、强制覆盖或误停核心服务，后果灾难；
4. **SSH 繁琐**：每次操作远程服务器需要反复配置连接参数、输入密码，缺少与终端深度融合的主机管理能力。

**MonoShell 针对上述问题给出了彻底的解法：**
- **自研内置 Shell**：不依赖系统的 cmd / powershell / bash，在 Windows 上也能开箱使用标准的 `ls`、`cat`、`grep`、`find`、`du` 等 30+ 核心命令，统一各平台运维操作；
- **真正的单窗口沉浸体验**：AI 思考以终端淡色注释行呈现，执行的命令以 `$ <cmd>` 像手工敲击一样就地留痕；
- **规则 + 模型双层安全门禁**：高危正则黑名单与只读白名单组合把关，行内提供 `y`（执行）、`N`（取消）、`e`（现场编辑后执行）交互，随时支持 `Ctrl+C` 熔断；
- **专为 Linux 打造的 SSH 库**：内置主机别名系统，私钥认证优先，远端自动适配与输入回显去重；
- **启动即选连接**：`ai` 不再默认钻进本地 shell，而是先摆出「本地 + 全部已保存远程主机」让你挑，确认连接信息无误后才打开提示符——远程是主角，本地只是一个待确认的默认项。

---

## 交互流演示

```text
$ ai
# ↑ 1. 启动后先选连接：远程主机是主角，本地只是列表里的一个默认项

MonoShell 单窗口 AI 运维终端
先选连接，确认之后再进 shell。远程主机的命令与 AI 都在远端执行。

选择要连接的终端

  [0]  本地终端              whh@node1 · 内置 shell                        —
  [1]  prod-web-01           ubuntu@172.16.1.86:22                        私钥 # 生产 web-01
  [2]  node2                 root@172.16.1.82:22                          密码(已保存)

  a 新增远程主机    d 删除远程主机    q 退出
选择 > 1

  prod-web-01
    地址      ubuntu@172.16.1.86:22
    认证      私钥 ~/.ssh/id_rsa
    备注      生产 web-01
    命令与 AI 均在远端主机上执行
  连接? [Y/n] y
已连接 prod-web-01 (ubuntu@172.16.1.86)
# ↑ 2. 确认连接之后才打开 shell 提示符；回车即采纳默认的 Y

ubuntu@prod-web-01 $ df -h
Filesystem      Size  Used Avail Use% Mounted on
/dev/vda1        40G   36G  1.8G  96% /
# ↑ 3. 手工敲的命令直接透传给远端，不走 AI、不额外包装

ubuntu@prod-web-01 $ ai 看看哪个目录最占空间
· 统计一级目录占用
$ du -h --max-depth=1 | sort -hr | head -n 20
1.2G    node_modules
14.2M   dist
1.1M    src
# ↑ 4. 说人话：AI 给出简明思考注释（· 统计一级目录占用），生成的命令同样在远端执行

ubuntu@prod-web-01 $ ai 把刚才构建的旧日志全清了
· 查找并清理旧日志文件

危险命令确认 (命中高危规则)
  rm -rf ./dist/*.log
  执行? y 是   N 否(默认)   e 改成别的   e
修改为: rm -i ./dist/*.log
$ rm -i ./dist/*.log
# ↑ 5. 拦截高危操作：命中规则即行内拦截，支持原地二次编辑后放行
```

---

## 核心特性

| 模块 | 核心能力 | 解决的问题 |
|---|---|---|
| **自研行编辑器 (`LineEditor`)** | 纯手写终端输入处理，支持历史记录 `↑`/`↓`、`Tab` 补全、光标移动及 Emacs 快捷键（`Ctrl+A/E/U/K/W/L`） | 摆脱宿主 shell 的 readline 限制，杜绝 PowerShell ANSI 回显污染 |
| **跨平台内置 Shell (`ShellEngine`)** | 内置 30+ 常见 Linux 运维命令（`ls`, `cat`, `grep`, `find`, `du`, `df` 等），支持管道 `\|`、重定向 `>` / `>>` / `<`、多语句 `&&` / `;`、Glob 通配符展开 | 在 Windows 上无缝使用 Linux 操作习惯，外部程序直接调用，不经系统 cmd 解释 |
| **配置引导 (`cli/setup`)** | 四段式向导（大模型 / 远程主机 / 启动方式 / AI 执行策略），内置 5 家服务商预设，显示当前值并可回车保留、`-` 清空，带连通性自测与改动清单；落盘前自动备份 `config.json.bak` | 不必手写 JSON 也能配起来；改配置不用重填全量，敏感值全程打码 |
| **连接选择器 (`cli/launcher`)** | 启动后列出内置的「本地」与全部已保存远程主机，支持按序号/别名/唯一前缀选择，就地增删主机；选中后展示连接详情并确认，确认通过才打开 shell | 远程主机是默认工作对象而非"绕路"，本地只是一个待确认的默认连接；连接在对之前就看得见 |
| **Linux SSH 连接库 (`session/ssh`)** | 交互式别名管理（`add`/`ls`/`rm`/`use`），支持私钥及口令认证，支持登录后自动执行 `startup` 脚本 | 免去频繁输入 IP 与凭据的烦恼，登录后自动配置 `stty -echo` 避免双重回显 |
| **ReAct AI 执行闭环 (`core/agent`)** | 接收自然语言目标 -> 规划单步命令 -> 安全检查 -> 执行并捕获标准输出与退出码 -> 回灌大模型决策 | 实现多步运维自主排查，AI 具备输出感知能力，支持最大步数限制与单步超时保护 |
| **双重安全防护 (`core/safety`)** | ① 规则层分档判定：AI 命令走 `full`（黑名单 + 写重定向），手敲命令走 `dangerous`（仅黑名单）；② 模型层不自我审查，风险交给用户裁决；终端行内确认（`y`/`N`/`e`）与原地改写 | 既不静默执行，也不静默拒绝 —— 高危动作一律停下来问你，日常操作不被打扰 |
| **流式标记擦除器 (`term/capture`)** | 生成唯一隔离标记（`__AIX_xxxx__`）精准截获子进程命令输出与退出码，内置流式 Scrubber 剔除多余标记 | 让 AI 发起的命令对用户呈现纯净的执行回显，终端不留乱码与隐藏字符 |

---

## 系统架构与原理

```mermaid
flowchart TD
    Launch["ai 启动（无参数）"] --> PickTarget{"连接选择 (cli/launcher)"}
    PickTarget -- "选中本地终端 + 确认" --> ShellRouter
    PickTarget -- "选中远程主机 + 确认" --> SSHStream
    PickTarget -- "q 退出" --> QuitLaunch["结束进程"]

    UserInput["用户终端输入 (LineEditor)"] --> TriggerJudge{"触发判定 (Classifier)"}
    
    TriggerJudge -- "命令输入 (ls / cd / 自定义可执行程序)" --> ShellRouter{"运行模式"}
    ShellRouter -- "本地环境" --> BuiltinOrSpawn["内置 Shell (ShellEngine) / 本地直接 spawn"]
    ShellRouter -- "SSH 远端" --> SSHStream["SSH 管道直传 (远端 Ubuntu Bash)"]
    
    TriggerJudge -- "自然语言 (前缀 ai / ? 或智能识别)" --> AgentLoop["ReAct AI 调度核心 (Agent)"]
    
    subgraph AI 闭环执行
        AgentLoop --> LLMPlan["LLM 规划当前步骤与单条命令"]
        LLMPlan --> SafetyCheck{"安全校验 (checkRisk)"}
        SafetyCheck -- "高危规则命中" --> TerminalConfirm["终端行内确认 (y/N/e)"]
        TerminalConfirm -- "放弃 (N)" --> AgentAbort["终止执行"]
        TerminalConfirm -- "修改 (e)" --> ReValidate["重新校验并执行"]
        TerminalConfirm -- "确认 (y)" --> ExecCaptured
        SafetyCheck -- "安全/只读放行" --> ExecCaptured["捕获执行 (captureExec)"]
        ReValidate --> ExecCaptured
        ExecCaptured --> CaptureScrub["标记注入与流式回显擦除 (Scrubber)"]
        CaptureScrub --> Feedback["将 stdout / stderr / exitCode 回灌 LLM"]
        Feedback --> ReActDecide{"是否达成目标 (done)?"}
        ReActDecide -- "否，继续探索" --> AgentLoop
        ReActDecide -- "是" --> FinalNote["输出最终结论，恢复提示符"]
    end
```

### 关键技术实现要点

1. **为什么在 Windows 上自研 Shell 而不用 PowerShell？**  
   - PowerShell 的 `PSReadLine` 会在输入与回显中主动注入复杂的 ANSI 转义序列，流式解析时极易破损；
   - 远程执行注入脚本时，PowerShell 将 `\n` 视为多行续行符（触发 `>>` 悬挂等待），Windows 下必须严格发送 `\r`；
   - `$LASTEXITCODE` 仅对外部原生进程有效，PowerShell 内置 cmdlet 执行失败时为 `$null`，导致退出状态失真。本项目自研 Shell 彻底抹平了底层操作系统的差异。
2. **命令输出精准捕获与擦除机制**：  
   AI 执行命令时，程序会自动组装包裹标记（如 `; echo "__AIX_xxx__:$?"`）。输出流经过专门实现的 `Scrubber` 状态机，根据特征正则剔除回显残留行和标记行，同时在流结束时 flush 缓冲区，确保最终显示既干净又完整。

---

## 安装与运行

### 环境准备
- [Node.js](https://nodejs.org/) `>= 18.0.0`
- `npm` 或 `pnpm`

### 安装步骤

```bash
# 1. 克隆代码库
git clone <repository-url>
cd monoshell

# 2. 安装项目依赖
npm install

# 3. 编译 TypeScript 代码
npm run build

# 4. 建立全局命令软链（推荐）
npm link
```

全局链接完成后，即可在任何终端目录下直接执行 `ai`。

### 免安装直接运行（开发调试）

```bash
npx tsx src/index.ts
```

---

## 配置说明

### 配置文件位置

运行 `ai` 或执行 `ai ssh init` 时，会在当前用户根目录下自动创建配置文件：
- **路径**：`~/.ai-shell/config.json`
- **安全属性**：自动尝试设置文件权限为 `600`（仅当前用户可读写），避免凭据泄露。
- **备份**：每次写盘前会把原文件复制为同目录下的 `config.json.bak`，改错可直接回退。
- **不想手写 JSON**：直接运行 `ai setup` 走问答式配置引导，详见[配置引导（推荐）](#配置引导推荐)。

### 完整配置示例

```jsonc
{
  "agent": {
    // 单次任务最多迭代轮数：AI「规划 → 执行 → 看输出 → 再规划」的上限
    "maxRounds": 5,
    // 单轮模型调用失败后的额外重试次数（0 = 不重试），网络抖动 / 限流靠它兜
    "retries": 2,
    // 单轮模型调用超时（毫秒）
    "timeoutMs": 50000
  },
  "startup": {
    // picker（默认）：启动后先选连接（本地 + 已保存的远程主机），确认后再进 shell
    // local：跳过选择，直接进本地内置 shell（旧行为）
    "mode": "picker",
    // 某次会话结束后是否回到连接选择界面
    "returnToPicker": true
  },
  "llm": {
    "name": "openai",
    "apiKey": "sk-your-api-key-here",
    "baseURL": "https://api.openai.com/v1",
    // 分类使用小模型（追求速度，默认 gpt-4o-mini）
    "classifyModel": "gpt-4o-mini",
    // 决策与命令生成使用大模型（追求准确度，默认 gpt-4o）
    "chatModel": "gpt-4o"
  },
  "shell": {
    "program": "", // 留空将自动探测：Windows 优先 pwsh/powershell/cmd，Unix 默认 /bin/bash
    "args": [],
    "env": {}
  },
  "ssh": {
    "hosts": [] // 保存的主机配置列表，推荐使用 ai ssh add 交互式写入
  },
  "trigger": {
    // 触发模式: "prefix" (默认) | "smart" | "hybrid"
    "mode": "prefix",
    // 触发前缀列表，大小写不敏感
    "prefixes": ["ai ", "ai:", "?", "？"],
    // 当手敲命令报错未找到 (command not found) 时，是否自动由 AI 接管处理
    "fallbackOnNotFound": true
  },
  "safety": {
    // 危险命令正则表达式拦截库
    "dangerous": [
      "\\brm\\s+(-[a-zA-Z]*f[a-zA-Z]*|-rf)\\b",
      "\\bmkfs\\b",
      "\\bdd\\s+if=",
      "\\bshutdown\\b",
      "\\breboot\\b",
      "\\bgit\\s+push\\s+.*(-f|--force)\\b",
      "\\bsystemctl\\s+(stop|disable|restart)\\b"
    ],
    // 只读白名单正则（直接放行）
    "allowlist": [
      "^\\s*(ls|ll|la|pwd|cd|cat|head|tail|less|more|echo|which|whoami|date|uname|hostname)\\b",
      "^\\s*(df|du|free|uptime|top|htop|ps|netstat|ss|ip|ifconfig|ping|curl|wget)\\b",
      "^\\s*(git\\s+(status|log|diff|branch|show|remote)\\b)"
    ],
    // 分类判定超时时间（毫秒）
    "classifyTimeoutMs": 800,
    // 防抖预取判定延时（毫秒）
    "prefetchDebounceMs": 400,
    // 用户手敲的危险命令是否也要二次确认（AI 生成的命令无论如何都会确认）。
    // 手敲时只按上面的高危黑名单判定，不会因为 `echo x > f` 这类日常写文件而打扰。
    "confirmManual": true
  },
  "ui": {
    // AI 思考注释前缀符号
    "notePrefix": "· ",
    // 命令模拟打字回显延迟（毫秒）
    "typeSpeedMs": 18
  }
}
```

### 主流大模型接入指南

`MonoShell` 采用标准 OpenAI 兼容 SDK，可灵活切换各家模型服务商：

#### 1. DeepSeek
```json
"llm": {
  "name": "deepseek",
  "apiKey": "sk-xxxxxx",
  "baseURL": "https://api.deepseek.com/v1",
  "classifyModel": "deepseek-chat",
  "chatModel": "deepseek-chat"
}
```

#### 2. 阿里云通义千问 (Qwen)
```json
"llm": {
  "name": "qwen",
  "apiKey": "sk-xxxxxx",
  "baseURL": "https://dashscope.aliyuncs.com/compatible-mode/v1",
  "classifyModel": "qwen-turbo",
  "chatModel": "qwen-plus"
}
```

#### 3. 本地 Ollama
```json
"llm": {
  "name": "ollama",
  "apiKey": "ollama",
  "baseURL": "http://localhost:11434/v1",
  "classifyModel": "qwen2.5:7b",
  "chatModel": "qwen2.5:14b"
}
```

---

## 使用手册

### CLI 命令速查

```bash
ai                     # 启动：先选择连接（本地 / 远程主机），确认后再进 shell
ai --local             # 跳过选择，直接进入本地内置 shell
ai --ssh <别名>        # 跳过选择，直接连接已保存的 Ubuntu 远程主机
ai setup               # 交互式配置引导（大模型 / 远程主机 / 启动方式）
ai ssh ls              # 列出已保存的所有远程连接
ai ssh add             # 交互式添加主机连接配置
ai ssh rm <别名>       # 删除指定主机连接
ai ssh use <别名>      # 连接已保存的主机
ai ssh init            # 生成默认配置文件
ai config example      # 生成一份可直接手动替换的配置模板
ai ssh path            # 输出配置文件的本地绝对路径
ai -h, --help          # 查看帮助说明
```

### 配置引导（推荐）

不用手写 JSON。没配好之前，选择界面会自己把缺的东西点出来，并给出入口：

```text
选择要连接的终端

  [0]  本地终端              whh@node1 · 内置 shell                        —
  [1]  prod-web-01           ubuntu@172.16.1.86:22                        私钥 # 生产 web-01

⚠ 还没配置：大模型 API Key（AI 说人话的功能）、远程主机（要连服务器才需要）
  按 c 进入配置引导（一步步问，回车保留原值），也可以随时运行 ai setup
  a 新增远程主机    d 删除远程主机    c 配置引导    q 退出
```

三种进入方式：选择界面按 `c`、命令行 `ai setup`、或 `ai config`（生成默认配置后会问你要不要接着配）。

向导分四段（大模型 / 远程主机 / 启动方式 / AI 执行策略），**每一问都显示当前值，回车即保留**，所以「改一处」不需要重填全部：

```text
MonoShell 配置引导
回车 = 保留当前值并跳到下一项；输入 - 可清空某项；整段直接回车 = 跳过。

当前状态 (C:\Users\whh\.ai-shell\config.json)
  大模型    🔴 未配置  （AI 说人话的功能不可用，只当 shell 用没问题）
  远程主机  🟢 1 台  56(wyzd@172.18.201.56)
  启动方式  先选连接 · 会话结束回到列表

第 1 段 / 3 · 大模型
  [1] DeepSeek（推荐，国内直连）
  [2] 阿里云通义千问 Qwen
  [3] OpenAI
  [4] 本地 Ollama
  [5] 自定义 / 其它 OpenAI 兼容服务
  选择服务商 [1-5，回车跳过这一段，保持当前 openai]: 1
  接口地址 baseURL [当前 https://api.deepseek.com/v1，回车保留]:
  sk- 开头，在 platform.deepseek.com 获取
  API Key [当前 (空)，回车保留，输入 - 清空]:
  判定用小模型（求快） [当前 deepseek-chat，回车保留]:
  生成用大模型（求准） [当前 deepseek-chat，回车保留]:
  现在测一下能不能连通? [Y/n]:
  ✓ 连通正常 模型返回：可用
...
完成
  写回 C:\Users\whh\.ai-shell\config.json（原文件已备份为 config.json.bak）
  · llm.apiKey: (空) → sk-tes****1234
  · llm.chatModel: gpt-4o → deepseek-chat
```

几条约定：

- **换服务商会带上预设**（baseURL / 模型名自动切过去）；同服务商重进则保留你自己改过的值。
- **`-` 清空**：想临时禁用 AI，把 apiKey 填 `-` 即可，其余配置不动。
- **连通性自测是可选的**：答 `Y` 会真的发一次最小请求验证，失败也会照样保存配置，不阻塞。
- **落盘前自动备份**：现有 `config.json` 会先复制为 `config.json.bak`，改错了能直接回退。
- **敏感值打码**：回显里 key 只露头尾（`sk-tes****1234`），模板文件里也不写明文。

如果更习惯手改，用 `ai config example` 生成一份带当前全部字段的模板，改完覆盖回去即可（覆盖时会自动备份）。两条路殊途同归。

### 启动：选择连接

MonoShell 面向的日常场景是**远程主机运维**，所以裸敲 `ai` 不会闷头进本地 shell，而是先让你挑连接、确认无误之后再打开 shell 提示符。本地视为列表里一个内置的默认连接（编号 `0`），同样要过一遍确认。

```text
选择要连接的终端

  [0]  本地终端              whh@node1 · 内置 shell                        —
  [1]  prod-web-01           ubuntu@172.16.1.86:22                        私钥 # 生产 web-01
  [2]  node2                 root@172.16.1.82:22                          密码(已保存)

  a 新增远程主机    d 删除远程主机    q 退出
选择 >
```

| 输入 | 行为 |
|---|---|
| 直接回车 / `0` / `local` | 选中本地终端（随后仍需确认） |
| `1`~`n` | 按序号选中对应远程主机 |
| 主机别名或唯一前缀 | 例如 `prod` 匹配 `prod-web-01`；前缀有歧义时拒绝并重新询问 |
| `a` | 就地新增远程主机（等价于 `ai ssh add`），完成后刷新列表 |
| `d` | 删除远程主机（会再确认一次） |
| `c` | 进入配置引导（等价于 `ai setup`），完成后刷新 |
| `q` | 退出 |

选中后先出确认卡片（本地显示工作目录/平台，远程显示地址/认证方式/备注与 startup 命令），回车即采纳默认的 `Y`；回答 `n` 则取消并退回列表。

几点约定：

- **非交互场景自动兜底**：stdin 不是 TTY（管道、脚本、CI）时无法选择，会直接进入本地 shell，保持可脚本化；要显式指定用 `ai --local`。
- **会话结束后回到列表**：某次会话退出后默认回到连接选择，方便接着连下一台。把 `startup.returnToPicker` 设为 `false`，或改用 `ai --local` / `ai --ssh <别名>`，即退出即结束。
- **远端断开不再卡死**：远程主机上敲 `exit` 或网络掉线时，会提示「远端连接已关闭」并把控制权交回上层，而不是傻等输入。
- **想恢复旧行为**：把配置里的 `startup.mode` 设为 `"local"`，裸敲 `ai` 就等同于 `ai --local`。

### 本地 Shell 与快捷键

进入 `ai` 后，终端将呈现 Linux 风格统一提示符（如 `~/projects $ `）。

#### 行编辑常用快捷键

| 快捷键 | 功能说明 |
|---|---|
| `Tab` | 自动补全命令名（内置命令 + 系统 PATH）或本地文件路径 |
| `↑` / `↓` | 在历史命令记录中前翻 / 后翻 |
| `Ctrl + A` / `Home` | 光标快速跳至行首 |
| `Ctrl + E` / `End` | 光标快速跳至行尾 |
| `Ctrl + U` | 清除光标前至行首的全部字符 |
| `Ctrl + K` | 剪切/清除光标后至行尾的全部字符 |
| `Ctrl + W` | 向前删除一个词 |
| `Ctrl + L` | 清空当前屏幕输出（保留当前行输入） |
| `Ctrl + C` | 取消当前行输入 / 中断正在运行的任务 |
| `Ctrl + D` | 输入为空时退出当前终端（等同于输入 `exit`） |

### SSH 远程主机管理

针对 Ubuntu / Linux 生产服务器运维设计，交互式管理连接库：

```bash
$ ai ssh add
别名 (如 prod-web-01): staging-node
主机 IP / 域名: 192.168.1.100
端口 [22]: 22
用户名: ubuntu
认证方式: [1] 私钥 (推荐)  [2] 密码  : 1
私钥路径 [C:\Users\username\.ssh\id_rsa]: ~/.ssh/id_rsa
私钥口令 (没有则直接回车): 
登录后自动执行的命令 (可选，多条用 ; 分隔): cd /data/logs; sudo su -
备注 (可选): 测试集群网关节点
已保存：staging-node -> ubuntu@192.168.1.100
```

- **连接**：裸敲 `ai` 会进入[连接选择](#启动选择连接)界面，主机直接从列表里挑；要跳过选择可用 `ai --ssh staging-node` 直连。
- **回显优化**：连接建立后，后台自动执行 `stty -echo`，彻底交由本地 `LineEditor` 统一渲染，消除网络延迟抖动导致的按键卡顿与重复字符。

### AI 触发与 ReAct 闭环

支持三种触发判定模式（在 `trigger.mode` 中配置）：

1. **`prefix`（默认推荐）**：
   - 必须以 `ai `、`ai:`、`?` 或 `？` 开头才会调动模型。
   - 其余输入 100% 当作 Shell 命令本地立即执行，保证**零延迟、零网络请求、零误判**。
2. **`smart`（智能模式）**：
   - 本地启发式规则快判（中文字符特征、命令词字典、PATH 缓存）；
   - 用户敲键盘停顿间隙进行**投机预取（Prefetch）**，回车时优先命中判定缓存；
   - 拿不准时调用轻量 LLM 进行判定。
3. **`hybrid`（混合模式）**：
   - 显式前缀必定触发，非前缀行若被判定为提问意图亦可触发。
4. **`fallbackOnNotFound`（报错自动兜底）**：
   - 当用户不带前缀误把自然语言当命令直接回车（如输入 `查一下昨天的大日志`），系统收到 `command not found` 或类似系统报错后，会自动提示 `这句不像命令，交给 AI 试试` 并无缝接管执行。

### AI 执行策略（轮数 / 重试）

AI 排查问题是「规划 → 执行 → 看输出 → 再规划」的闭环，节奏由 `agent` 段的三个数字控制：

| 配置 | 默认 | 说明 |
|---|---|---|
| `agent.maxRounds` | `5` | 单次任务的**迭代轮数上限**。轮数越多越能自己把问题排完，也越费 token；调大到 10 适合复杂排查，调到 1~2 则只想要它给一条命令。 |
| `agent.retries` | `2` | 单轮模型调用**失败后的额外重试次数**（0 = 只试一次）。网络抖动、限流、超时都会自动重试，重试时打印提示。 |
| `agent.timeoutMs` | `50000` | 单轮调用超时（毫秒），超时按失败处理并进入重试。 |

- 重试与超时只作用于**单轮调用**，不会让整轮迭代卡死：用完重试次数就放弃本轮并说明原因。
- 为让次数可预期，SDK 自带的重试已关闭（`maxRetries: 0`），实际尝试次数就是 `1 + retries`。
- 也可以在配置引导（`ai setup` 第 4 段）里直接改，回车保留原值。
- 老配置里的 `safety.maxRounds` 仍会被读取（未配 `agent.maxRounds` 时作为回退），无需手动迁移。

### 需要密码的命令（sudo / su 等）

AI 走的是**捕获通道**，拿不到终端，所以 `sudo`、`su`、`passwd`、`mysql -p` 这类命令
**无法代你输入密码**。如果放任它跑，就会卡在密码提示上等超时，然后模型还会换着法儿再试
几种 sudo 变体，几轮下来什么都没查到 —— 所以这类命令会在**执行前**就被拦下来问你：

```text
这条命令需要你手动输入密码 (sudo 需要你的登录密码，AI 不能代你输入)
  sudo ufw status verbose
  AI 拿不到终端，代不了你输密码。直接在本会话里手敲上面这条即可，密码提示出来时自己输入。
  想让它以后能自动跑：给该用户配 NOPASSWD（sudo visudo 加一行 `用户名 ALL=(ALL) NOPASSWD:ALL`）。
  还是要让 AI 试一次? y 试(可能卡住)   N 跳过(默认)   e 改成免密写法   
```

- **默认 `N` 跳过**，并就此收尾 —— 不会让模型继续瞎试，轮数不会被烧光。
- 要查这类信息，**直接在本会话里手敲**那条命令即可：手敲的命令是原样透传给远端的，
  密码提示会正常出现，你自己输入就行。
- 按 `y` 可以让它试一次，但会用**短超时（8s）**而不是 30s，卡住会立刻中断。
- 即使 AI 没预判到（模型没写 sudo，但命令照样弹了密码提示），捕获器也会**嗅到提示立即中断**，
  并把命令原样回显出来让你照着手敲，不会让你干等，也不会再往下试。
- 识别范围（执行前预判）：`sudo`（不含 `sudo -n` / `sudo -S`）、`su`、`passwd`、`ssh-add`、
  `ssh-keygen`、`mysql -p`、`psql -W`、`read -s`。`sudo -S` 这类会读 stdin 的写法属于故意
  绕开提示，落在上面那条**运行时嗅探**兜底里，效果一样是立刻中断。

> 想彻底免去这一步，就给运维账号配 NOPASSWD —— 工具这边不用改任何配置。

### 高危命令二次确认机制

**AI 不会替你拒绝任何命令。** 提示词明确要求模型不要自我审查、不要因为「看起来危险」就绕道或改用替代方案 ——
它的职责是给出最直接的那条命令并讲清后果，风险由你判断：

```text
危险命令确认 (命中高危规则)
  rm -rf ./dist/*.log
  这条命令会真的执行，由你决定：y 执行   N 取消(默认)   e 改成别的   
```

- 按 `y` / `Y`：放行并执行；
- 按 `n` / `N` / `Enter`：取消，并终止当前 AI 流程；
- 按 `e` / `E`：进入**就地编辑模式**，允许将命令改为 `rm -i ./dist/*.log` 后再安全执行；
- 随时按 `Ctrl+C`：立即强制熔断退出。

确认分两档判定，避免「要么太松、要么处处打扰」：

| 来源 | 档位 | 拦什么 |
|---|---|---|
| **AI 生成的命令** | `full` | 高危黑名单 + 写文件重定向（`>` / `>>`，`> /dev/null` 除外） |
| **你手敲的命令** | `dangerous` | **只**看高危黑名单 |

所以手敲 `echo hi > out.txt` 不会被打断，但手敲 `rm -rf`、`systemctl stop nginx`、`mkfs`、`dd if=`、`git push -f` 这类会先确认一次。手敲确认由 `safety.confirmManual` 控制（默认开启；SSH 会话与非交互的管道/脚本输入不拦）。

一句话：命中即**询问**，既不静默执行，也不静默拒绝 —— 决定权始终在你手上。

---

## 实战运维场景

### 场景 1：排查磁盘膨胀原因
```bash
$ ai 看看磁盘空间，找出一级目录里最大的 5 个
· 检查磁盘整体用量并列出大目录
$ df -h
Filesystem      Size  Used Avail Use% Mounted on
/dev/vda1        40G   36G  1.8G  96% /
· 统计一级子目录空间排序
$ du -h --max-depth=1 / | sort -hr | head -n 6
36G     /
24G     /var
8.2G    /data
2.1G    /usr
1.1G    /home
· /var 目录占用过高，主要分布在日志与容器缓存
```

### 场景 2：检索分析异常日志
```bash
$ ai 统计当前目录下最近 1000 条日志里的 500 错误状态码数量
· 检索并统计 access.log 中的 500 状态码
$ tail -n 1000 access.log | grep -c "HTTP/1.1\" 500"
42
· 发现 42 条 500 错误日志
```

### 场景 3：端口与服务排查
```bash
$ ai 8080 端口被谁占了？把它的进程详情找出来
· 查询占用 8080 端口的进程
$ netstat -tlpn | grep :8080
tcp        0      0 0.0.0.0:8080            0.0.0.0:*               LISTEN      14285/node
· 查看进程 14285 详细信息
$ ps -fp 14285
UID          PID    PPID  C STIME TTY          TIME CMD
www-data   14285    1200  0 10:20 ?        00:00:15 /usr/bin/node /app/server.js
· 端口 8080 由 PID 为 14285 的 node 服务占用
```

---

## 内置命令支持列表

内置 Shell 在 Windows / Linux / macOS 下提供一致的类 Unix 行为，支持以下内置指令及常见参数：

| 命令 | 支持的主要选项与行为 |
|---|---|
| `ls` | `-l` 详细长列表模式（显示权限、大小、修改时间），`-a` 显示隐藏文件 |
| `cd` | 目录切换，支持 `~` 用户主目录展开，支持绝对与相对路径 |
| `pwd` | 输出当前工作绝对路径 |
| `cat` | 支持读取多个文件拼接输出，无参数时读取标准输入 `stdin` |
| `head` | `-n <行数>` 输出前 N 行（默认 10 行），支持管道与文件输入 |
| `tail` | `-n <行数>` 输出尾部 N 行（默认 10 行），支持管道与文件输入 |
| `wc` | `-l` 行数统计，输出行数、词数、字节数 |
| `grep` | `-i` 忽略大小写，`-n` 显示行号，`-v` 反向匹配，支持正则表达式 |
| `find` | `-name <通配符>` 名称匹配，`-type [f\|d]` 文件/目录类型筛选，`-maxdepth <深度>` 限制检索层级 |
| `du` | `-s` 汇总统计，`-h` 人类可读体积显示（K/M/G），`--max-depth=<N>` 统计层级深度 |
| `df` | 磁盘分区占用与剩余空间容量统计 |
| `stat` | 打印文件/目录大小、访问权限掩码、最后修改时间等元数据 |
| `mkdir` | `-p` 递归级联创建多级目录 |
| `rmdir` | 删除指定空目录 |
| `touch` | 创建新空文件或刷新已有文件修改时间 |
| `rm` | `-r` 递归删除目录，`-f` 强制删除不存在的文件时不报错 |
| `cp` | 文件拷贝复制 |
| `mv` | 文件/目录重命名或移动 |
| `echo` | 终端字符输出，支持管道与引号去义 |
| `env` / `export` / `unset` | 环境变量查看、注入设置与移除销毁 |
| `which` | 检索指定可执行命令所在的系统绝对物理路径 |
| `whoami` | 输出当前运行身份用户名 |
| `date` | 输出当前标准系统时间 |
| `uname` | `-a` 输出底层操作系统类型、架构与主机名 |
| `sleep` | 延时休眠（秒） |
| `history` | 查阅当前会话的历史敲击命令索引列表 |
| `alias` / `unalias` | 别名创建与移除 |
| `clear` | 终端全屏清空刷新 |
| `exit` | 退出当前运行会话 |

> **注**：对于未内置的命令（如 `git`, `docker`, `npm`, `curl`, `python` 等），`ShellEngine` 会自动在系统 `PATH` 路径中搜寻并直接以子进程 `spawn` 执行。

---

## 项目目录结构

```text
MonoShell/
├── src/
│   ├── index.ts          # 程序 CLI 主入口与 REPL 调度循环
│   ├── config.ts         # 配置加载、默认值初始化与安全规则定义
│   ├── cli/
│   │   ├── setup.ts      # 交互式配置引导（大模型 / 远程主机 / 启动方式）
│   │   ├── launcher.ts   # 启动连接选择器（本地 / 远程主机 + 连接确认）
│   │   └── hosts.ts      # SSH 远程主机增删改查交互式管理
│   ├── core/
│   │   ├── agent.ts      # ReAct Agent 调度器与多轮反思机制
│   │   ├── classifier.ts # 自然语言 vs 命令判定器与投机预取
│   │   ├── llm.ts        # OpenAI 兼容客户端适配层
│   │   ├── prompt.ts     # 系统提示词与多步历史块组装
│   │   └── safety.ts     # 规则层危险正则库与白名单校验
│   ├── session/
│   │   ├── types.ts      # 终端会话抽象接口定义
│   │   ├── local.ts      # 本地终端会话封装 (node:child_process)
│   │   └── ssh.ts        # SSH2 远程通道与自动配置
│   ├── shell/
│   │   ├── line.ts       # 自研终端行编辑器 (输入回显/光标/Tab补全/快捷键)
│   │   ├── parser.ts     # 轻量 POSIX 语法解析器 (引号/管道/重定向/&&/;)
│   │   └── builtin.ts    # 30+ 跨平台类 Unix 内置命令实现
│   │   └── engine.ts     # 内置 Shell 执行调度引擎
│   └── term/
│       ├── capture.ts    # 命令输出捕获包装器与流式 Scrubber 擦除器
│       └── ui.ts         # 终端行内确认、警示与注释行 UI 渲染
├── test/
│   ├── shell.ts          # 内置 Shell 核心命令与语法冒烟测试集
│   ├── launcher.ts       # 连接选择器（脚本化假输入驱动，无需真终端）
│   ├── setup.ts          # 配置引导（dryRun 运行，不碰真实配置文件）
│   ├── agent.ts          # AI 策略 / 重试 / 危险命令分级判定
│   └── smoke.ts          # PTY 进程透传与输出截获端到端测试集
├── package.json
└── tsconfig.json
```

---

## 已知限制与设计权衡

1. **全屏交互式程序支持**：
   - 在**本地内置 Shell** 模式下，目前不支持 `vim`、`nano`、`htop` 等需要复杂 curses / 全屏重绘的交互式程序；
   - 在 **SSH 远程模式** 下，底层为原生 Linux 终端流，可正常使用全部全屏程序。
2. **作业控制 (Job Control)**：
   - 内置 Shell 暂不支持复杂的作业控制操作（如 `Ctrl+Z` 挂起后台、`fg`/`bg` 唤醒）。
3. **变量展开限制**：
   - 暂不支持复杂的 Shell Script 语法（如 `for i in ...; do` 语法块或 `${VAR:-default}` 复杂参数展开），建议复杂脚本直接写入 `.sh` 文件后执行。

---

## 本地开发与测试

```bash
# 编译 TypeScript 产物
npm run build

# 运行内置 Shell 功能测试
cmd /c npx tsx test/shell.ts

# 运行连接选择器测试（脚本化输入，不需要真终端）
npm run test:launcher

# 运行配置引导测试（dryRun，不会改动真实配置文件）
npm run test:setup

# 运行 AI 执行策略测试（轮数 / 重试 / 危险命令分级判定）
npm run test:agent

# 运行 PTY 冒烟捕获测试
cmd /c npx tsx test/smoke.ts
```

---

## 许可证

本项目基于 [MIT 许可证](LICENSE) 开源。
