# 逻辑备份Bundle：无秘密、可恢复与事务顺序


## 1. 明确恢复格式，而不只提供下载按钮

Bundle使用schemaVersion=1。顶层白名单字段为schemaVersion、exportedAt、data。data字段为knowledgeItems、tags、itemTags、relations、views。counts可以作为校验响应派生，但不作为备份权威数据再复制一份。api_runs、settings、secrets、app_meta不导出。每张实体表不是SELECT *映射，而是显式构造安全Backup DTO。

knowledgeItems包含id、captureRequestId、captureRequestHash、capturedText、rawText、rawVersion、revision、structuredBaseRawVersion、title、summary、type、keywords、importance、manualFields、sourceType、sourceRef、createdAt、updatedAt。**不包含tags数组**，标签的唯一归属由tags与itemTags重建；也不包含status、lastRunId、errorMessage等运行状态。导入后根据structuredBaseRawVersion与rawVersion重算raw/done/stale，不能把上次processing状态导回来。

tags包含id、label、normalized、createdAt；itemTags包含itemId、tagId、position。保留tagId是为了恢复已保存的标签筛选视图。每个Item标签position零到七、不重复；同一normalized只能有一条tag。关键词保留为数组，不变成另一套标签词典。

relations包含领域字段id、sourceId、targetId、type、origin、reviewStatus、score、reason、evidence、sourceRawVersion、targetRawVersion、revision、createdAt、updatedAt，runId统一不导出。views包含id、name、kind、selection、sourceSnapshot、content、contentHash、rendererVersion、promptVersion、revision、generatedAt、createdAt、updatedAt，不导出runId。

备份保留历史View的missing source引用是合法的，因为源Item可能已被删除；不能为了要求所有View来源都存在而使现实知识库无法导出。相反，Relation的两个端点必须都存在于备份中，因为正常数据库外键已保证这一点。恢复校验要区分“历史视图缺来源的允许状态”和“当前关系悬空的非法状态”。

## 2. 导出一致性

在一个短只读事务读取所有需要数据至内存后结束事务，再序列化并测量输出字节。上限二十MiB。超过上限返回错误，不提供半截文件；不要为减少大小偷偷丢capturedText、关系理由或拒绝墓碑。大型库分批备份是后续能力，当前需要诚实给出上限。

captureRequestHash保留首次采集指纹，原文和来源人工编辑后不重算。备份没有保留首次来源的完整快照，因此导入只检查该指纹格式，不用当前rawText/sourceRef重算后误判合法编辑为损坏。它也不是防篡改签名，因为用户可编辑整个JSON。SHA256是检查传输/校验前后内容是否变化，不是证明来源可信。恢复始终把文件视为不可信输入，哪怕它带有同应用名字和正确哈希。

下载Content-Disposition使用固定文件名feini-brain-UTC日期.json；标题不进入文件路径。下载失败显示JSON错误，不把错误正文另存为看起来正常的备份。导出成功提示不包含Key，需要用户另外管理服务商凭据。

## 3. 导入两阶段

第一阶段validate只读：先流式限制二十MiB，再JSON解析和结构规模限制，再完整schema，再主键唯一、类型、关系方向、标签映射、版本、AST与来源格式。数值范围与普通API一致，不能借导入写入超过限制的标签或脚本图。最多一万Item、五万Relation、二百View。

validate报告recordCounts、bundleHash、warnings和错误路径。未知schemaVersion直接拒绝。目标知识库须无Item、Relation、View，词典孤立tag可以由受控逻辑检查后替换或拒绝；本方案选择**任何tags/itemTags非空也视为非空**，避免相同normalized但不同ID的歧义。Settings和Key可以存在并保留。

第二阶段commit收到同一bundle和expectedBundleHash，再次完整校验。打开BEGIN IMMEDIATE后重新检查空知识库以及不存在running模型操作，避免校验后被另一个窗口写入。按Item→Tag→ItemTag→Relation→View顺序插入，run引用为null；重算Item状态；更新datasetRevision；提交。任一步失败rollback，目标知识数据仍为空，Settings/Key不变。

如果目标有非知识的已结束Run可保留，运行历史不与导入资料强绑定；run.subjectId相同只作为旧日志，不影响当前lastRunId。当前运行禁止导入，避免旧响应提交到刚恢复的相同ID资料。导入不自动调用模型，不按导入条目数触发重新整理费用。

## 4. 恢复之后验证

成功不能只看“导入一万条”。至少比对总数、ID集合、rawText与capturedText、手工锁、审核墓碑、标签顺序、关系方向、视图AST、来源快照和missingSources行为。对数据库和Bundle归一化后进行白名单字段比较，忽略允许变化的运行状态、datasetRevision、空run引用。

打开几条含中文emoji与换行的Item，确认原文逐字保留；打开一张带已删除来源的旧图，确认它还可读且提示缺失；确认Key仍是目标机器原设置或未配置，而不是从备份偷偷恢复。关闭并重启本地服务再次读取，证明不是只存内存。

## 5. 文件级备份与JSON备份区别

JSON备份是跨机器恢复知识的数据交换格式；完整SQLite备份是包含本地秘密和内部表的运维副本。前者易检查和校验，后者需要保护整个文件。WAL模式有旁文件，活跃时只拷brain.db可能不包含最近提交。推荐日常用逻辑导出；文件副本用已验证的SQLite备份方法或完全停服后依照运维步骤复制。

不要把数据库放在正在自动同步的网盘目录，避免同一文件被多个设备竞争。备份失败不删除原库，恢复失败不自动重建原库。损坏库先只读保存原件，再在副本诊断；不得用“删掉.data重新启动”作为默认排错建议。
