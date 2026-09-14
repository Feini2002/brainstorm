# DTO、身份、版本与规范化：逐字段实现契约


## 1. 命名与数据映射

数据库使用 snake_case；HTTP 和 TypeScript 使用 camelCase。Repository 负责一次性映射，不允许页面直接读取数据库列名。所有 JSON 对象禁止未知字段；Zod 的默认剥离行为不能被误认为严格拒绝，必须使用对应版本的 strict object 能力。返回 DTO 只能白名单构造，不把数据库行直接 JSON.stringify。

ItemDTO 的必需字段为 id、capturedText、rawText、rawVersion、revision、structuredBaseRawVersion、title、summary、type、tags、keywords、importance、manualFields、status、lastRunId、error、sourceType、sourceRef、createdAt、updatedAt、isStructuredStale。nullable 字段也返回 null，不让不同页面自行猜缺省含义。tags 是有序字符串数组；标签筛选器另从 TagDTO 取得 id、label、normalized、itemCount。不要把 ItemDTO.tags 改成对象数组。

RelationDTO 必需字段为 id、sourceId、targetId、type、origin、reviewStatus、score、reason、evidence、sourceRawVersion、targetRawVersion、revision、runId、createdAt、updatedAt、isStale。API 字段 type 映射数据库 relation_type。evidence 中每条为 itemId、rawVersion、quote；rawVersion 由服务器根据已校验材料填写，不相信模型自报版本。isStale 是端点当前版本比较结果，不接受前端 PATCH。

ViewSummaryDTO 为 id、name、kind、revision、generatedAt、createdAt、updatedAt、sourceCount、isStale、missingSourceCount。ViewDTO 再增加 selection、sourceSnapshot、content、contentHash、rendererVersion、promptVersion、runId、missingSources。列表不返回完整 content。sourceSnapshot 中 items 是 id、rawVersion、revision 的数组，relations 是 id、revision 的数组。missingSources 是已不存在的条目 ID 数组；不会因此把 View 详情变为 404。

RunDTO 为 id、kind、subjectId、state、startedAt、deadlineAt、finishedAt、resultRef、error、attemptCount、usage、promptVersion。requestHash、秘密配置、完整上下文和提供者响应正文不返回。usage 只能是供应商确实返回且格式合法的数值；缺失时为 null，attemptCount 是本系统实际发起的请求次数。

## 2. 长度、空值和字符

文字长度以 Unicode 码点计数，TypeScript 用 Array.from(text).length 或等价实现，不用 UTF-16 code unit 数充当“字”。JSON 和网络大小以 UTF-8 字节计数，二者是不同限制。中文、emoji 和组合音符都保留原样；规范化标签可以采用 NFKC，但原文不得自动 NFKC、去重音、替换引号或重排换行。

rawText 要求 trim 后非空且总长度不超过一万码点，入库保留原字符串。title、summary 在未整理时允许空字符串；用户清空它们也是合法编辑。模型 OrganizeResult 的 title、summary 则要求非空，这是输入 DTO 与生成 DTO 不同的原因。sourceRef 默认 null，只是来源记录，不会自动抓取。把它当链接打开时另做 http/https 协议检查，不把任意字符串直接交给 href。

tags 和 keywords 先检查各项类型和长度，再去空、规范化匹配键、有序去重。数组最大值按去重后的有效项计算，但原始输入数组也要设合理硬上限，防止一百万个重复空串耗尽资源。原始数组超过四倍最终上限直接拒绝；不要无限处理到凑够合法数量。

## 3. 版本演算表

采集成功：rawVersion=1、revision=1、structuredBaseRawVersion=null。capturedText 与 rawText 相同。修改 rawText 且内容确实变化：rawVersion+1、revision+1，保留旧摘要和旧关系以供检查，但它们变为过期派生数据。内容完全相同的 PATCH 是 no-op，不增加任何版本。

修改 title、summary、type、tags、keywords、importance 中一项或多项：一次事务只让 revision+1，并把实际人工编辑过的字段加入 manualFields。手动解锁字段也让 revision+1。修改 sourceType 或 sourceRef 同样改变 revision，因为来源是领域数据；不增加 rawVersion。

