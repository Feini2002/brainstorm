# 交付审计与字数统计

本文件记录本次实际执行的**规格包审计**。它不是未来应用的测试报告，不能用于宣称业务应用、目标 Node24、浏览器或真实模型连接已经验收。

## 交付体量

| 项目 | 实际统计 |
| --- | ---: |
| Markdown 文件总数（含本审计与文件索引） | 224 |
| 纳入正文统计的 Markdown 文件 | 222 |
| Markdown 全部汉字（含代码围栏内汉字） | 262,394 |
| 剔除代码块后的正文汉字 | **261,223** |
| 独立实施任务 | 84 |
| Gate 阶段 | 7 |
| 任务规则 ID | 504 |
| 具名任务验收场景 | 504 |
| HTTP method/path 契约 | 31 |
| 一手研究来源条目 | 32 |
| 初始数据库业务/基础表 | 9 |

计数口径：Unicode 汉字码点 U+3400–U+4DBF、U+4E00–U+9FFF；不使用 UTF-8 字节数代替字数。正文统计排除 Markdown fenced code blocks，也不将 JSON、SQL、TypeScript、Python、JavaScript 文件算作正文。本文与 FILE_INDEX.md 及 audit/ 下材料不计入字数要求。

分任务文档保留必要的公共边界，计数代表整包正文规模，不代表去重后独立论点数量。逐文件统计可在 [审计 JSON](audit/package_audit.json) 的 counts.files 查看。可用 [审计工具](tools/audit_spec.py) 重算。

## 本次实际检查

**通过 48 项；失败 0 项；跳过 0 项。**

相对文件链接检查：1392 relative file links resolve; URL fetch and heading anchors are outside this check。

任务依赖：84个唯一任务构成无环依赖图；每项规格与用例路径存在，504个规则ID和504个场景ID能定位。所有应用任务初始仍为not_started，没有将文档完成冒充代码完成。

JSON与Schema：参考JSON文件可解析；三份严格生成Schema通过定义检查，合法样例通过；模型试图额外输出rawText会被拒绝；脑图环与无依据因果样例被识别为非法。来源quote样例确实存在于相应原文。

SQLite：实际执行参考建表语句并检查九张表、Unicode保真、采集唯一键、枚举、STRICT字段、标签映射、关系自环/对称端点/审核约束、拒绝墓碑、全局单运行槽位、尝试次数上限、CAS、事务回滚、级联删除、foreign_key_check与integrity_check。

参考恢复：把完整Bundle样例插入SQLite，确认初始/当前原文、人工摘要锁、采集指纹、版本、过期状态、视图promptVersion/hash与引用保持；在恢复中途注入故障，知识数据完整回滚且原秘密设置仍保留。该验证针对参考数据和SQL，不代表未来HTTP导入实现已完成。

安全范围检查：压缩目录不含实际数据库、node_modules、.env或凭据文件。这是有限文件规则检查，不宣称替代全面秘密扫描或安全审计。研究来源URL没有在此工具中重新抓取，第三方运行包也没有在此阶段安装整合。

## 执行环境与未执行边界

本次规格审计使用 Python 3.13.5、SQLite 3.46.1。目标应用运行要求仍是 Node24 LTS >=24.15 且 <25。

生成环境当前 Node 为22.16.0。实际运行参考doctor脚本得到退出码2，正确拒绝不支持版本；因此没有把本环境说成已经通过Node24运行时验证。输出见 [doctor标准错误](audit/doctor_reference_stderr.txt)。

当前没有业务应用实现，所以未执行未来应用的lint、production build、Vitest业务测试、Playwright页面验收、目标Windows运行或真实LLM连接。那些任务须按G0–G6实施后分别填写证据。504项是具名验收**规格**，不是本次已通过的504项应用测试。

## 完整性与入口

[文件SHA-256清单](FILE_MANIFEST.json) 记录除清单自身之外每个交付文件的大小与摘要。ZIP外另提供归档SHA-256。校验摘要用于检测文件变化，不是数字签名。

阅读入口：[00_ROUTER.md](00_ROUTER.md)；实施约束：[AGENTS.md](AGENTS.md)；全部Markdown：[FILE_INDEX.md](FILE_INDEX.md)。
