# 规格包审计工具

运行 `python tools/audit_spec.py --root .`。工具只检查本规格包，不启动或宣称完成未来应用。默认检查相对文件链接、JSON、任务依赖和编号、API登记、初始任务状态、参考SQLite约束、来源/树/备份示例以及正文汉字数。

参考JSON Schema验证使用可选Python包jsonschema；未安装时标skipped而非passed。本次交付环境已经安装并实际执行。未来应用不依赖Python，这套工具只是文档维护辅助，不应放进Next运行链路。

计数将Markdown代码围栏内文本与普通正文分开，并排除交付审计和文件清单自身。它统计汉字码点，不把UTF-8字节当字数，也不将TypeScript、SQL、JSON和工具源文件纳入正文要求。各任务保留必要的公共执行约束，计数不是去重后独立论点数量。

当前SQL验证使用Python标准库所链接的SQLite执行参考迁移、约束、回滚与备份往返；这不代替目标Node24上的DatabaseSync、真实API、浏览器和外部模型测试。实施任务的结果必须另记在implementation/progress/evidence。
