# LLM流水线：逐步事务、协议解析和失败落点


## 1. 接口只做四件事

Route Handler 负责本地请求保护、请求体校验、调用服务、映射 HTTP 响应。它不拼提示词、不打开新的数据库连接、不把 JSON 直接写表。OrganizeService 负责运行快照与应用事务；LLMAdapter 负责供应商 HTTP；Schema 与领域验证器负责把不可信结果转为可用纯数据。这四层职责必须在目录里看得出来。

LLMAdapter.complete 接收 {configSnapshot,apiKey,messages,deadline,structuredMode,tokenOptions,signal}，返回 {content,finishReason,usage,providerRequestId?}。API Key 仅出现在这次调用内存和 Authorization，不放 configSnapshot，不序列化。提供者请求 ID 如果记录必须限长并排除异常正文，不等于本地 requestId。

ProviderClient 接收注入式 fetch、clock，便于测试。业务服务接收适配器接口，测试可替换网络但不能替换版本检查和数据库事务。不要在测试环境整体跳过 OrganizeService 返回假 Item，这样无法验证最容易丢数据的部分。

## 2. 注册阶段

收到organize请求后先校验请求格式并计算稳定requestHash，在短事务里先查requestKey。相同键与相同请求意图直接重放既有Run，不重新检查已经可能改变的Item版本、配置或Key。相同键不同意图返回409。只有确实没有旧Run的新操作，才读取Item、确认expectedRevision、解析当前配置与Key、建立inputHash快照、恢复过期运行并占用全局槽位。事务提交后才调用模型；Item.lastRunId与processing标记和Run注册一起提交。

部分唯一索引 idx_one_global_running 是最后一道并发约束，不只靠进程变量。SQLite UNIQUE 冲突需映射 RUN_BUSY，不把正常竞争写500。连接测试、整理、脑图与流程都使用同一槽位。浏览器允许继续保存其他笔记，只有需要模型的操作忙碌；不存在“等待队列”暗中吞下用户按钮。

Run 保存输入 revision、rawVersion 的快照哈希、候选 ID、配置 revision、提示词版本、安全配置摘要、startedAt、deadlineAt。单条原文不需在 Run 里复制，因为 Item 与快照版本已经可验证；完整模型响应也不作为日志长期保存。必要的失败局部诊断应截断且避免原文泄露。

## 3. 上下文阶段

为 organize 选取最近十二条和字面检索候选，最大四十条。读取候选的 title、summary、tags 和逐字证据片段，按预算打包。被编辑或删除的候选到最后应用时仍需重新校验。候选缺失只使相关建议失效，是否整次 conflict 由以下确定规则处理：目标 Item 版本变更整次 conflict；候选变更只拒绝涉及该候选的关系，元数据仍可成功，warnings 说明丢弃数量。

这与生成视图不同：Mindmap/Flow 对选择的每个来源建立整体快照，任一来源 revision 或被引用 Relation revision 变化则整次 generation conflict，不保存把两个时点混起来的视图。两者差异来自目标：整理条目只有一份核心原文，候选只是可选关系；视图的全部选中资料共同构成生成依据。

达到上下文预算时，优先保留目标原文和用户意图，再按已排序候选截断到完整候选对象，不把 JSON 截成半个字符串。目标原文本身超过项目上限采集时已经被拒绝。如果用户选择的资料即使精简也无法满足预算，返回“缩小选择范围”，不要悄悄漏掉半数已选条目却生成完整外观的图。

## 4. HTTP 阶段

在实际请求开始前原子增加 Run.attemptCount。允许值零到二。默认 schemaRepairEnabled=false 时最多一次；用户开启且第一轮是完整但结构错误时才允许第二次修复。每次尝试使用 min(providerCallTimeout,operationDeadline-now)，不能每次给自己一个全新一百二十秒。

