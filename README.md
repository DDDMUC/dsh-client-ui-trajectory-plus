# dsh-client-ui-trajectory-plus

DeepSeek Harness 的第三个对话视图标签：**轨迹plus**（在「对话」和「轨迹」右边）。

它把"轮次"变成一等对象：**每一轮一张卡片，包括平台的轨迹视图画不出行的那一轮**，卡片上可以直接删除或重跑这一轮。卡片里**列出这一轮发生的每一步**（系统 / 用户 / 上下文 / 助手 / 工具 / 结果），顶上还有一条**三色泳道彩条**。

    ┌ ▍▍▍▍▍▍▍▍▍▍▍▍▍▍▍▍  ← 彩条：lane0 / lane1 / lane2，三条，每行一格，红 = 出错
    ┌ 加载更早 ────────────────────────────────┐   ← 只在 hasOlder 时出现，高 30px
    ┌ 第 4 轮 · 恢复 ─────────────────── 1 秒 ─┐
    │ ▍系统    You are an AI agent …           │
    │ ▍用户    我如何知道每个对话的目录和ID？ [图片 ×1] │
    │ ▍上下文  Current runtime context. …       │
    │ ▍助手    这个我直接给你一张表。…          │
    │ ▍结果    bash {"command":"ls -la"} →  …  │   ← 绿 = 工具跑成功，红 = 出错
    └──────────────────────────────────────────┘

## 三条设计要点

1. **每个轮次都渲染一张卡片，即使它是空的。** 平台的轨迹视图按"格子"建行，没有格子的轮次一行都没有，于是编号出现空洞。这一页从 `turn/start` / `turn/end` 括号（以及事件自带的 `data.turn`）建索引，所以一个轮次不可能静默消失。配置 `renderEveryTurn: false` 可以退回平台视图的行为（对照用）。

2. **卡片默认显示"当前状态"** —— 也就是 `surfaceOp: { op: 'replace' }` 折叠之后的结果。被折叠掉的历史以 `suppressed` / `replacedBy` 计数出现在"发生过什么"一行里，**并且按"是谁替换的"分开说**（见下）。

3. **卡片上直接挂操作** —— 删除 / 重跑 / 刷新。前两个**代理到已有插件的 HTTP 路由**（删除 → `POST /dsh-delete-turn/delete`，重跑 → `POST /dsh-rerun-turn/apply`）；这两个插件没装时，对应按钮**不出现**。

## 每轮明细：一轮里发生的每一步

**驱动这件事的真机对照**：官方轨迹把一轮画成一排 —— 系统 / 用户（图片 ×1）/ 上下文 / 上下文 / 助手 / 工具（命令 → 结果前几字）/ 助手。我们之前**每轮只有两行**（这一轮的第一条人类提问 + 最后一条助手回答），因为卡片只找那两条事件。现在卡片列出**这一轮的全部界面节点，按 seq 顺序**：

| 行 | 来源 | 例子 |
| --- | --- | --- |
| 系统 | `system/message` / `developer/message` | `You are an AI agent powered by DeepSeek Harness…` |
| 用户 | `user/message` 且 `source.kind` 是人类的（`user`，或没有 source） | `我如何知道每个对话的目录和ID？` |
| 上下文 | `user/message` 但**不是人写的、也不是模型写的** | `Current runtime context…`、`<system-reminder> A skill is…` |
| 助手 | `assistant/message` | `这个我直接给你一张表。…` |
| 工具结果 | `tool/result` | `bash {"command":"ls -la"} → node_modules package-lock.json` |
| 压缩 | 载体事件 `source.kind` 以 `compact` 开头 | 平台的上下文压缩 |

**分类只问一个问题是"谁写的"**，不是拿一张已知 kind 的表去查：

    人写的   -> user        模型写的 -> assistant        都不是 -> context

所以平台明天新增一种注入（`runtime-context` / `skill-catalog` / `model-selection` / 还没发明的），默认就落在 `context`，不需要改代码。`system` 是唯一例外：system 角色的行就叫系统，虽然按作者算它也是注入。

