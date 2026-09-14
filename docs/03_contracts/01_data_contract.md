# 数据总契约、字段责任与一致性规则


## 一、规范性来源

机器可读的限制见 `reference/contracts/limits.json`；建表参考见 `reference/sql/001_initial.sql`。路径以压缩包根目录为起点。SQL 中 CHECK、外键与唯一约束是最后一道保护，不能取代服务层验证。JSON 数组的类型、元素长度和 ID 合法性要由 Zod 与业务校验完成。

本方案采用九张表，而不是初始设想的四张表。新增内容不是企业架构：tags 与 item_tags 解决准确标签查询；ai_runs 解决中断与重复付费；secrets 把秘密与可导出设置隔离；app_meta 保存数据版本。没有组织表、用户表、权限表、事件总线表、向量索引表和通用插件表。

## 二、Item 的身份与版本

id 是系统生成的 UUID，永不从标题派生。title 不是主键，也不是唯一值。captureRequestId 表示一次采集动作；同一请求 ID 加同一指纹是重放，同一请求 ID 加不同内容是 409 冲突。用户有意再次保存同一句话时生成新请求 ID，系统只提示可能重复，不阻止。

capturedText 原样保留最初的 Unicode 文本，包括换行与内部空格。仅用于判断空输入时使用 trim；不能为了验证而把用户原文先 trim 再覆盖保存。rawText 初始等于 capturedText，用户修改以后 rawVersion 加一。revision 在任何用户可见领域字段变化时加一；运行状态由 processing 变更不单独增加领域 revision。

structuredBaseRawVersion 指出当前 AI 整理基于哪个 rawVersion。若与当前版本不同，整理字段属于过期派生信息。manualFields 是一个受控字段名数组，允许 title、summary、type、tags、keywords、importance。capturedText、id、revision、时间戳和来源内部字段都不能放进去。

API 返回的 ItemDTO 包含 tags 数组，但数据库不再额外保存 tags_json。标签权威存储是 tags 与 item_tags，避免 JSON 列和关系表相互冲突。keywords 是低成本检索提示，保存为 JSON 数组，不建立独立关键词实体表。

## 三、Relation 的方向与真值边界

关系的 sourceId 和 targetId 必须都是已存在条目。similar_to、contradicts、related_to 视为对称关系，存储前按 UUID 字符串排序端点；extends、supports、causes、depends_on、example_of 保留语义方向。显示文案必须按源到目标解释：A depends_on B 表示 A 依赖 B；A example_of B 表示 A 是 B 的例子。

每一对规范端点加 relationType 只有一条记录。重复 AI 建议不能累积成平行边。人工创建相同关系时升级原记录，origin 变 manual、reviewStatus 变 accepted、score 变 null；不是再插入一条“人工版本”。被用户 rejected 的 AI 建议不因下一轮整理重新出现。

AI 关系保存 score，但 UI 应称“关联评分”，不可写“正确率”。审核状态与评分互不替代：高分仍可以是 suggested，低分也不能覆盖用户 accepted 的人工判断。人工关系不需要假造 1.0 的评分。

sourceRawVersion 与 targetRawVersion 记录建立关系时的原文版本。任一端修改，关系变为 stale 派生状态。数据库不额外增加一个会漂移的 stale 布尔列，读取时比较版本。陈旧关系默认不参加新的因果图推导，详情仍可查看，用户可重新确认或删除。

证据 evidence 保存 itemId、rawVersion 与逐字摘录。当前版本仍匹配时，摘录必须存在于对应原文；缺少证据时不能以模型编造的引号补齐。证据证明模型参考了哪些文本，不证明文本事实本身正确。

## 四、View 不等于另一份笔记

View 的 kind 只有 graph、mindmap、flow。selectionJson 记录用户选择方式与显式来源；sourceSnapshotJson 记录条目及关系版本；contentJson 记录位置或受限图结构。View 不保存新的权威 Item，也不能通过图标签改写 Item。

Graph 的 positions 是 presentation data。Mindmap 保存树结构及可再生的编译信息；Flow 保存受限节点和边。View同时保存promptVersion，导出时保留以支持内容哈希核对。生成后的 markdown、Mermaid 源码可以缓存为展示产物，但 canonical 内容仍是经过验证的 JSON，不能让手工修改源码绕过校验。

generation 时间与 viewed 时间分开处理。打开视图不会改 generatedAt。过滤器改变但未生成时，只改变页面草稿，不自动覆盖已保存视图。删除来源后，视图应返回 missingSources，而不是删除整个视图让用户失去上下文。

## 五、Run 是账本，不是消息队列

ai_runs 记录一次显式操作的身份、输入指纹、状态、期限、模型配置版本及结果引用。它不保证浏览器断开以后后台工作继续完成，也不自动无限重试。requestKey 是幂等键，requestHash 是调用方明确提交的 kind、目标、expectedRevision、选择ID、意图等请求意图的稳定哈希；inputHash 才包含服务端解析的资料与配置版本快照。重放先查 requestKey 与 requestHash，不能用已变化的当前配置或当前Item版本重新定义旧请求。

configSnapshotJson 不能包含 apiKey、Authorization 或完整请求体。usageJson 只保存供应商实际返回且验证过的用量；没有用量返回时是 null，不根据字数制造精确 token 账单。错误正文也不能照抄供应商返回的整个请求或头部。

同一 Item 同时最多一个 running organize，由部分唯一索引与事务保证。全局网络并发限制为一个需要外部调用的操作；其他调用收到明确忙碌响应，不进入隐形队列。连接测试也占这个槽位，避免用户连续点按钮产生多个付费请求。

## 六、删除、孤儿数据与恢复

删除 Item 会通过外键删除关联边和标签连接，不删除标签词典中的所有同名标签，不自动删除历史 View。ai_runs.subjectId 故意不是级联外键，运行记录可以保留失败或删除事实，但最终提交必须重新检查目标存在。

清理孤立标签是可选维护行为，不影响 MVP 主流程。导入前验证全部 ID、引用与版本；只允许向空知识库恢复，避免做隐含合并策略。任何记录非法则整包拒绝，不能导入一半再让用户自行找缺失部分。

手动备份数据库时必须停服并处理 WAL；优先使用逻辑 JSON 导出与受控导入。秘密不在逻辑导出里。完整 SQLite 文件仍可能含明文秘密，不可把它当作可公开分享的普通笔记文件。
