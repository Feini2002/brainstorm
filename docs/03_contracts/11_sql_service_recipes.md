# SQLite服务实现配方：事务、CAS和幂等SQL


## 1. 连接与迁移

getDb仅在运行时被调用，首次计算BRAIN_DATA_DIR绝对路径、创建目录、打开DatabaseSync，设置foreign_keys=ON、journal_mode=WAL、busy_timeout=5000。单例键至少包括绝对数据库路径，HMR不能把测试库与用户库混用。数据库迁移检查user_version，0执行001_initial.sql并在同一事务设置user_version=1，失败rollback；高于应用已知版本则停止，不自行降级。

PRAGMA journal_mode可能需要在迁移事务之外设置；不把参考SQL文件里每条语句都包上一层重复BEGIN。服务提供withTransaction同步回调，回调不得返回Promise，检测到thenable立即报错并rollback。回调期间只执行数据库同步操作和纯计算，不读取网络、渲染或等待定时器。

```ts
function withTransaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const value = action();
    if (value && typeof (value as { then?: unknown }).then === 'function') {
      throw new Error('ASYNC_TRANSACTION_FORBIDDEN');
    }
    db.exec('COMMIT');
    return value;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
```

这是说明事务结构的参考片段，生产实现还需处理commit/rollback自身失败，不能让rollback错误覆盖原始诊断。不能嵌套调用同一连接的BEGIN；组合领域操作通过传递事务上下文或Repository低层函数进行，不为每个字段各开事务。

## 2. 采集

事务内先按capture_request_id查找。已存在且hash相同返回重放；hash不同返回冲突。不存在则INSERT完整初值，然后增加app_meta.dataset_revision。即便先查不存在，仍处理UNIQUE冲突，因为两个请求可能竞争。返回ItemDTO前重新读取该ID，确保标签映射和默认字段一致。

capture_request_hash只覆盖用户输入，不覆盖随机ID或时间。服务端生成UUID；客户端请求UUID用于动作身份，两者不可混为同一个字段。用户有意重复保存相同原文时新请求键能创建第二条；系统不按rawText哈希强制去重，因为相同句子在不同来源/时间可能是有意义的独立记录。

## 3. 乐观编辑

读取当前Item，校验expectedRevision，计算真实变化字段和manualFields。所有可更新列从固定白名单构建，SQL不能直接拼用户提供的列名。更新使用WHERE id=? AND revision=?，检查changes恰好1；否则冲突或不存在，不把零行更新返回成功。

```sql
UPDATE knowledge_items
SET raw_text=?, raw_version=?, title=?, summary=?, type=?,
    keywords_json=?, importance=?, manual_fields_json=?,
    source_type=?, source_ref=?, revision=revision+1, updated_at=?
WHERE id=? AND revision=?;
```

标签修改与上述UPDATE同事务：规范化每个标签、复用或插入tags、重建目标item_tags顺序，不删除别的Item映射。不要用整库DELETE item_tags。没有真实变化时跳过UPDATE和datasetRevision，保留原时间；用户点击保存不等于领域数据必然改变。

## 4. Run与并发

先处理过期运行，再插入running Run。全局部分唯一索引确保不能同时存在两个running。不要只用JavaScript let isBusy，因为HMR和测试连接会绕过它。插入失败的事务不更新Item processing，不留下“忙碌但没有Run”的状态。

请求开始前使用UPDATE ai_runs SET attempt_count=attempt_count+1 WHERE id=? AND state='running' AND attempt_count<2。检查更改行数和操作deadline，然后调用fetch。若用户在请求发出前改变配置版本，停止该次尚未发送的请求；已发出的请求可能仍完成，结果记录原配置快照，不默默切换到新服务商。第二次格式修复也重新检查当前配置版本和剩余期限，不能继续使用已删除Key发新请求。

最后应用先读Run与Item快照。Run状态修改采用WHERE state='running'的条件；Run若已被恢复标interrupted，迟到模型不能将它写成succeeded。领域UPDATE与Run终态、关系、datasetRevision同事务，不先返回200再异步写成功。

## 5. 关系upsert

先把对称类型端点、版本规范化，再按source_id,target_id,relation_type查。若现有manual或accepted或rejected，AI建议不改它；若现有suggested并版本仍一致，允许更新其score/reason/evidence，revision+1；否则INSERT。不要用通用INSERT ... ON CONFLICT DO UPDATE无条件覆盖人工审核。

用户createManual命中现有建议时，明确UPDATE origin=manual,review_status=accepted,score=NULL，并以当前端点版本保存；这是用户确认动作，不是模型自提权。用户reject只改AI记录，保留规范唯一键；以后AI相同建议读到墓碑必须跳过。

删除Item依赖foreign_keys的ON DELETE CASCADE删除Relation和item_tags。删除View不触发Item删除。保留ai_runs.subject_id文字作为历史定位，不设置会级联删历史的外键；最终提交时自行检查Item存在。

## 6. 备份读取与恢复写入

逻辑导出使用只读事务读取所有白名单表到安全内存结构，然后结束事务再序列化。大文件超过限制直接拒绝，不在数据库锁持有期间等待浏览器下载。JSON对象构造不得包含secrets/settings/api_runs，尤其不能遍历sqlite_master导出所有表。

恢复写入前完整校验并计算bundleHash，BEGIN IMMEDIATE后再查Item、Tag、ItemTag、Relation、View是否为空和是否有running Run。按依赖顺序插入，故障注入在Relation阶段应让前面所有Item/Tag都回滚。不要用一行一事务“尽量恢复”，那样不满足空库全包恢复契约。

## 7. 检查语句

PRAGMA foreign_key_check用于验证当前引用没有悬空，PRAGMA integrity_check用于文件结构检查，两者不是同一件事。查询user_version确认迁移，不根据数据库文件存在推断schema正确。SQL测试用隔离临时库，禁止在用户.data上执行DROP、VACUUM或用于制造损坏的语句。

数据库操作全部参数化。为了查询性能可以建立固定索引，但不让用户输入ORDER BY列名或SQL片段。同步DatabaseSync适合此单机小规模方案，不意味着无限数据读取没有主线程代价；对列表、Graph、模型候选分别限量，避免一个API把整库当DTO返回。
