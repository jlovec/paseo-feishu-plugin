/**
 * Paseo 把插件打成 CJS bundle 后放进 `(function(require){...})` 里执行，
 * 外层没有 Node 的 `__dirname`。`@larksuiteoapi/node-sdk` 在推断自身版本时
 * 会直接读 `__dirname`，缺了它整包加载就抛 ReferenceError。
 *
 * 插件跑在独立子进程里，这里补一个全局占位符；SDK 读不到有效
 * package.json 会回落到 "unknown"，不影响请求。
 */
const globals = globalThis as typeof globalThis & { __dirname?: string };
if (globals.__dirname === undefined) {
  globals.__dirname = "/";
}

export {};