整理开始、轮询、失败、运行恢复只更新运行和展示状态，不增加 Item revision。整理成功若应用了字段、更新了 structuredBaseRawVersion 或关联依据，则对该 Item 一次增加 revision。所有字段人工锁定且原文版本已对齐的再整理可以是领域 no-op，但仍结束 Run 并记录“未覆盖任何字段”；不能为了让界面看起来有变化而解除人工锁。

新建、编辑、审核、删除 Relation 各自维护 Relation revision；不连带增加两端 Item revision。datasetRevision 在任何知识实体、标签连接或关系的实质变更事务中加一。仅修改 View 布局不增加 datasetRevision。新建和修改 View 使用自己的 revision。设置和秘密变更统一增加 settings.revision，即使只有 Key 变化也增加，防止运行快照误认凭据未变。

## 4. 精确状态推导

实现唯一 deriveItemStatus(item,lastRun,now)。优先级如下：有与该 Item 相关且未过租约的 running 整理时显示 processing；没有有效运行而 structuredBaseRawVersion 存在并不等于 rawVersion 时显示 stale；版本相等且存在成功整理基础时显示 done；没有成功基础且最后一次整理 failed/interrupted/conflict 时显示 error；其余显示 raw。

这是对早期“有旧结果就可能 stale”的精化：**同一原文版本的成功结果，在再次整理失败后仍是 done，但附 lastRunError 提示；只有原文版本不相等才是结构过期。**用户只改标题导致旧运行 conflict，不会使当前原文的旧成功结果凭空失效。status 是持久化便于查询的派生摘要，每次相关事务调用相同 helper 同步，读取时可做一致性断言，禁止每页自己推导不同结果。

运行注册时若旧运行已经超过 deadlineAt，应先按恢复规则终结旧运行，再尝试占用全局槽位。数据库 deadline_at 表示 startedAt+runLeaseMs，不表示单次请求超时。operationDeadline 在内存按 startedAt+operationDeadlineMs 计算；即使发生一次修复也不得重置。连接测试使用其十五秒请求预算，但仍占同一个可恢复 Run 槽位。

## 5. 规范哈希

统一实现 canonicalJson：对象键按字典序递归排序，数组保持语义顺序，拒绝 undefined、NaN、Infinity、BigInt、循环引用和原型对象。只有本应用校验后的纯数据进入该函数。SHA-256 对 UTF-8 canonicalJson 求值，写成小写十六进制。

captureRequestHash 对 rawText、sourceType、sourceRef 的规范对象计算；不包括服务器生成的时间或 ID。选中来源集合的 identity hash 先按 ID 排序去重，因为勾选先后不代表不同材料集合；若用户排序用于层级表达，另存为有序 intent，不混入集合身份。Run.requestHash只包含调用方提交的稳定请求意图，不混入重放时重新读取的配置和领域版本。Run.inputHash包含首次解析的输入版本、配置版本、选择快照、intent、promptVersion与格式档位。一般模型操作通过settings.revision标记凭据变化，不把Key写进输入快照。连接测试可对包含临时新Key的提交体一次性求不可逆SHA-256来区分不同测试请求，但不得保存该请求体、返回该指纹或记录明文秘密；摘要不是加密存储替代。

view.contentHash 对 kind、canonical content、sourceSnapshot、promptVersion 求值。View必须单独保存promptVersion，graph为null，生成视图为实际模板版本；不能只依赖导出时会被去掉的runId来回查。名称、当前展开状态、窗口尺寸和最后查看时间不参加内容哈希。相同材料可以由两次不同 Run 生成不同 View，这不是需要合并的重复数据；用户应能比较不同组织方式。

## 6. 错误必须保留边界

所有版本冲突返回 409 和当前 revision 的安全摘要，不自动把用户草稿覆盖成服务器值。UI 提供重新载入和保留草稿两种操作，不提供未明确实现的自动三方合并。删除中的不存在对象返回 404；相同幂等采集重放返回既有对象，而不是把所有 POST 都当 upsert。

本契约优先于任务文档中的简化例子。更新字段名或版本规则必须同时更新 JSON Schema、SQL 映射、API 示例和受影响测试，不得只在一个页面临时兼容两个名字。