**工具行怎么来的**：结果节点上只有 call id，**没有工具名**，所以宿主用一张 `callId -> {name, arguments}` 的索引（从同一份日志的 `tool-call` 块里建一次）把它配上。摘要的取法也是量出来的：平台上 1191 次工具调用里 **0 次**有 `arguments.what`，**1185 次**有顶层 `description`（模型写给读者看的一句话，如 `List DSH home dir`）；所以顺序是 `what`（含嵌套 `{text}`）→ `description` → 嵌套 `command.description` → `url` → `command` → 原始参数 JSON。命名与参数摘要给 96 字符，结果预览给 260。

**非文字块是数出来的**，不是猜的：一行里除 text/reasoning 之外的块按类型（或附件的 mediaType）计数 → 官方的「图片 ×1」，assistant 行上的 `tool-call ×1`。

真机第 154 轮（`session-94db29c5`，窗口 `turns=50`，原样贴上，只截了 text 的长度）：

    {"seq":10663,"kind":"user","lane":0,"nonText":{"image/png":1},"text":"我如何知道每个对话的目录和ID？你的目录和ID是？","chars":25}
    {"seq":10664,"kind":"assistant","lane":1,"nonText":{"tool-call":1},"text":"这个我直接给你一张表。**先看布局**： …","chars":255}
    {"seq":10668,"kind":"tool-result","lane":2,"error":false,"tool":"run_code",
     "toolPreview":"run_code Map sidebar titles to session ids and directories",
     "text":"最近一次写入 事件数 会话 ID（去掉 session- 就是目录名） …","chars":1233,"truncated":true}
    {"seq":10671,"kind":"assistant","lane":1,"text":"## 布局：**每个对话 = 一个目录** …","chars":1840,"truncated":true}

**每一段都截断，且每段都带 `chars` 与 `truncated`**，所以读者能分清"这条本来就短"和"这条被切了"。配置项（都有默认值）：

| 选项 | 默认 | 管什么 |
| --- | --- | --- |
| `systemChars` | 320 | 系统提示词行的正文 |
| `userChars` | 320 | 人类消息行的正文 |
| `contextChars` | 260 | 平台注入行的正文 |
| `assistantRowChars` | 320 | 一条助手行的正文（一轮里可能有很多条） |
| `toolNameChars` | 96 | 工具名 + 参数摘要 |
| `toolResultChars` | 260 | 工具结果预览 |
| `rowBudgetChars` | 9000 | **每一轮**的明细总字符预算，超了从尾部丢行，卡片上明说"后面的 N 行没有列出" |
| `charLimit` | 4000 | **任何一行**的硬上限，不可配置：它挡的是 `contextChars: 999999` 这种手滑（实测最大的上下文节点 36664 字符、最大的用户节点 24708、最大的工具结果 30669） |

## 彩条：顶上那条三色泳道

数据就是上面的 `rows`，**一格 = 一行**，没有第二种来源（`totals.rows === strip.total`，有测试盯着）：

| lane | 放什么 | 颜色 |
| --- | --- | --- |
| 0 | 系统 / 用户 / 上下文 | 灰 / 蓝灰 |
| 1 | 助手 / 压缩 | 蓝 / 棕 |
| 2 | 工具 / 结果 | 绿 |
| 任意 | **这一行出错了** | **红** |

**"红 = 出错"读的是平台自己写的事实**：`tool/result` 的 `message.isError`（本会话 1204 条结果里 94 条 true、1110 条 false、**0 条缺字段**）以及同一事件上的 `error` 对象；另外 `turn/end` 的 `reason.kind === "error"` 是**轮级**的失败，它不按行判定（日志没说哪个节点错了，随便染红一行就是编造），而是落在这一轮的最后一格上 —— 而且只在这一轮没有任何一行自己就红的情况下才落。**未知不染红**：日志没说的行保持它 kind 的颜色，不假装成功。

点一格 → 滚到那一轮的**那一行**（`data-dshts-row` 锚点，行不存在时退回那一轮的卡片），并且把"读者在底部"的跟随标志关掉。**故意不做**官方那三个切换（时长/轮次/调用），只做轮次轴；**也故意不做**虚拟列表（官方阈值 100 行，我们 50 轮窗口只有 200~270 行，半个虚拟化比没有更糟）。

