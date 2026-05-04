# YouYu Release Packaging

这份文档记录 YouYu 的打包、版本号和订阅内置规则。以后处理打包、发布、版本号、订阅默认值时，先读这里。

## 交付原则

默认每次本地交付都要同时保留两个 Windows 安装包：

| 类型 | 命令 | 产物 | 用途 | 是否内置订阅 |
| --- | --- | --- | --- | --- |
| 公开版 | `npm run dist:win` | `release/YouYu-<version>-x64.exe` | GitHub release / Actions artifact | 否 |
| 内部版 | `npm run dist:win:in` | `release/YouYu-<version>-x64-in.exe` | 本机自用或内部临时分发 | 是 |

两个安装包都可以留在本机 `release/`。只有 GitHub release、GitHub Actions artifact、公开下载渠道必须排除 `-in.exe`。

## 订阅文件

- `resources/default-subscription.txt`
  - 被 Git 跟踪。
  - 必须保持为空。
  - 公开版打包会读取它，校验脚本会要求包内订阅为空。
- `resources/default-subscription.in.txt`
  - 本机私有文件。
  - 必须被 `.gitignore` 命中。
  - 保存真实内置订阅。
  - 不能提交，不能上传 GitHub，不能放进公开 release。
- `resources/generated/default-subscription.txt`
  - 打包脚本临时生成。
  - 必须被 `.gitignore` 命中。
  - `dist:win` 从空的 `resources/default-subscription.txt` 生成。
  - `dist:win:in` 从本机私有的 `resources/default-subscription.in.txt` 生成。

## 双包打包流程

`dist:win` 和 `dist:win:in` 都会先执行 `npm run clean:release`，所以第二次打包会清空第一次的 `release/` 输出。需要用 `release-archive/` 暂存第一次产物。

标准顺序是先打内部版，再打公开版，最后把内部版复制回 `release/`：

```powershell
$version = (node -p "require('./package.json').version")
New-Item -ItemType Directory -Force -Path release-archive | Out-Null

npm run dist:win:in
Copy-Item "release/YouYu-$version-x64-in.exe" "release-archive/YouYu-$version-x64-in.exe" -Force
Copy-Item "release/YouYu-$version-x64-in.exe.blockmap" "release-archive/YouYu-$version-x64-in.exe.blockmap" -Force

npm run dist:win
Copy-Item "release-archive/YouYu-$version-x64-in.exe" "release/YouYu-$version-x64-in.exe" -Force
Copy-Item "release-archive/YouYu-$version-x64-in.exe.blockmap" "release/YouYu-$version-x64-in.exe.blockmap" -Force
```

这个顺序的好处是最终 `release/win-unpacked/resources/default-subscription.txt` 来自公开版，仍然为空，适合继续跑公开版 `smoke`。

如果必须先打公开版，再打内部版，也可以反过来做，但要同时暂存并复制回公开版的 `.exe` 和 `.blockmap`，不能只复制 `.exe`。

`release/`、`release-archive/` 和 `resources/generated/` 都不应该提交。

## 单独打包命令

公开版：

```powershell
npm run dist:win
```

预期结果：

```text
release/YouYu-<version>-x64.exe
```

验证点：

- `validate:release` 通过。
- `release/win-unpacked/resources/default-subscription.txt` 为空。
- GitHub Actions 上传路径只匹配 `release/YouYu-${version}-x64.exe`。

内部版：

```powershell
npm run dist:win:in
```

预期结果：

```text
release/YouYu-<version>-x64-in.exe
```

验证点：

- `validate:release:in` 通过。
- `release/win-unpacked/resources/default-subscription.txt` 非空。
- 产物只能本地使用或内部临时分发，不能上传 GitHub release。

## 版本号

打包前先确认 `package.json` 的 `version`。

- 小修小改递增 patch，例如 `0.4.24` -> `0.4.25`。
- 较大功能或行为变化递增 minor，例如 `0.4.x` -> `0.5.0`。
- 只有用户明确要求大版本时才递增 major。

安装包文件名由 `package.json` 版本自动决定：

```text
YouYu-<version>-x64.exe
YouYu-<version>-x64-in.exe
```

不要手动改 exe 文件名来冒充版本。

## GitHub 发布规则

GitHub release 和 GitHub Actions 只能使用公开版：

```text
release/YouYu-<version>-x64.exe
```

禁止上传：

```text
release/YouYu-<version>-x64-in.exe
```

本机 `release/` 里可以同时保留两个安装包；上传或发布时要明确只选择不带 `-in` 的公开版。

如果真实订阅曾经进入 GitHub commit、Actions artifact 或 release asset，要当作已经泄露处理，必须更换订阅 token。删除文件或重写历史只能止血，不能让旧 token 重新变安全。

## 快速检查

双包本地交付：

- `resources/default-subscription.txt` 为空。
- `resources/default-subscription.in.txt` 存在，并且 `git check-ignore -v resources/default-subscription.in.txt` 命中。
- 先运行 `npm run dist:win:in`，暂存 `-in.exe` 和 `-in.exe.blockmap`。
- 再运行 `npm run dist:win`，把暂存的内部版产物复制回 `release/`。
- `npm run smoke` 通过。
- `release/YouYu-<version>-x64.exe` 存在。
- `release/YouYu-<version>-x64-in.exe` 存在。
- 上传 GitHub 时只上传 `release/YouYu-<version>-x64.exe`。