基础 body 只有 model、messages、stream:false。prompt_json 不发送 response_format。json_object 才发送 {type:'json_object'}，且提示词明确要 JSON；不因为某供应商官方支持 JSON Schema 就假设所有兼容服务都能接受该参数。tokenField=none 时完全省略 token 限制字段；其他档位只发送对应一个字段，不能同时发 max_tokens 与 max_completion_tokens。temperature 默认省略，避免不支持模型参数而失败。

使用原生 fetch，redirect:error，AbortController 或 AbortSignal组合。先检查状态码，再有界读取 response.body，累计 UTF-8 字节到二百五十六 KiB 则终止。错误响应也有上限，不能只有成功响应限长。不要先 await response.text() 读无限内容再检查长度。

认证错误、限流、服务端错误、断网、超时按统一错误码返回，不自动发送第二次网络请求。Retry-After 可以作为安全提示，经格式校验后显示，不触发自动付费倒计时重试。

## 5. 协议解析阶段

兼容协议最小接收要求是 choices[0].message.content 为非空字符串，且 finish_reason 不是 length。拒绝 null content、tool_calls、函数调用、非字符串内容块、模型 refusal 标记与显式拒绝文本协议。MVP 不拼接多 choices，不执行 tool call，也不把 reasoning_content 当最终结构化结果。

完整 content 可以剥离一层覆盖全文的 ```json 围栏；不能从“这里是答案：{...}顺便...”中贪婪截取第一个大括号。剥离后只允许 JSON.parse。先限制字符串字节，解析后限制对象深度和总节点数，再 Zod strict schema，再领域来源验证。禁止 eval、Function、yaml任意对象反序列化和执行返回脚本。

格式修复只处理“已经完整返回但JSON语法或字段schema不符合”；不为来源越权、虚构证据或错误因果追加模型请求，这些按关系丢弃或视图拒绝处理。截断、拒绝、网络失败不修复。修复消息包含原生成文本的有界内容、最小字段错误和相同 schema要求，不追加其他笔记。没有剩余总期限或未启用修复时直接失败。第二次依旧不合格就终结，不能再套自反思循环。

## 6. 应用阶段

验证成功后开新的短事务。再次读取 Run 必须 running，Item 必须存在且 revision 与注册快照相等。若不相等，把 Run 标 conflict，结束事务而不改整理字段。目标已经删除时保留 Run 的安全终态，但绝不重新 INSERT 一个同 ID Item。

更新只作用于未锁定字段。标签规范化和连接更新在同一事务中；不能先写摘要再因为标签冲突留下半条更新。structuredBaseRawVersion 对齐当前原文；Run 成功、Item状态、关系 upsert、datasetRevision 一起提交。如果无任何领域变化，允许 no-op 成功，但 Run 仍是完整终态。

关系逐条做候选 ID 限制、存在性、端点版本、类型、评分、证据和规范端点检查。低于0.70丢弃，仅是抑制杂线的工程阈值，不是概率。重复、已拒绝、已人工确认的关系不能被新的建议覆盖。返回 warnings 可告诉用户“生成五条建议，实际保留两条”，不将无效建议伪装成已入库。

提交意外失败时 rollback。然后单独短事务尝试把仍 running 的 Run 标 failed，保持原有知识字段。不能在已失败事务里继续写错误，也不能把失败的第二阶段追溯为“原文保存失败”。如果错误记录本身也因数据库故障无法写入，返回安全错误与 requestId，租约恢复负责以后清理。

## 7. 中断恢复的可证明行为

任何维护恢复都以数据库 startedAt/deadlineAt 和可注入时钟判断，不以浏览器倒计时为权威。超过租约且仍 running 的记录原子改 interrupted；关联 Item 派生状态重新计算。迟到响应提交时会发现 Run 不再 running，必须丢弃。恢复不会再调用模型。

浏览器关闭时不承诺请求继续，也不承诺必然取消。用户重开后读 Run 或触发 recover；如果仍在有效期限内显示处理中，如果已终态展示结果，如果过期中断展示显式重试。系统没有可靠后台任务，不写“关掉页面也会自动整理完”。