## 第一原则：它自己不写日志

**绝不 append / replace / 动任何事件。** 宿主半侧只有一条 GET 路由，没有 POST 处理器；测试用机械扫描 + 行为断言两条腿证明这一点。

## 翻历史：和官方同一组数字

官方轨迹视图自己有一套翻历史的门道，这里**照抄它的数字，不另外发明一套**（源码：`@deepseek-ai/dsh-client-ui-trajectory/lib/client.js`，行号是已发布 bundle 里的行号）：

| 常量 | 值 | 官方出处 | 在这里的用处 |
| --- | --- | --- | --- |
| `HISTORY_PAGE_NODES` | 50 | L8264 | 一次「加载更早」多加 50 轮 |
| `OLDER_LOAD_THRESHOLD_PX` | 48 | L3994 | 滚到离顶 48px 内，自动触发同一个动作 |
| `BOTTOM_FOLLOW_THRESHOLD_PX` | 2 | L3993 | 只有贴底 2px 内，新卡片才跟随 |
| `HISTORY_LOAD_ROW_HEIGHT_PX` | 30 | L3995 | 「加载更早」那一行的高度 |
| `VIRTUALIZATION_THRESHOLD` | 100 | L3996 | 官方超过 100 行才上虚拟化 —— **这里故意不做** |

- **一行「加载更早」**：类名同时有 `historyLoadRow` 与 `historyLoadButton`（和官方一样是"一行可点"的东西），高度 30px，**只在宿主答 `hasOlder === true` 时存在**。宿主（可能还是旧版本）没答 `hasOlder` 就等于"没有更早的"，绝不猜。
- **点它和滚到顶是同一个动作**：`windowTurns += 50` 再重新拉取，并且**正在加载时不重入**（`SurfaceController.loadEarlier` 用实例标志同步挡住，同一 tick 的两次调用只会发一次请求）。
- **贴底跟随是有条件的**：scroll 时记住"是否在底部 2px 内"，只有新卡片到达时这个标志为真才滚到底。**往上翻历史再也不会被弹回底部。**
- **往前插一页时不跳**：加载前记下 `{oldestTurn, scrollTop, scrollHeight}`，页面变长后恢复 `scrollTop + (scrollHeight 增量)`（官方同款 anchor），并且之后不再跟随底部，直到读者自己滚回去。文案键与官方一致：`history.loadEarlier` / `history.clickToLoadEarlier` / `history.loadingEarlier`。

## 折叠时看"是谁替换的"

同一个折叠事实，读起来是两件完全不同的事：**平台做上下文压缩**和**你自己删掉了一轮**。所以替换载体的 `source.kind` / `source.editedBy` 会被读出来，分成五类（`src/logic.js replacementAuthor`）：

| 载体来源 | 归类 | 卡片上说的话 |
| --- | --- | --- |
| `plugin:dsh-edit-turn` / `kind:'user' + editedBy:'dsh-edit-turn'` | `edit` | 已改写 |
| `plugin:dsh-delete-turn` | `delete` | 已删除 |
| `plugin:dsh-rerun-turn` | `rerun` | 已重跑 |
| `compact-checkpoint`（带 `compactionId`） | `compaction` | **已压缩进摘要**，并且**把这一轮的原始内容从日志里取回来显示在卡片上**（标注"原始内容"） |
| 其它（`system-prompt` / `tool` 等平台自理） | `other` | 已替换 |

两项必须自己读出来的细节：

- **用户自己的改写有两种写法。** 一条路径写 `kind:'plugin:dsh-edit-turn'`，另一条写 `kind:'user'` 加 `source.editedBy:'dsh-edit-turn'`。只看 `kind` 会把后一种判成平台的替换 —— 真机上 4 条载体就是这样。两种都读。
- **"已压缩进摘要"≠"内容丢了"。** 压缩确实把原始内容从**模型的上下文**里移除了（这个折叠是对的），但**日志里一条都没少**。所以被压缩的轮次显示原始正文，而不是"已从当前状态下移除"。

