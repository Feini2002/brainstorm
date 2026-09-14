# 本地安全、密钥输入与出站请求边界


## 1. 威胁模型先写清

本系统防护对象包括：用户误把服务暴露到局域网、恶意网站向 localhost 发跨站请求、笔记或模型输出携带脚本、日志与导出泄漏 Key、参数篡改覆盖资料。它不防护已经获得本机用户权限的恶意软件，也不承诺本机 SQLite 明文秘密在磁盘被盗时仍保密。单用户无登录不是“任何来源都可以访问本机 API”的同义词。

启动必须显式监听 127.0.0.1；APP_ORIGIN 严格匹配。不得把接口设置 Access-Control-Allow-Origin:*，不得在文档建议临时绑定0.0.0.0解决访问问题。需要手机或他人访问不是 MVP 小调整，而是新增认证、TLS、存储与部署边界的下一版。

## 2. 启动会话令牌

服务器进程启动时生成三十二字节密码学随机令牌，仅存在内存，重启更换，不存数据库。GET /api/session 先验证 Host，存在 Origin 时必须精确匹配；浏览器 Sec-Fetch-Site 若不是 same-origin/none 则拒绝，并禁止 CORS。成功返回令牌和进程会话 ID，no-store。这里的令牌不是 LLM API Key，也不是用户账户密码。

页面通过同源 fetch 获取令牌，保存在应用内存单例，请求时携带 X-Brain-Token。所有私人 GET 和所有 mutation 都验证它。mutation 另外要求精确 Origin、JSON Content-Type、正文大小。非浏览器测试客户端显式设置 Host/Origin/Token，不能为了方便 curl 把生产校验永久删掉。

服务重启后旧令牌收到403 SESSION_EXPIRED；客户端允许重新取 session，但不能自动重放刚才可能已经付费的生成操作。先查询已知 Run 或展示重试确认。只读 GET 可在一次重新 bootstrap 后重新读取；采集请求用原 captureRequestId 重放才能保证不重复。

session 不是面对本机恶意进程的强认证。其他本机进程可模仿 HTTP，这是已声明范围；用户电脑已经不可信时需要操作系统级防护。也不能把本方案的 HTTP 本地设计直接搬上公网并只保留一个启动令牌。

## 3. 密钥表单与持久化

LLMConfig 包含 adapter:'openai-compatible'、baseUrl、model、structuredMode:'prompt_json'|'json_object'、tokenField:'none'|'max_tokens'|'max_completion_tokens'、maxOutputTokens、schemaRepairEnabled。默认未配置状态 baseUrl/model 为空、tokenField=none、structuredMode=prompt_json、schemaRepairEnabled=false；先使用最小请求验证，再由用户显式开启 JSON 模式或一次格式修复。完整兼容支持不能依据供应商名字猜测。

Key 保存在 secrets 表 key='llm.api_key'，普通 settings.config_json 不含 Key。保存 config 与 Key 必须同事务，并增加同一个 settings.revision。keyAction=keep 不允许同时带 apiKey；replace 必须有一到4096 UTF-8字节的新值且无 CR/LF；delete 必须不带 apiKey。前端保存成功清空 password 输入。表单密码框的星号只属于浏览器显示，不是要提交的字符串。

用户明确同意“本地明文保存，不包含在逻辑备份”。首次配置提示足够，不每次保存弹四次确认。读 API 永远只返回 apiKeyConfigured。禁止调试时 console.log(formValues)、请求对象、fetch init、Headers、数据库 secrets 行。连接异常也不能拼上完整 header。测试使用显然不可用的标记秘密，并对日志和导出做全文扫描。

## 4. Base URL 规则

Base URL 必须能由 URL 解析，协议仅 https。拒绝 username/password、query、fragment、反斜杠混淆、空主机、明显 loopback/private IP literal、localhost 及其保留变体。MVP 不接 HTTP 本地推理地址；以后单独加入受控 local adapter，不能用户遇到限制就删全部校验。

保留合法路径前缀，去除末尾多余斜杠后追加 /chat/completions。不要自动给所有地址加 /v1，因为兼容服务可能有自己的版本路径。已经以 /chat/completions 结尾的输入拒绝并提示填写基础地址，防止重复路径。调用时 redirect:'error'，任何3xx都失败，不把 Authorization 随重定向带到另一站。

Base URL 的 origin 变化且使用 keep 时需要 confirmKeyTransfer=true；服务端再次检查，不只依赖 UI 按钮。路径变化仍使用同 origin，不强制新 Key，但显示最终 endpoint 便于用户核对。用户可以使用自己信任的 HTTPS 网关；应用不从笔记里的 URL、模型返回的 URL 或外部网页自动替换 endpoint。

这里是“用户选择受信目的地”的本地工具策略，不是完整对抗恶意 DNS 重绑定的 SSRF 沙箱。域名可能解析到私网的深层情况不应被错误宣传为全部阻止；若未来开放多人填写地址，需要采用解析、地址固定、出站代理或更严格允许清单，重新评审安全设计。

## 5. 浏览器和内容安全

原文、标题、错误提示使用 React 文本节点。Markdown/HTML 不作为普通卡片默认渲染入口。来源跳转只允许 http/https 并加 noopener/noreferrer；用户备注型 sourceRef 以文字显示。脑图与流程标签经过专门编译和净化；不要因为 React 默认转义就认为 dangerouslySetInnerHTML 仍天然安全。

CSP 可以作为经实测的防御层，但不能为通过开发 HMR 随手启用所有 unsafe-inline/unsafe-eval 并写“安全已完成”。本版硬要求是受限输入、无远端脚本加载、SVG净化、严格本地请求保护和秘密扫描；CSP 的生产配置要分别实测 Mermaid/Markmap所需样式，不预填未经验证的万能头。

## 6. 退出、备份与清理

清空 Key 与删除知识库是两件独立动作。设置页允许删除 Key 后继续离线记录和导出。逻辑备份不含 Key；完整数据库文件可能包含 Key，包括已删除秘密在历史页面或文件系统副本中的痕迹，不能把 SQL DELETE 宣传为磁盘安全擦除。普通 MVP 不实现安全擦盘，文档如实说明。

用户准备分享故障样例时，优先导出经过自己检查的最小 fixture，不上传整个 .data 目录。日志默认只记录 requestId/runId、错误码、阶段耗时、数量、哈希，不记录原文。诊断报告要有预览，展示模型地址时可只显示 host，避免暴露带租户信息的路径。
