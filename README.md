# 潮汐记忆 · dsh-tide-memory

[![DSH Plugin Hub](https://img.shields.io/badge/DSH-Plugin%20Hub-1f6feb)](https://dsh-plugin.org/)
[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)
[![dsh](https://img.shields.io/badge/dsh-%3E%3D0.1.7--rc.1-blue)](https://www.deepseek.com/harness/)

给 DeepSeek Harness 里的会话一份**会淡忘、会过时、看得见**的长期记忆。

别人的记忆插件多数是「存下来 + 全塞回去」；潮汐记忆的取舍是：
**证据够不够决定它进不进上下文，鲜活度只决定它排多前。**

## 它解决的三个具体问题

1. **忘了该记的** —— 跨会话之后，你上次交代的边界、偏好、约定全没了。
2. **记得太多反而更笨** —— 把一摞旧事全塞进提示词，模型开始在不相关的地方乱套用。
3. **记忆是个黑盒** —— 你不知道它为什么想起那一条，也没法纠正。

## 三条设计取舍（跟别家不一样的地方）

| 取舍 | 潮汐记忆 | 常见做法 | 为什么 |
| --- | --- | --- | --- |
| 进不进 | 证据分 C = s/(s+2)，低于阈值（默认 0.35）**根本不进** | 按相似度 top-k 全塞 | top-k 总会给你 k 条，哪怕一条都不相关 |
| 淡忘 | 事件半衰期 30 天，带情绪 7 天，**事实类永不衰减** | 无衰减 / 全部按时间排 | 情绪浓的事该记得更久，画像和约定不该淡 |
| 过时 | 标 supersededBy，新旧都留，可回看 | 直接覆盖或删除 | 「他以前住哪」也是信息，删了就没了 |

再加一条工程上的：**没有 900KB 的用户词典**。分词靠二元组 + 单字（二元组权重 1、单字 0.5），
idf 用记忆库自己的 df 现算。少一份词典，换个领域也不会水土不服。

## 装上

从 npm（推荐）：

```bash
dsh plugin --profile desktop add dsh-tide-memory   # 桌面端
dsh plugin --profile web add dsh-tide-memory       # 命令行 web 端
# 装完重启一次 DSH，设置页里才会出现「潮汐记忆」
```

直接从 GitHub 装（想跟最新代码，或还没发 npm 的时候）：

```bash
dsh plugin --profile desktop add github:MingHuanYue/dsh-tide-memory
```

本地源码装：

```bash
dsh plugin --profile desktop add file:D:/path/to/dsh-tide-memory
```

## 用起来

**给它工具**（模型自己会调）：

- `tide_remember` —— 记一条：text / kind（event 或 fact）/ imp 0~1 / emo 0~1 / keys
- `tide_recall` —— 按线索找：query / limit
- `tide_forget` —— 标过时（不是删）
- `tide_stats` —— 库里现在多少条、多少还活着

**给人看的界面**：`设置 → 潮汐记忆`

- 记忆库下拉：每个工作区一个库，显示条数和最近一条的时间
- 手动记一条：选「事件／事实」和重要度
- 搜索 + 过滤：还在的／事实／事件／钉住的／已过时／全部
- 每条卡片：类型、鲜活度百分比与色条、被想起次数，按钮有 **钉住 / 改 / 标过时 / 删**
- **看它怎么想起来的**：最近几轮注入的 trace，每条的 C（证据）、P（排序分）、act（鲜活度）
- 设置区：开关、事件半衰期、情绪半衰期、每轮最多几条、证据阈值、字数上限

## 记忆存在哪

```
$DSH_HOME/tide-memory/
├── config.json          # 全局设置
├── trace.jsonl          # 注入日志（「怎么想起来的」）
├── stores/<key>.jsonl   # 每个库一行一条
└── cold/<key>.jsonl     # 冷宫：淡到快没了又没被想起的（没删，能翻回来）
```

一行长这样：

```json
{"id":"ly3k9x","t":1761215000000,"last":1761215000000,"kind":"fact",
 "text":"主人不喜欢别人替他做决定，什么事都要先问一句",
 "keys":["决定","边界"],"imp":1,"emo":0.5,"hits":3,"pinned":false,"supersededBy":null}
```

纯 JSONL，随手 grep 就能翻，也能自己写脚本搬进搬出。

## 打分怎么算的

```
act = kind 是 fact ? 1 : 0.5 ^ (天数 / 半衰期)
C   = s / (s + 2)          // s = 命中词的 idf × 词权重 之和
P   = C × (0.55 + 0.25·act + 0.15·imp + 0.05·emo)
```

- C 低于阈值 → 不进上下文（默认 0.35：一条明确命中就过半，两条更稳）
- 进的那几条按 P 排序，最多 6 条 / 800 字
- act 低于 0.05 且从未被想起的事件 → 挪进冷宫

调阈值是这套东西最有效的一个旋钮：觉得它乱想起来就调高，觉得它太健忘就调低。

## 排障

**装完起不来**：先看 profile 的 package.json 有没有被工具写成带 BOM 的 UTF-8。

```powershell
$p = 'D:\nodejs-data\dsh-home\profiles\desktop\package.json'
[System.IO.File]::WriteAllText($p, [System.IO.File]::ReadAllText($p), (New-Object System.Text.UTF8Encoding($false)))
```

**设置页没出现「潮汐记忆」**：重启 DSH；还没出现就 `dsh --profile desktop --dump-config` 看 bundle 名单里有没有 dsh-tide-memory。

**从 GitHub 装报 exit code 128**：pnpm 把 github: 解析成 SSH 了。

```bash
git config --global url."https://github.com/".insteadOf "git+ssh://git@github.com/"
```

## 权限与隐私

- 只读写 `$DSH_HOME/tide-memory/` 下的自己的 JSONL 文件，不碰别的目录。
- **不联网**：没有云端、没有 embedding 服务、没有 key。分词和检索全在本地算，一次几十毫秒。
- 记忆只有两个来源：模型主动调 `tide_remember`，或者你在设置页手动记一条。
- 每轮注入了哪几句，会同时写进 `trace.jsonl`，设置页里能直接看（C / P / act 三个数）。
- 想清空：删掉 `stores/` 下对应的 `*.jsonl`，或者在设置页逐条删。卸载插件不会删数据，重装还在。

## 兼容性

- DSH >= 0.1.7-rc.1（见 `package.json` 的 `engines.dsh`），Node >= 22。
- 图形界面挂在设置页，桌面端和 web 端都能用（client 走 `dsh.client` 声明，platform: web）。
- 记忆库按**工作区**分桶：同一个工作目录下的会话共用一个库，换项目不串味。
- 已知显示层小瑕疵：设置页的库下拉里偶尔会出现一行 `ws-xxx__` 的重复名，
  那是文件名把中文折成了下划线（同一份数据），不影响读写，重启后按 `safeKey` 归并就没了。

## License

MIT
