// Performance-run launcher (T079).
//
// This exists for one reason: the R04 audit imports real `src/server/**` modules
// so it can count SQL inside the process that issues it, and those modules start
// with `import 'server-only'` — a marker whose default export throws unless the
// module is resolved under the `react-server` condition. Setting that condition in
// `package.json` is the only place that works: Playwright loads its config through
// CommonJS `require`, so `import.meta`-based module hooks fail there, and a shell
// variable would make `npm run test:perf` work only for whoever remembered it.
//
// `--conditions` is Node's own resolution flag, so the app's client/server boundary
// is untouched: `next build` still enforces it, and `src/**` is unchanged. The scope
// is this one command, and it is inherited by Playwright's workers.
import { spawn } from 'node:child_process';
import process from 'node:process';

const child = spawn(
  process.execPath,
  [
    '--conditions=react-server',
    'node_modules/@playwright/test/cli.js',
    'test',
    '--config',
    'tests/performance/playwright.perf.config.ts',
    ...process.argv.slice(2),
  ],
  { stdio: 'inherit', env: process.env },
);

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
