# HTTP 总契约、请求体和逐接口行为


## 1. 全局规则

应用唯一默认 Origin 为 http://127.0.0.1:3000。端口改变时必须同时改变启动脚本和 APP_ORIGIN，不能客户端一个端口、服务端另一个。localhost 不作为默认别名自动接受，避免 Host 白名单扩散。API 统一 JSON，成功体为 {ok:true,data,requestId}，失败体为 {ok:false,error:{code,message,retryable,fieldErrors?},requestId}。文件下载是明确例外：成功返回附件，失败仍是 JSON。

普通 JSON 请求体上限六十四 KiB；视图布局/详情保存路由可用二百五十六 KiB；导入路由单独上限二十 MiB。这些覆盖关系按路由声明，不允许导入误走通用六十四 KiB 拦截器，也不允许所有接口为迁就导入而放大。读取 request body 时流式计数，Content-Length 只作提前拒绝提示，不是可信证明。

所有私人数据响应 Cache-Control:no-store，不开放 CORS。除 health 和 session 启动流程外均携带 X-Brain-Token。mutation 要求 Origin 严格匹配和 application/json；需要二进制下载的 GET 不把 token 放查询字符串，而由 fetch 带 header 获取 blob 后生成临时下载链接。浏览器自身不直接导航带秘密或会话令牌的 URL。

HTTP 状态约定：200读取、更新、删除成功或幂等重放；201首次创建；202同一个模型操作已运行、返回 runId；400不合法 JSON/字段；403本地请求保护失败；404实体不存在；409版本或请求键冲突、运行忙碌、非空库恢复冲突；413字节超限；422结构合法但业务来源/图结构不合法；502提供者协议或远端失败；504模型超时；500未预期本地错误。HTTP 200 的空 data 不用于掩盖失败。

## 2. 采集、查询和编辑

POST /api/items 的体：{captureRequestId,rawText,sourceType,sourceRef}。captureRequestId 是客户端为一次保存动作产生的 UUID；服务器生成 Item.id。首次201返回 ItemDTO；同键同 hash 的重放200返回相同 ItemDTO，并增加 replayed:true；同键异内容409 CAPTURE_KEY_CONFLICT。成功响应到达前不清空 textarea，响应丢失时保留同键可重试，不能生成第二份笔记。

GET /api/items 使用 q、type、status、tagId、sort、limit、cursor。q 最大二百码点。sort 为 newest、oldest、importance；稳定 tie-breaker 是 id。cursor 是经过 base64url 编码的有限 JSON {sort,sortValue,id,filterHash}，服务端仍严格校验，不执行解码后的 SQL。响应 {items,nextCursor,totalMatched}；filterHash 不匹配时400，不把旧查询的游标用于新过滤器。q 的百分号和下划线需要按 LIKE 字面搜索转义，排序列只用枚举映射。

GET /api/items/:id 返回 ItemDTO；PATCH 体为 {expectedRevision,patch,unlockFields?}，patch 只允许 rawText、title、summary、type、tags、keywords、importance、sourceType、sourceRef。人工字段锁由服务器根据实际改动建立，浏览器不能任意提交 revision、capturedText 或 status。DELETE 体为 {expectedRevision}，成功200 {deletedId}。不存在404，版本不匹配409。删除知识需要 UI 明确确认；删除图节点的键盘快捷键不能直接走此接口。

GET /api/tags 返回 {tags:[TagDTO]}，可加 q 过滤但仍限长。它是现有词典，不自动补齐模型猜测的标签。没有 tagId 的同名标签创建交给 Item/Relation 领域服务统一规范化，不提供无边界“执行标签 SQL”接口。

## 3. 关系接口

GET /api/relations 支持 itemId、reviewStatus、includeStale；默认不返回 rejected，详情页可显式请求完整审核记录。POST 体为 {sourceId,targetId,type,reason,sourceExpectedRevision,targetExpectedRevision}，代表用户手工创建，服务器记录 origin=manual、reviewStatus=accepted、score=null、端点当时 rawVersion。相同规范关系若是 AI 建议则转为人工认可记录，而不是另插平行边。

PATCH /api/relations/:id 体为 {expectedRevision,action,...}。action 限定 accept、reject、restoreSuggestion、reconfirm。前三者仅适用于 origin=ai：accept 认可当前建议；reject 保留拒绝墓碑；restoreSuggestion 明确把 rejected 改回 suggested。reconfirm 要求双方当前版本和用户确认，更新依据版本；旧证据不能继续假装当前逐字成立，必须重新匹配或清空并说明人工复核。

人工关系没有 reject 操作，删除走 DELETE {expectedRevision}。对于 AI suggested/accepted 的“不再显示”，UI 默认提供 reject，不使用 DELETE，因为删除记录会丢失防复活墓碑。彻底删除 AI 墓碑不作为 MVP 普通入口。API 可以对不允许的 origin/action 返回422，而不是违反数据库检查后才500。

## 4. 设置、运行与模型生成

