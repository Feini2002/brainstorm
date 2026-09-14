# 84个实施任务总索引


按依赖而非页面截图判断完成。每项附六个具名验收场景；机器登记见 [tasks.json](../../reference/contracts/tasks.json)。

| 编号 | Gate | 工作 | 前置 |
| --- | --- | --- | --- |
| [T001](G0/T001_runtime.md) | G0 | 运行时预检与系统边界 | 无 |
| [T002](G0/T002_dependencies.md) | G0 | 依赖解析、锁定与下载 | T001 |
| [T003](G0/T003_repo_boundaries.md) | G0 | 工程目录与服务端隔离 | T002 |
| [T004](G0/T004_startup_scripts.md) | G0 | 启动脚本、回环监听与退出 | T003 |
| [T005](G0/T005_app_shell.md) | G0 | 六页应用骨架与导航状态 | T004 |
| [T006](G0/T006_api_envelope.md) | G0 | 统一响应、错误与前端请求器 | T003, T005 |
| [T007](G0/T007_local_security.md) | G0 | 本地请求令牌与来源防护 | T004, T006 |
| [T008](G0/T008_database_runtime.md) | G0 | 数据路径、连接与文件生命周期 | T001, T003, T007 |
| [T009](G0/T009_migrations.md) | G0 | 初始迁移与数据库约束 | T008 |
| [T010](G0/T010_repositories.md) | G0 | Repository 与 DTO 解码 | T006, T009 |
| [T011](G0/T011_test_harness.md) | G0 | 隔离测试环境与模型替身 | T002, T008, T010 |
| [T012](G0/T012_contract_guard.md) | G0 | 契约一致性与第一阶段验收 | T001, T002, T003, T004, T005, T006, T007, T008, T009, T010, T011 |
| [T013](G1/T013_capture_ui.md) | G1 | 极简输入框与中文输入体验 | T005, T006, T012 |
| [T014](G1/T014_capture_api.md) | G1 | 保存接口与采集幂等 | T010, T013 |
| [T015](G1/T015_timeline_cards.md) | G1 | 收件箱时间线与知识卡片 | T014 |
| [T016](G1/T016_library_query.md) | G1 | 资料库搜索、过滤与分页 | T010, T015 |
| [T017](G1/T017_tag_dictionary.md) | G1 | 标签规范化与关联维护 | T010, T016 |
| [T018](G1/T018_item_details.md) | G1 | 详情抽屉、原文和来源回溯 | T015, T016, T017 |
| [T019](G1/T019_edit_versions.md) | G1 | 人工编辑、版本冲突与字段保护 | T018 |
| [T020](G1/T020_delete_item.md) | G1 | 删除确认与引用失效 | T019 |
| [T021](G1/T021_selection.md) | G1 | 跨视图材料选择与数量预算 | T016, T018, T020 |
| [T022](G1/T022_manual_relations.md) | G1 | 人工关系创建与方向语义 | T017, T018, T019 |
| [T023](G1/T023_relation_review.md) | G1 | 关系审核、拒绝记忆与人工优先 | T022 |
| [T024](G1/T024_offline_crud.md) | G1 | 无Key与断网可用路径 | T014, T016, T019, T020, T022 |
| [T025](G1/T025_save_feedback.md) | G1 | 保存反馈、草稿与未知完成状态 | T013, T014, T019, T024 |
| [T026](G1/T026_crud_acceptance.md) | G1 | 离线知识库闭环验收 | T013, T014, T015, T016, T017, T018, T019, T020, T021, T022, T023, T024, T025 |
| [T027](G2/T027_settings_ui.md) | G2 | 模型设置表单与Key输入口 | T007, T026 |
| [T028](G2/T028_endpoint_policy.md) | G2 | Base URL规范化与出站信任边界 | T027 |
| [T029](G2/T029_secret_storage.md) | G2 | 设置事务、秘密隔离与读取白名单 | T010, T027, T028 |
| [T030](G2/T030_redaction.md) | G2 | 模型错误脱敏与安全日志 | T006, T029 |
| [T031](G2/T031_llm_transport.md) | G2 | OpenAI兼容HTTP适配器 | T028, T029, T030 |
| [T032](G2/T032_connection_test.md) | G2 | 连接测试与能力验证 | T031 |
| [T033](G2/T033_prompts.md) | G2 | 整理提示词与不可信材料隔离 | T031, T032 |
| [T034](G2/T034_candidate_search.md) | G2 | 中文候选召回与上下文预算 | T016, T017, T033 |
| [T035](G2/T035_run_registration.md) | G2 | 运行注册、幂等和并发占用 | T029, T034 |
| [T036](G2/T036_organize_orchestration.md) | G2 | 整理主流程与事务切点 | T033, T034, T035 |
| [T037](G2/T037_structured_parse.md) | G2 | 结构化解析、限长与一次修复 | T031, T033, T036 |
| [T038](G2/T038_metadata_apply.md) | G2 | 整理字段应用与人工保护 | T019, T037 |
| [T039](G2/T039_relation_apply.md) | G2 | AI关系证据、去重与拒绝保护 | T023, T034, T037, T038 |
| [T040](G2/T040_run_recovery.md) | G2 | 运行恢复、迟到响应与局部轮询 | T035, T036, T039 |
| [T041](G2/T041_llm_diagnostics.md) | G2 | 模型用量、输入范围与错误诊断 | T030, T032, T040 |
| [T042](G2/T042_ai_acceptance.md) | G2 | AI闭环与真实连接验收 | T027, T028, T029, T030, T031, T032, T033, T034, T035, T036, T037, T038, T039, T040, T041 |
| [T043](G3/T043_graph_query.md) | G3 | 图谱读取接口与子图范围 | T022, T023, T039, T042 |
| [T044](G3/T044_graph_adapter.md) | G3 | 领域图到React Flow适配 | T043 |
| [T045](G3/T045_reactflow_canvas.md) | G3 | 关系画布、自定义节点与容器 | T044 |
| [T046](G3/T046_dagre_layout.md) | G3 | Dagre布局、尺寸与坐标转换 | T045 |
| [T047](G3/T047_layout_persistence.md) | G3 | 图位置保存与布局版本冲突 | T010, T046 |
| [T048](G3/T048_graph_filters.md) | G3 | 图筛选、关系阈值与选择稳定性 | T043, T047 |
| [T049](G3/T049_graph_interactions.md) | G3 | 节点详情与关系审核交互 | T018, T023, T048 |
| [T050](G3/T050_graph_readability.md) | G3 | 大图降级、无障碍与可读性 | T049 |
| [T051](G3/T051_graph_staleness.md) | G3 | 关系依据失效与图视图一致性 | T019, T039, T050 |
| [T052](G3/T052_graph_acceptance.md) | G3 | 关系图集成验收与组件替换边界 | T043, T044, T045, T046, T047, T048, T049, T050, T051 |
| [T053](G4/T053_view_repository.md) | G4 | 保存视图的公共API与类型契约 | T010, T047, T052 |
| [T054](G4/T054_source_snapshot.md) | G4 | 来源选择快照、版本和哈希 | T021, T051, T053 |
| [T055](G4/T055_mindmap_generation.md) | G4 | 脑图生成任务与树结构提示词 | T033, T035, T037, T054 |
| [T056](G4/T056_mindmap_compiler.md) | G4 | 树校验与安全Markdown编译 | T055 |
| [T057](G4/T057_markmap_renderer.md) | G4 | Markmap挂载、净化与本地资源 | T056 |
| [T058](G4/T058_mindmap_sources.md) | G4 | 脑图大纲、来源映射与回跳 | T018, T057 |
| [T059](G4/T059_view_regeneration.md) | G4 | 视图过期、再生成与历史保留 | T053, T054, T058 |
| [T060](G4/T060_mindmap_export.md) | G4 | 脑图Markdown与JSON导出 | T056, T059 |
| [T061](G4/T061_mindmap_acceptance.md) | G4 | 脑图从材料到导出的闭环验收 | T053, T054, T055, T056, T057, T058, T059, T060 |
| [T062](G5/T062_flow_intent.md) | G5 | 流程视图意图输入与材料确认 | T021, T053, T061 |
| [T063](G5/T063_flow_document.md) | G5 | 流程节点、边类型与证据契约 | T054, T062 |
| [T064](G5/T064_flow_compiler.md) | G5 | 受限Flow到Mermaid编译器 | T063 |
| [T065](G5/T065_mermaid_renderer.md) | G5 | Mermaid严格渲染与SVG净化 | T064 |
| [T066](G5/T066_flow_lifecycle.md) | G5 | 异步渲染竞争、尺寸和降级 | T065 |
| [T067](G5/T067_flow_history.md) | G5 | 流程视图保存、来源和新鲜度 | T053, T054, T059, T066 |
| [T068](G5/T068_flow_export.md) | G5 | 流程源码、JSON与安全SVG导出 | T060, T065, T067 |
| [T069](G5/T069_flow_acceptance.md) | G5 | 流程可视化与逻辑保真验收 | T062, T063, T064, T065, T066, T067, T068 |
| [T070](G6/T070_full_export.md) | G6 | 整库逻辑导出与秘密白名单 | T010, T053, T069 |
| [T071](G6/T071_import_validation.md) | G6 | 恢复文件校验与空库策略 | T070 |
| [T072](G6/T072_import_commit.md) | G6 | 恢复事务、引用重建与回滚 | T071 |
| [T073](G6/T073_backup_recovery.md) | G6 | WAL备份、数据搬迁与损坏恢复说明 | T070, T072 |
| [T074](G6/T074_diagnostics.md) | G6 | 本地诊断与可观测性 | T030, T041, T073 |
| [T075](G6/T075_security_regression.md) | G6 | 密钥、跨站与渲染安全回归 | T007, T028, T030, T057, T065, T070, T074 |
| [T076](G6/T076_unit_suite.md) | G6 | 领域单元测试与边界矩阵 | T037, T056, T064, T075 |
| [T077](G6/T077_api_suite.md) | G6 | API与SQLite集成测试 | T070, T071, T072, T076 |
| [T078](G6/T078_e2e_suite.md) | G6 | 六页浏览器端到端验收 | T077 |
| [T079](G6/T079_performance.md) | G6 | 加载、查询与图形性能预算 | T050, T057, T066, T078 |
| [T080](G6/T080_windows_runbook.md) | G6 | Windows安装、启动与故障手册 | T001, T002, T004, T073, T079 |
| [T081](G6/T081_production_audit.md) | G6 | 生产构建、依赖审计与发布材料 | T075, T078, T079, T080 |
| [T082](G6/T082_ux_quality.md) | G6 | 中文文案、状态与无障碍终审 | T078, T081 |
| [T083](G6/T083_release_evidence.md) | G6 | 任务证据、缺陷清单与交付状态 | T076, T077, T078, T079, T080, T081, T082 |
| [T084](G6/T084_final_acceptance.md) | G6 | 最终用户旅程与MVP完成定义 | T083 |