**用户自己删/改写掉的原稿不会复活**：恢复原稿时，凡是"被用户操作替换过"的事件一律不算，删除插件的地盘归删除插件。

## "当前状态"从哪来

优先用**平台自己的投影**（`session.surface.nodes`）→ `surfaceSource: 'platform'`；拿不到才退回本插件自己的折叠 → `'derived'`。

## 已知限制

### 与官方"逐行"不一致的地方（明细与彩条）

**这一页的明细行不是官方的行，两者不可能逐行对齐。** 下面每一条都是查过官方源码/数据后写下来的，不是猜的（官方源码：`@deepseek-ai/dsh-client-ui-trajectory/lib/client.js`）：

1. **助手一格 ≠ 一条助手消息。** 官方把**一个 step 的助手输出合并成一格**（会带上 partial / runningCalls / 嵌套 subtool），我们按事件算，一条 `assistant/message` 一行。实测第 156 轮：官方 2 行（1 用户 + 1 助手），我们 5 行（用户 / 助手 / 结果 / 用户 / 助手）—— 因为那一轮里助手说了两次（中间派了子代理）。**我们的行更细，不是更对。**
2. **官方有只作分隔的 requestOnly 行**（一次请求一行，没有对应的消息事件），我们没有：我们的行只来自界面节点，所以**不会出现"为了分隔"而存在的空行**。
3. **工具行的配对方式不同。** 官方在 `deriveTrajectoryLayout` 里把一次调用和它的结果合成一格；我们**每个节点一行**，工具名与参数摘要是"查回来"的（结果节点只有 call id）。所以一次工具调用在我们这里可能表现为两行（若调用本身也是节点），官方是一格。
4. **子工具（`tool/ptc-dispatch`）我们不做成行。** 官方快照里有 `subtool` 概念、泳道同样是 2；我们只画当前界面节点，而 dispatch 事件**不是界面节点** —— 把它做成行会和同一个结果的正文重复。
5. **被压缩的轮次：我们把原文当行显示，官方显示压缩后的当前界面。** 只在"这一轮当前一行都没有"时发生，并且每行都标 `archived`（页面写"原始内容"）。这是有意的：日志里原文一条没少，说"内容没了"才是错的；但**它确实不是模型当前上下文里的东西**，所以标出来。
6. **运行中的轮次：我们可能少行。** 只有已经落盘的节点会成为行；官方有 `partial` / `runningCalls`，能画出还没写完的那一格。
7. **上下文/用户的分类是我们自己判的**（作者不是人类也不是模型 → 上下文），官方快照里是 `kind: context` 的格子，两边的边界可能不同 —— 例如被替换的载体消息我们归 `context`（插件写的）。
8. **彩条只有轮次轴。** 官方的时长轴/调用轴、以及它的虚拟化闸门，这里都没有。
9. **时间轴也不同源**：官方用 `requests` 里的计时与 `usage`；我们只有事件的 `time`，一格不代表任何时长。

**官方的彩条是它自己从快照再算的**（`deriveTrajectoryLayout` → cells，`deriveTrajectoryTimeline` → spans），那两个纯函数没有从包里导出（客户端 factory 只导出 `{apply, inject}`），跨插件取值也是明令禁止的，所以**我们不可能复现官方的逐行结果**：本文档选择的是"拿日志自己算，并把差异写清楚"，而不是"声称和官方一样"。

### 我们折叠出来的面与平台视图的差异

**我们折叠出来的面，和平台的视图会在某些轮次上不一致。** 所有兄弟插件（dsh-declutter / dsh-delete-turn / dsh-rerun-turn）与我们都用 `if (op === undefined) continue` 这条规则；平台写的时候拒绝无标记的 surface-eligible 事件，但**老日志里可以有无标记的消息事件，而平台照样画行**。

我们**不改规则去猜**（换了规则两个 fold 就不可比），而是量化并显示：`nodesAgree`（`null` 表示没有平台投影可对比，**不等于一致**）、`unmarkedSurfaceEvents` 计数与页面提示；不一致时提示「请以平台轨迹为准」。