GET /api/settings/llm 返回配置、revision、apiKeyConfigured，不返回 Key 的长度、后四位或星号占位值。PUT 体为 {expectedRevision,config,keyAction,apiKey?,confirmKeyTransfer?}。首次无配置时 expectedRevision=0，服务端插入 revision=1；随后正常CAS更新。空未配置 GET 返回 default config、revision=0、apiKeyConfigured=false，不需要构建期间写数据库。

POST /api/settings/llm/test 体是 {requestKey,draft:{config,keyAction,apiKey?,confirmKeyTransfer?},expectedSettingsRevision}，测试当前草稿而不保存。已有 Key 的 keep 必须指向当前设置 revision，避免测试期间悄悄换秘密。测试记录安全 Run 和调用次数，返回 {runId,connected,latencyMs,replyAccepted}。连通成功与回复恰好 OK 是两个概念：有效完成且内容非空可报告 connected=true，但不符合指定最小回复则 replyAccepted=false，不能把格式问题错报为网络不通。

POST /api/items/:id/organize 体为 {requestKey,expectedRevision}。服务端自行读取配置和资料，前端不能发送候选正文替代真实库。POST /api/views/mindmap/generate 体为 {requestKey,selection:{mode:'explicit',itemIds},intent?}；flow 还要求 intent 非空且不超过一千码点，以及 direction=LR|TB。Tag 筛选在 UI 先解析为显式 ID；服务端重新确认存在、上限与版本，不自动把图中未选资料发出去。

新操作在等待完成后200 {runId,itemId? ,viewId? ,warnings:[]}；相同运行中请求202 {runId,state:'running'}。已成功运行的结果实体后来被删除时，重放仍只返回该Run历史结果并标resultMissing:true，不再付费、不重建已删除Item/View；客户端据此显示结果已删除。GET /api/runs/:id 仅读取 RunDTO；POST /api/runs/recover 进行幂等的过期恢复并返回 recoveredIds。启动初始化、注册新 Run 前也可以执行恢复；禁止让普通 GET 悄悄发起模型。没有外部 worker，也没有排队完成保证。

## 5. 图数据与保存的视图

POST /api/graph 作为只读复杂查询接口，体为 {filter:{tagId?,type?,reviewStatuses?,minimumScore?,includeStale?},itemIds?}。放在 src/app/api/graph/route.ts，避免数百 UUID 塞进 URL。返回 {nodes,edges,datasetRevision,scope:{matchedNodeCount,shownNodeCount,matchedEdgeCount,shownEdgeCount,truncated}}。有范围截断时显示醒目提示，不能把部分图称全量；边只能连接已返回节点。

GET /api/views?kind=&limit=&cursor= 返回 ViewSummaryDTO 列表。POST /api/views 只允许创建 graph 布局视图，体为 {name,selection,positions,direction}，服务器根据当前有效来源生成快照。mindmap/flow 必须来自经过校验的生成服务，普通浏览器不能用 POST 任意写不可信图结果。GET /api/views/:id 返回 ViewDTO。

PATCH /api/views/:id 只允许 {expectedRevision,name? ,graphLayout?}；graphLayout 仅 graph 类型。Mindmap/Flow AST 在 MVP 不允许直接编辑；重新生成是新 Run 和新 View。DELETE body {expectedRevision} 只删视图，不删 Item。保存历史列表、命名和删除是图页面可用性的组成部分，不只做一个生成后刷新就丢的画面。

## 6. 导出和恢复

GET /api/export 为整库逻辑 JSON。GET /api/views/:id/export?format=json|markdown|mermaid 根据类型限制：graph 只 JSON；mindmap JSON/Markdown；flow JSON/Mermaid；不支持的格式400。SVG 为后续经测试的可选能力，不是当前必须实现的 API。

POST /api/import/validate body {bundle} 返回 {valid,bundleHash,counts,warnings}，不写库。POST /api/import body {bundle,expectedBundleHash,confirmEmptyRestore:true} 再次校验并事务恢复。bundleHash 对 canonical bundle 计算，不对浏览器原始空格格式计算，因此相同内容不同缩进不会误判改变。浏览器不上传路径，服务端不读取用户指定任意文件路径，不下载 URL 备份。

GET /api/diagnostics 返回版本、能力和安全状态摘要。GET /api/health 只返回固定应用名、健康布尔和兼容协议版本，不泄漏数据库计数、路径或模型地址。任何含用户数据的诊断都需要本地令牌。

## 7. 错误码不允许各页发明

标准错误码与路由登记见 reference/contracts/api_registry.json 与 error_codes.json。UI 根据 code 决定按钮，不解析中文错误文案作逻辑。retryable=true 表示用户可以考虑显式重试，不表示客户端自动重试。401远端认证失败映射 PROVIDER_AUTH，仍不向浏览器转发供应商整个响应体或 Authorization。网络调用是否计费无法确定时显示“本次请求可能已到达服务商”，不承诺超时一定免费。
