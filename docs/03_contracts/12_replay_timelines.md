# 六个跨模块时序反例：请求身份与提交边界


## 时序A：成功整理后的原请求重放

起点Item I revision=1。客户端发requestKey=K、expectedRevision=1。服务器登记Run R、发一次模型请求、成功提交Item revision=2，R=succeeded；成功响应在网络中丢失。客户端用同一K和expectedRevision=1重发。

正确行为：按请求格式算稳定requestHash，先查K，发现是同一个已经成功的R，返回R和I，不再发模型。错误行为：先读取I发现revision=2，与expectedRevision=1不符，于是返回409，或者用新配置计算另一个hash。这个反例必须单独测试，普通“连续点两次按钮”不一定覆盖它。

## 时序B：原请求进行中，用户编辑了标题

R登记时revision=1，模型请求已发出。用户把title人工改为X，Item revision=2，manualFields含title。模型返回title=Y、summary=Z。

正确行为：最终事务发现revision改变，R=conflict，不应用任何模型字段，不清除人工锁；原文仍在。不要做“只跳过title、其他字段照写”的局部猜测合并，因为用户刚改变的意图可能影响其他字段。用户下一次显式重整产生新K与新快照。

## 时序C：超时恢复与迟到模型响应竞争

R.startedAt=T0，deadlineAt=T0+180秒。进程暂停或网络处理异常。恢复在租约后把R置interrupted。旧请求又返回成功文本。

正确行为：提交用WHERE state='running'条件，发现R已经终态，丢弃迟到结果，外部请求不会再次启动。错误行为：无条件UPDATE Run succeeded，或者先写Item再发现Run不能更新。数据和Run必须同一个提交事务。

## 时序D：用户更换了模型Key

R注册使用配置revision=5，第一轮请求已发到用户原先信任的endpoint。用户保存新配置revision=6或删除Key。旧请求可能完成，系统不能承诺删除Key能取消远端处理。

如果第一轮结果有效且资料版本仍匹配，可以按原配置快照完成，Run明确记录revision5。如果第一轮需要第二次格式修复，发出新请求前发现配置已变，不继续用旧Key请求，也不切换成新Key替旧Run继续跑；终结为配置冲突并让用户显式新建操作。正在发出的请求与尚未发送的下一次请求要区别对待。

## 时序E：恢复文件校验后知识库变成非空

用户上传合法Bundle，validate返回hash H和可恢复。另一个窗口随后保存一条新笔记。用户点击恢复。

正确行为：commit再校验Bundle与hash，BEGIN IMMEDIATE后重查目标知识表，发现非空，返回409并保持原新笔记。错误行为：相信前端valid=true，先清空库再导入。validate是说明，不是允许未来无条件破坏数据的令牌。

## 时序F：生成图之后修改原文

用户选择I1/I2生成View V，保存来源revision1。后来I1.rawText改变，rawVersion与revision都增加。打开V仍显示当时生成内容，但isStale=true，来源面板指出I1已变。点击重新生成创建V2，不覆盖V。

正确行为：历史观察方式与当前知识分离，旧图不会反向更新I1；缺失来源时也不从图节点文字重建Item。Graph与Mindmap不同：Graph节点文字从当前库读取、位置保留，生成脑图则保留其历史AST并提示过期。两者都不能悄悄装作一直反映最新原文。

## 边界说明：删除后的采集键

MVP采集幂等记录随Item保存，删除Item后该采集键不再作为永久墓碑存在。客户端删除成功必须清理相关保存动作状态，不无限自动重放旧采集POST。应用保证运行中的AI不会复活已删除资料；不额外承诺跨永久删除的无限期采集幂等。需要长久操作墓碑时应单独设计保留期限和存储，不把当前实现能力夸大。