真机上那次"约 90 轮都像被删掉了"是**实测出来的**，不是猜的：那个会话 151 轮、10643 条事件、38 条替换载体、2341 条被遮蔽的节点，其中

    4 条 compact-checkpoint      遮掉 2307 条（98.5%）   ← 平台上下文压缩
   26 条 system-prompt / tool     遮掉   26 条            ← 平台自理
    5 条 edit（两种写法）          遮掉    5 条            ← 用户改写
    3 条 delete                    遮掉    3 条            ← 用户删除

90 个"无内容"的轮次拆开是：**82 个被压缩**（其中 79 个现在能把原始正文显示回来）、**4 个是用户自己删/改写**、**4 个是平台刷新 system prompt**。可见的"损伤"取决于窗口：默认 50 轮的窗口里被压缩的轮次是 0，窗口拉到 100 就出现 34 个 —— 所以这条限制在页面上表现为"翻得越早，压缩越多"。

**这一页的价值是"另一个视角"，不是"平台的替代品"。它不比轨迹更准。**

**它也没有去读平台自己的轨迹数据。** 技术上做得到（`ctx.uiConversation.binding(sessionId).target('trajectory')` 在客户端插件里是可注入的公开服务，官方轨迹包自己就是这么取的），但那样会**激活整个官方轨迹装配**（session 生命周期内不可撤销）换一份仍然不是行的数据 —— 官方那三条泳道的行是从这份数据再算出来的，而算它的纯函数没有从包里导出。这一页只用会话日志，代价是不与官方逐行可比：**明细行是"这一轮的界面节点"，彩条是它们的格子，两者都是我们从日志算的**。

## 切回来要秒出：缓存优先 + 一次预热

**平台的视图是"选中的那个才渲染"**：`dsh-client-ui-conversation` 用
`renderSlot("conversation.view", {...}, { only: viewId })`，渲染器再 `list.filter((item) => item.id === opts.only)`。
于是切走 = 卸载，切回 = 重新挂载，**视图里存的东西一个都带不回来**。数据必须住在控制器里
（每个会话一个，挂在插件 `apply` 的 `controllers` Map 上），"切回来立刻有卡片"才有可言。

**真机实测（headless Chromium 打开正在运行的 GUI，会话 `session-94db29c5`，2026-10-06）**：0.1.2 的视图
在真实浏览器里**三分钟没有画出一张卡片**，一直停在「正在读取…」，而这段时间里 `/state` 的 200 响应
一个接一个地回来 —— 原因不是没有缓存，是**每一趟都被更新的一趟丢掉**：

    refresh(): generation += 1
               await probe()                       ← 探针往返
               if (generation !== this.generation) return     ← 丢掉
               await /state                        ← 5~11 秒（220KB 的会话）
               if (generation !== this.generation) return     ← 也丢掉

一趟 = 探针 + `/state`，比 5 秒的 tick 还长，于是**每一趟都比下一趟老，谁也不许发布**。
切标签只是让它重新开始一趟。0.1.3 的三件事：

| 改什么 | 为什么 |
| --- | --- |
| **一趟就是一趟**：`refresh()` 串行化（线上一趟；落地的那趟一定发布），tick 在有一趟在飞时直接跳过 | 修掉上面的自我饿死：不再互丢，页面最多等一趟 |
| **缓存优先**：失败的一趟**什么都不替换**（保留上一份 payload，失败作为提示显示在卡片旁边）；`正在读取…` 只表示"手上真的一无所有" | 一次失败不再把卡片清空，切回来第一帧画的就是缓存 |
| **预热**：`ctx.inject(['uiSession'])` 读平台自己的"主视图会话"绑定（`uiSession.current` 的 `key` 就是 sessionId），**每会话预取一次** | 第一次点也有卡片。官方的数据在会话级 store 里，所以它天然"一直在线"；我们只能自己先问一次 |

**预热是克制的**：一个会话一次（`prefetch()` 只在"没有 payload 且没预热过"时发一趟），**没有轮询、没有定时器**
（轮询只活在 `attach()`/`detach()` 之间：视图不在，一个请求都不发），**失败静默**（没有视图订阅时，失败不是任何人的事，
不发布、不重试、不冒红字）。平台没有这个服务时什么都不发生，页面照常，只是慢一趟。

