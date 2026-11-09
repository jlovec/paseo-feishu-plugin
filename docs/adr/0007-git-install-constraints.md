# ADR 0007：Git 源安装的两个环境约束

状态：已确认（2026-11-09 第二台 macOS 实测）

## 背景

插件在第二台 Paseo 上用 `paseo plugin install git:jlovec/paseo-feishu-plugin`
安装时，连续遇到两个与业务代码无关、但会直接让安装失败的环境问题。

## 约束一：锁文件必须使用官方 registry

现象：

```
npm error code EALLOWREMOTE
npm error Refusing to fetch "ws@https://mirrors.cloud.tencent.com/npm/ws/-/ws-8.22.2.tgz"
```

原因：开发机的 npm 配置了腾讯镜像，`package-lock.json` 里 381 个 `resolved`
全部指向 `mirrors.cloud.tencent.com`；目标机器禁用了 `remote` 类型的包拉取，
凡是「不在其配置 registry 下」的 tarball URL 都会被拒绝。

结论：锁文件的 `resolved` 统一写成 `https://registry.npmjs.org/`。
npm 默认 `replace-registry-host=npmjs`，安装时会自动替换成目标机器配置的
registry，因此官方源与公司镜像两种环境都能装。

验证：空缓存 + `--allow-remote=false` + 官方源，`npm ci` 退出码 0。

## 约束二：build 步骤必须安装 devDependencies

现象：

```
ERROR: [plugin: paseo-plugin-server-runtime-boundary]
Could not resolve type dependency "@getpaseo/client" imported by server/notify.ts
```

原因：Paseo 插件编译器在打包前会解析**类型导入**；`@getpaseo/client` 与
`@getpaseo/plugin` 都在 `devDependencies`，`npm ci --omit=dev` 裁掉后类型解析失败。
类型导入虽然会被 esbuild 擦除，但边界检查发生在擦除之前。

结论：`paseo-plugin.json` 的 build 用 `npm ci` 全量安装。SDK 仍然由 host 提供
（`external`），不会打进插件产物。

验证：全量 `npm ci` 后 `node_modules/@getpaseo/{client,plugin,protocol}` 存在，
本地 `npm run typecheck` 与插件编译均正常。

## 影响

1. `package-lock.json` 的 `resolved` 保持官方 registry；不要用本机镜像重新生成后直接提交。
2. `paseo-plugin.json` 的 build 固定为 `[["npm", "ci"]]`。
3. 每台机器仍应扫码创建独立飞书应用，原因见 `OVERVIEW.md`（长连接集群模式）。
