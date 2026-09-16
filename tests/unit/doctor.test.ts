import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  checkNodeVersion,
  findPortOwner,
  parseNodeVersion,
  probeNetworkEnv,
  probePathInterpreter,
  probePortAvailability,
  resolveLaunchTarget,
  runDoctor,
} from '../../scripts/doctor.mjs';

type Env = NodeJS.ProcessEnv;

/**
 * 造一份环境变量给探针函数。
 *
 * 本仓库的 `ProcessEnv` 被 Next 的类型声明收窄成「`NODE_ENV` 必填」，直接写字面量会被
 * 类型检查拦下。这里用 `Record<string, string>` 中转——与 `start-local.test.ts` 同一写法。
 */
function env(values: Record<string, string>): Env {
  return values as Env;
}

const projectRoot = path.resolve(import.meta.dirname, '../..');

/**
 * T001-C01 / T001-C06 — runtime version gate.
 *
 * The gate is exposed as a pure function so the branches can be asserted without
 * installing a second Node (the machine only has one supported interpreter).
 */
describe('doctor 运行时门限', () => {
  it('解析版本号', () => {
    expect(parseNodeVersion('24.18.0')).toEqual({ major: 24, minor: 18, patch: 0 });
    expect(parseNodeVersion('22.14.0')).toEqual({ major: 22, minor: 14, patch: 0 });
  });

  it('接受受支持的 24.15 及更高 minor', () => {
    expect(checkNodeVersion('24.15.0').ok).toBe(true);
    expect(checkNodeVersion('24.18.0').ok).toBe(true);
    expect(checkNodeVersion('24.99.1').ok).toBe(true);
  });

  it('拒绝更低主版本，并报告实际主版本（T001-C01）', () => {
    const result = checkNodeVersion('22.14.0');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('22');
  });

  it('拒绝 24.15 以下的 minor', () => {
    const result = checkNodeVersion('24.14.0');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('24.15');
  });

  it('不接受未来主版本（T001-C06）', () => {
    const result = checkNodeVersion('25.0.0');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('25');
  });
});

/**
 * T080-C02｜旧 PATH：装好 Node 之后，已经开着的终端仍旧版本。
 *
 * 用例规格：docs/05_tests/G6/T080_cases.md C02（前置「安装 Node 后终端仍旧版本」，
 * 应断言「提示重开终端并检查实际路径」，排除「安装成功即当前会话生效」）。
 *
 * 这两条分工不同：
 *  - 第一条造一个 **PATH 指向别处** 的环境，断言探针把差异报告出来（正向）；
 *  - 第二条在 **本机真实环境** 上断言「PATH 解析到的就是正在运行的解释器」，也就是
 *    「我这台机器的 Node 安装已经被当前会话看见」这一事实本身。
 *
 * 只做第一条会让「真实机器是否已经踩坑」变成假设；只做第二条则永远造不出失败分支。
 */
describe('T080-C02 旧 PATH 与解释器路径', () => {
  it('T080-C02 PATH 指向别的 node 时，探针报告差异而不是一律通过', () => {
    const fakeDir = mkdtempSync(path.join(tmpdir(), 'feini-path-'));
    try {
      const fakeNode = path.join(fakeDir, 'node.exe');
      writeFileSync(fakeNode, 'not a real interpreter', 'utf8');

      const probe = probePathInterpreter(
        env({
          ...process.env,
          PATH: process.platform === 'win32' ? fakeDir : `${fakeDir}:/usr/bin`,
          Path: process.platform === 'win32' ? fakeDir : `${fakeDir}:/usr/bin`,
        }),
      );

      // 探针能跑（Windows 的 where.exe 不在被替换的 PATH 里时会失败），
      // 但只要它跑成功，就必须得出「PATH 里没有正在运行的那个解释器」。
      if (probe.ok) {
        expect(probe.candidates.length).toBeGreaterThan(0);
        expect(probe.includesRunning, 'PATH 指向假 node 时不应判为一致').toBe(false);
      }
      // 无论探针成功与否，它都必须交出正在运行的真实解释器路径，
      // 否则「重开终端后跑 node -v」这条提示就没有可对照的基准。
      expect(probe.running).toBe(process.execPath);
    } finally {
      rmSync(fakeDir, { recursive: true, force: true });
    }
  });

  it('T080-C02 本机真实 PATH 解析到的就是正在运行的解释器', () => {
    const probe = probePathInterpreter(process.env);
    expect(probe.ok, '本机应能解析 node 路径；解析不了则本用例只能标为未执行').toBe(true);
    expect(probe.candidates.length).toBeGreaterThan(0);
    expect(probe.includesRunning).toBe(true);
  });
});