## 体积

明细是"每条都截断"的（见上表），所以体积随轮数大致线性，而**平台自己的投影不会** —— 被压缩的轮次在平台那边一行都没有，所以我们的比例比看起来更陡。实测会话 `session-94db29c5`（156 轮 / 10706 事件），HTTP 响应体字节数：

| 窗口 | 0.1.1（只有首尾两行） | 0.1.2（明细 + 彩条） | 倍数 |
| --- | --- | --- | --- |
| `turns=50`（默认窗口） | 87 955 | 205 341 | 2.34× |
| `turns=100` | 173 839 | 357 133 | 2.05× |
| `turns=156`（整段） | 278 477 | 518 842 | 1.86× |

默认窗口下 267 行 / 205 KB，其中**明细行本身约 105 KB**；`rowBudgetChars=9000` 时该会话只有 1 轮真的被预算截断（那一轮 35 行，最后一行是 36664 字符的上下文注入）。想更小就压低那几个 `*Chars`，或者让页面把 `turns` 要小一点 —— 两者都是配置，不是代码。

## 验证到了哪一步（以及没验到哪一步）

**验过的**：纯核心与宿主路由由测试直接驱动；真机上另有一条本地脚本把**插件自己的 `apply()`**挂到临时回环端口上，喂**真实的会话日志**（`~/.dsh/sessions/<工作区>/<id>/session.v4.jsonl.zstd`，4938 个 zstd 帧、4361 万字符明文、10706 条事件），走的是路由处理器本身：

    GET /dsh-client-ui-trajectory-plus/state?sessionId=session-94db29c5-…&turns=50   -> 200, 205 341 bytes

**没验过的**：

1. **没有浏览器**。视图半侧是 test/dom-stub.js 跑的（它实现模块加载协议、几个 React hook 和 fetch 记录器，别的一律抛错），所以"点一格真的滚过去"验的是 `scrollIntoView({block:'center'})` 被调用、以及 `ref` 收到了哪个节点 —— **不是**真的滚动、布局、sticky 或配色。真机样式要人眼过一遍。
2. **stub 的忠实度假设**：`useRef` 按组件身份给同一个盒子、`useEffect` 按依赖数组决定跑不跑 —— 这两条是照 React 的语义写的，别的都没写。所以"卡片把 ref 交给了哪一行"这类断言可信；"渲染顺序/重渲染次数"之类不可信（stub 不重渲染）。
3. **真机运行中的 DSH 里那份插件还很旧**（`/state` 答 `version 0.1.0`、没有 `hasOlder`），所以**看不到新页面**：宿主半侧改动要重启才生效。上面的真实数字是**用真日志 + 真路由处理器**跑出来的，不是浏览器里看到的。

## 测试

    node --test test/*.test.js      # 71 条：纯核心 / 宿主路由 / 浏览器半侧 / 每轮明细 / 彩条 / 缓存优先与预热 / 只读机械扫描

**负向验证**（改坏一处 → 恰好对应测试转红）：

| 故意改坏 | 转红 |
| --- | --- |
| 明细退回"只取首尾两条事件" | 12 条 |
| 去掉截断（`clipText` 不切） | 2 条 |
| "红色 = 出错"改成"不是明确成功就红" | 2 条 |
| 轮级失败不染红 | 1 条 |
| 每轮预算不生效 | 2 条 |
| **缓存优先改回"失败就把 payload 清空"** | **1 条**（cache first…） |
| **预热失败改成照常发布** | **1 条**（NEGATIVE: a prefetch failure is silent…） |
| **恢复"竞争趟 + 完成也丢弃"的旧 refresh** | **5 条**（含"a pass that is on the wire publishes…"） |
| **去掉 `uiSession` 预热接线** | **1 条**（the session the main view is showing is warmed once…） |
| **挂载时清空缓存（假装在刷新）** | **2 条**（cache first…／a tab switch is an unmount and a mount…） |

最后五行是 0.1.3 的负向验证：每一行都是"改坏一处 → 恰好对应测试转红"，上面那张表的做法一样
（在副本上改，不在仓库里改）。

## 许可

MIT
