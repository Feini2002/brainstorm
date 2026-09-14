# 从空仓库到可运行工程：安装、下载与首次启动


## 1. 先区分已经收到的文件

当前仓库最初只有规格包，没有package.json应用、src实现或可运行UI。不要看到README就尝试npm start并把“找不到package.json”当产品缺陷。首先按G0生成工程，再逐步实现。解压后保留文档目录，不一次性把所有Markdown输入到模型上下文；先读总纲和当前任务。

目标机器需Node 24 LTS，最低24.15且小于25；npm随所选Node发行包安装。包版本与系统路径需要实际记录，不默认用户装了正确版本。Git用于版本管理；VS Code或其他编辑器仅为可选工具。应用不要求Python、Docker、数据库服务器或额外Redis。本文档包自带Python审计工具是**文档审计可选工具**，不是应用运行依赖。

安装Node后打开新终端，执行node --version、npm --version、where.exe node（Windows）或command -v node（类Unix）。PATH里存在多个Node时先修正到受支持版本。不要用一个终端的版本推断另一个IDE内终端也相同。

## 2. 脚手架不能覆盖规格

规范包所在根目录已经非空，直接create-next-app .可能因冲突失败。采用安全方式：在系统临时目录建立一个新的feini-brain脚手架，确认命令成功后只复制应用所需文件到目标仓库。保留目标AGENTS.md、00_ROUTER.md、docs、reference、implementation与tools；脚手架自己的README另存为实现说明，不覆盖入口。

```sh
npx create-next-app@16 feini-brain --ts --tailwind --eslint --app --src-dir --use-npm --import-alias "@/*" --yes
```

在临时目录运行，不在已有feini-brain仓库内再无意识创建同名嵌套应用。需要复制package.json、package-lock.json、src、public、tsconfig与Next/ESLint/PostCSS配置等；不复制node_modules、.next和.git。复制前人工列出目标已有同名文件，避免无提示覆盖。业务最终仍位于根目录src，所有任务路径保持一致。

本命令锁定Next16系列而非未经审查的未来主版本。首次完成后记录解析的精确Next/React版本，后续提交lock文件。禁止每次启动npx latest重新解析一套依赖。

## 3. 运行依赖与开发依赖

```sh
npm install zod@4 @xyflow/react @dagrejs/dagre markmap-lib markmap-view mermaid dompurify server-only
npm install -D vitest @playwright/test
```

脚手架已提供next、react、react-dom、typescript、eslint和Tailwind相关包。检查实际版本后再补类型包，不能对已有types的库无理由安装重复@types包。Dagre如果所锁版本未提供所需声明，再依据包声明选择兼容类型包或局部严谨声明，并记录原因。

Tailwind使用当前所选脚手架的同代PostCSS配置，不照旧教程再运行一套v3 init导致v4插件冲突。修改全局CSS时保留正确入口指令。若安装出现peer dependency冲突，读取具体约束并调整精确版本，不把--force或--legacy-peer-deps作为永久默认策略。

安装后保存npm ls --depth=0、npm版本、Node版本、package-lock hash到运行报告。以后干净重装使用npm ci，不能手删lock后重新npm install再宣称原依赖树已复现。npm audit输出记录已知风险与影响，不仅看漏洞总数；修复前检查是否引入主版本变化。

## 4. 开发启动脚本

package scripts至少具有doctor、dev、build、start、lint、typecheck、test:unit、test:integration、test:e2e、check。dev和start明确绑定127.0.0.1，端口3000。doctor在实际启动前检查Node版本和临时SQLite读写；不能在build过程中迁移用户库。

```json
{
  "scripts": {
    "doctor": "node scripts/doctor.mjs",
    "dev": "node scripts/doctor.mjs && next dev -H 127.0.0.1 -p 3000",
    "build": "next build",
    "start": "node scripts/doctor.mjs && next start -H 127.0.0.1 -p 3000",
    "lint": "eslint .",
    "typecheck": "next typegen && tsc --noEmit",
    "test:unit": "vitest run --project unit",
    "test:integration": "vitest run --project integration",
    "test:e2e": "playwright test",
    "check": "npm run lint && npm run typecheck && npm run test:unit && npm run test:integration"
  }
}
```

这些是目标脚本契约。Vitest项目名必须在实际配置定义；不能只复制scripts却未建立unit/integration projects。Next typegen的可用性在所锁版本验证，调整时记录而不删类型检查。ESLint独立运行，不把next build当lint。Windows npm默认shell支持这里的顺序&&，环境变量跨平台注入则用Node启动包装而非依赖Unix语法。

## 5. 首次数据库与设置

默认用户数据目录为仓库根.data，禁止提交Git。BRAIN_DATA_DIR可以通过服务端环境变量覆盖，必须解析为绝对路径并明确当前模式。创建数据库是首次运行访问getDb时发生，不是import时发生；.data不存在则mkdir，目录不可写时说明权限和路径，不自动换到未知临时目录存用户资料。

打开 http://127.0.0.1:3000 先看到Inbox，无Key也能记录。进入Settings填写Base URL、Model、Key，测试当前草稿，再保存；也允许先保存后测试，但文案不混淆两个状态。Base URL填写服务商提供的基础地址，不能填完整chat/completions端点。模型名不提供未经验证的硬编码“最新模型”默认值。

## 6. 测试浏览器下载

```sh
npx playwright install chromium
```

Playwright npm包和浏览器二进制分开下载。浏览器缺失错误不能靠添加sleep解决。Linux某些环境需要系统依赖安装，按实际权限和官方步骤处理；Windows避免假定Linux的apt存在。网络代理或证书失败必须报告真实阻塞，不能关闭TLS校验作为长期修复。

测试运行时使用临时BRAIN_DATA_DIR和独立端口，不连接默认.data。端到端测试由webServer配置启动隔离实例并结束后关闭；已有用户服务占端口时不要杀掉用户进程，改测试端口并保持对应APP_ORIGIN一致。

## 7. 日常与生产模式

开发调试使用npm run dev；日常固定版本使用npm run build后npm run start。不要同时启动两进程指向同一库，不把dev和start当可以共同写入的高可用集群。关闭前有运行中操作时提示可能中断，但不阻止用户终止进程。

升级先导出知识并备份，拉取代码后npm ci，运行测试和build，启动后检查迁移版本。出现迁移失败保留原数据，不删库重建。没有云端部署指南：Cloudflare Pages、无持久磁盘函数服务或多副本部署不符合此版本的SQLite单机前提。