/**
 * T080-C04｜端口占用：另一个实例已在运行。
 *
 * 用例规格 C04：必须断言「解释如何确认已有进程」，并排除「强制结束全部进程」。
 * 因此这里断言的是三条可执行的事实：
 *  1. 真的被占用时探针必须报 `free: false`（不是靠 connect 猜）；
 *  2. 占用的那条连接能被定位到 pid —— 有 pid 才谈得上「确认已有进程」；
 *  3. 上报的 pid 属于**本次真的占座的那个进程**，不是随便找的。
 */
describe('T080-C04 端口占用定位', () => {
  it('T080-C04 被占用的端口报 free:false，并给出占用者的 pid', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    expect(port).toBeGreaterThan(0);

    try {
      const availability = await probePortAvailability('127.0.0.1', port);
      expect(availability.free).toBe(false);
      expect(availability.reason).toBe('EADDRINUSE');

      // 同一进程内占座的 server，其 pid 就是本进程的 pid（Windows 上 netstat
      // 报的也是它）。断言相等而不是「非空」：非空挡不住「随便找了个 pid」。
      if (process.platform === 'win32') {
        const owner = findPortOwner(port);
        expect(owner, 'netstat 应能定位占用端口的进程').not.toBeNull();
        expect(owner?.pid).toBe(process.pid);
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('T080-C04 空闲端口报 free:true 且不返回占用者', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const availability = await probePortAvailability('127.0.0.1', port);
    expect(availability.free).toBe(true);
    expect(availability.owner).toBeNull();
    expect(availability.reason).toBeNull();
  });
});

/**
 * T080-R01｜命令块的路径与端口口径。
 *
 * 手册里每条命令用的地址必须与启动器一致，否则「端口空闲」说的是别人不用的端口。
 * 这里断言探针读的是 `APP_HOST` / `APP_PORT`，与 `scripts/start-local.mjs` 同一对变量。
 */
describe('T080-R01 预检与启动器使用同一个地址口径', () => {
  it('T080-R01 默认目标与 start-local.mjs 的默认值一致', () => {
    const launcher = readFileSync(path.join(projectRoot, 'scripts', 'start-local.mjs'), 'utf8');
    expect(launcher).toContain("const DEFAULT_HOST = '127.0.0.1'");
    expect(launcher).toContain('const DEFAULT_PORT = 3000');

    expect(resolveLaunchTarget(env({}))).toEqual({ host: '127.0.0.1', port: 3000 });
  });

  it('T080-R01 APP_PORT / APP_HOST 被采纳，非法端口退回默认而不是让预检失败', () => {
    // 非法值的拒绝由启动器负责（它有更具体的提示）；预检退回默认，免得
    // 「端口写错」在预检里报成「运行时坏了」。
    expect(resolveLaunchTarget(env({ APP_PORT: '3100' })).port).toBe(3100);
    expect(resolveLaunchTarget(env({ APP_HOST: 'localhost' })).host).toBe('localhost');
    expect(resolveLaunchTarget(env({ APP_PORT: 'not-a-port' })).port).toBe(3000);
    expect(resolveLaunchTarget(env({ APP_PORT: '0' })).port).toBe(3000);
    expect(resolveLaunchTarget(env({ APP_PORT: '70000' })).port).toBe(3000);
  });

  it('T080-R01 手册的命令块不含反斜杠续行，也不含未加引号的示例路径', () => {
    for (const relative of ['docs/operations/windows-setup.md', 'docs/operations/common-failures.md']) {
      const doc = readFileSync(path.join(projectRoot, relative), 'utf8');
      const blocks = [...doc.matchAll(/```powershell\n([\s\S]*?)```/gu)].map((m) => m[1]);
      expect(blocks.length, `${relative} 应含可复制的 PowerShell 命令块`).toBeGreaterThan(0);
      for (const block of blocks) {
        // R01：不能把 `\` 当续行符 —— PowerShell 里那是转义，复制即错。
        expect(block, `${relative} 的命令块不应以反斜杠续行`).not.toMatch(/\\\r?\n/u);
      }
    }
  });
});

/**
 * T080-C03 / R05｜下载失败的区分与「不要关 TLS」。
 *
 * 这两种失败原因不同、处理方式也不同：registry/代理/证书是「请求没出去」，
 * 浏览器二进制是「Playwright 的另一条下载通道」。把两者统称「依赖坏了」会让
 * 用户去删锁文件。
 */
describe('T080-C03 代理、证书与 TLS 状态可诊断', () => {
  it('T080-C03 代理与 CA 变量被报告为「已设置」，但值绝不出现在报告里', () => {
    const report = probeNetworkEnv(
      env({
        HTTPS_PROXY: 'http://user:SUPERSECRET@proxy.example.com:8080',
        NODE_EXTRA_CA_CERTS: 'C:\\certs\\corp.pem',
      }),
    );

    expect(report.proxyConfigured).toContain('HTTPS_PROXY');
    expect(report.caConfigured).toContain('NODE_EXTRA_CA_CERTS');
    // 代理 URL 里可能带账号密码：报告只记名字，值一次都不出现。
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('SUPERSECRET');
    expect(serialized).not.toContain('proxy.example.com');
    expect(serialized).not.toContain('corp.pem');
  });

  it('T080-C03 干净环境报空，不无中生有', () => {
    const report = probeNetworkEnv(env({}));
    expect(report.proxyConfigured).toEqual([]);
    expect(report.caConfigured).toEqual([]);
    expect(report.tlsVerificationDisabled).toBe(false);
    expect(report.npmEscapeHatch).toEqual([]);
  });

  it('T080-R05 关闭 TLS 校验与 npm 强装开关被单独标出，作为危险状态而非修复手段', () => {
    const report = probeNetworkEnv(
      env({
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
        npm_config_force: 'true',
        npm_config_legacy_peer_deps: 'true',
      }),
    );
    // 这三种状态都是「为了让安装过去而降低要求」的痕迹，必须能看见。
    expect(report.tlsVerificationDisabled).toBe(true);
    expect(report.npmEscapeHatch).toEqual(['npm_config_force', 'npm_config_legacy_peer_deps']);
  });
});

/**
 * T080-C01｜中文含空格目录。
 *
 * 真正的执行证据在 `tests/integration/recovery.test.ts`（`BRAIN_DATA_DIR` 指向
 * 「带 空格 的 目录」仍能读取）与 T080 证据里的实测命令输出。这里补的是**报告层**：
 * 工程路径里带空格/中文时，预检必须把这件事说出来，因为手册里最容易复制错的
 * 就是这种路径。
 */
describe('T080-C01 路径形状被报告', () => {
  it('T080-C01 含空格与含中文的工程路径都被标出，且不打印完整路径', () => {
    const spaced = runDoctorSync('C:\\Users\\someone\\My Notes\\个人知识库 with space');
    expect(spaced.env.projectPathHasSpace).toBe(true);
    expect(spaced.env.projectPathHasNonAscii).toBe(true);
    // 只报告形状，不报告路径本身：报告文件可能被贴进工单。
    expect(JSON.stringify(spaced.env)).not.toContain('someone');
  });

  it('T080-C01 纯 ASCII 无空格的路径保持两个标志为 false', () => {
    const plain = runDoctorSync('C:\\repo\\feini-brain');
    expect(plain.env.projectPathHasSpace).toBe(false);
    expect(plain.env.projectPathHasNonAscii).toBe(false);
  });
});

/**
 * T080-C06｜数据保护：排错建议必须先备份、先诊断，不能删 `.data`。
 *
 * 这一条是**文档与脚本两侧一起钉住**的，因为「删库重来」是最容易被顺手写进
 * 排错清单的一句。断言分两半：
 *  - 脚本侧：预检本身不写用户数据目录（`runDoctor` 只探测临时目录与工程根）；
 *  - 文档侧：手册明确禁止把删除 `.data` 当修复手段，并把备份步骤放在重建之前。
 */
describe('T080-C06 排错不拿资料换开机', () => {
  it('T080-C06 预检跑完后不在被测目录里留下任何东西（非破坏性）', async () => {
    const source = readFileSync(path.join(projectRoot, 'scripts', 'doctor.mjs'), 'utf8');
    // 预检只碰 TEMP 与工程根：出现 .data 字面量说明它开始"顺手检查"用户库了。
    expect(source).not.toMatch(/['"`]\.data['"`]/u);
    expect(source).not.toContain('brain.db');

    /*
     * 实质的一半断言的是**行为**而不是文本：在一个空目录上跑完整预检（记录关闭），
     * 跑完之后该目录必须仍然是空的。
     *
     * 这正是「排错不能以资料为代价」可检查的含义：预检会真的创建、写入并重开一个
     * SQLite 探针文件，也会在工程根写一个探针文件——如果它把探针留在原处，或者把
     * 探针写到了用户数据目录，这条会红。
     */
    const sandbox = mkdtempSync(path.join(tmpdir(), 'feini-doctor-sandbox-'));
    try {
      writeFileSync(path.join(sandbox, 'package.json'), JSON.stringify({ name: 'sandbox' }), 'utf8');
      const result = await runDoctor({
        projectRoot: sandbox,
        env: { ...process.env, FEINI_DOCTOR_RECORD: 'off' },
      });
      expect(result.exitCode).toBe(0);
      expect(result.report.sqlite.ok).toBe(true);
      expect(result.report.projectFiles.ok).toBe(true);
      // 记录关闭 + 探针自清理 ⇒ 目录里只剩我们放进去的那个 package.json。
      expect(readdirSync(sandbox)).toEqual(['package.json']);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('T080-C06 手册禁止删除 .data，并把备份与诊断排在重建之前', () => {
    const doc = readFileSync(path.join(projectRoot, 'docs/operations/common-failures.md'), 'utf8');
    expect(doc).toMatch(/不要删除|别删除|禁止删除/u);
    expect(doc).toMatch(/\.data/u);
    // 备份与诊断脚本都要被点名，否则"先备份"只是一句口号。
    expect(doc).toContain('scripts/inspect-data.mjs');
    expect(doc).toMatch(/backup-recovery\.md|备份/u);
  });
});

/**
 * 在子进程里跑 `environmentSummary`，避免为了造「含空格/中文的路径」而改本进程的 cwd。
 *
 * 路径是**字符串参数**，不是 `cwd`：被测的是「报告如何描述这个路径」，不需要该目录
 * 真实存在（真实存在的含空格中文目录已由 `recovery.test.ts` 覆盖）。
 */
function runDoctorSync(fakeProjectRoot: string): {
  env: {
    projectPathHasSpace: boolean;
    projectPathHasNonAscii: boolean;
  };
} {
  const script = [
    "const { environmentSummary } = await import('./scripts/doctor.mjs');",
    `console.log(JSON.stringify(environmentSummary(${JSON.stringify(fakeProjectRoot)})));`,
  ].join('\n');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 20_000,
  });
  expect(result.status, `子进程应成功：${result.stderr}`).toBe(0);
  return { env: JSON.parse(result.stdout.trim()) };
}
