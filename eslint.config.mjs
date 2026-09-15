import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * Layer boundaries (T003-R02, T003-R06).
 *
 * The import graph is enforced mechanically, not by convention, so a client
 * component can never pull in node:sqlite, the secrets table or the model
 * transport and ship them to the browser.
 */
const SERVER_ONLY = [
  "@/server/*",
  "@/server/**",
  "server-only",
  "node:sqlite",
  "node:fs",
  "node:fs/promises",
  "node:crypto",
  "node:path",
  "node:os",
  "node:child_process",
];

const NO_SERVER_RUNTIME = [
  {
    group: SERVER_ONLY,
    message:
      "浏览器侧代码不能引用服务端运行时或秘密模块（T003-R02/R06）。请通过 features/shared/apiClient 访问数据。",
  },
];

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    name: "feini/domain-purity",
    // `.tsx` is included deliberately: `*.ts` does not match a `.tsx` file, so a
    // component dropped into `src/domain` would escape every rule below and could
    // start importing React while still sitting in the pure layer (T003-R01).
    files: ["src/domain/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "react",
                "react-dom",
                "next",
                "next/**",
                "@/server/*",
                "@/server/**",
                "@/features/*",
                "@/features/**",
                "@/components/*",
                "@/components/**",
                "node:*",
              ],
              message:
                "src/domain 只能是纯类型、schema 与无副作用函数（T003-R01）。",
            },
          ],
        },
      ],
    },
  },
  {
    name: "feini/features-no-server",
    files: ["src/features/**/*.{ts,tsx}", "src/components/**/*.{ts,tsx}"],
    rules: { "no-restricted-imports": ["error", { patterns: NO_SERVER_RUNTIME }] },
  },
  {
    name: "feini/app-client-no-server",
    // app/api routes are the only place allowed to reach the server layer.
    files: ["src/app/**/*.{ts,tsx}"],
    ignores: ["src/app/api/**"],
    rules: { "no-restricted-imports": ["error", { patterns: NO_SERVER_RUNTIME }] },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "node_modules/**",
    "coverage/**",
    "test-results/**",
    "playwright-report/**",
    "implementation/progress/**",
  ]),
]);
