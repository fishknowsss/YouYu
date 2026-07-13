# YouYu Release Packaging

本地交付三包统一运行 `npm run dist:win:local`。该命令最终在 `release/` 留下标准空订阅安装包，以及内置私有订阅的 `-in`、`-no` 安装包。不要把 `npm run dist:win:release` 生成的同名 `-in`、`-no` 公开更新包当作本地内置版本；公开更新包按设计全部为空订阅。

这份文档记录 YouYu 的打包、版本号、订阅内置和本地归档规则。以后处理打包、发布、版本号、订阅默认值时，先读这里。

## 交付原则

默认每次本地交付保留三种 Windows x64 安装包：

| 类型 | 命令 | 产物 | 用途 | 是否内置订阅 | 是否包含桌宠 |
| --- | --- | --- | --- | --- | --- |
| 标准版 | `npm run dist:win` | `release/YouYu-<version>-x64.exe` | GitHub release / Actions artifact / 公开下载 | 否 | 是 |
| 内部版 | `npm run dist:win:in` | `release/YouYu-<version>-x64-in.exe` | 本机自用或内部分发 | 是 | 是 |
| 无桌宠版 | `npm run dist:win:no` | `release/YouYu-<version>-x64-no.exe` | 本机自用或内部分发 | 是 | 否 |

公开 GitHub release、GitHub Actions artifact 和公开下载渠道只能上传不含内置订阅的产物。标准版使用 `latest.yml` 更新；内部通道和无桌宠通道只能上传 `--public-update` 生成的更新包，分别使用 `latest-in.yml` 和 `latest-no.yml`。本地自用且内置订阅的内部版、无桌宠版可以保留在本机 `release/`，但不能上传 GitHub release。

纯文档、项目规则或归档目录维护不需要递增版本号，也不需要重新打安装包。

## 订阅文件

- `resources/default-subscription.txt`
  - 被 Git 跟踪。
  - 必须保持为空。
  - 只有标准版读取它，校验脚本要求标准版包内订阅为空。
- `resources/default-subscription.in.txt`
  - 本机私有文件。
  - 必须被 `.gitignore` 命中。
  - 保存内部版和无桌宠版使用的真实内置订阅。
  - 不能提交，不能上传 GitHub，不能放进公开 release。
- `resources/generated/default-subscription.txt`
  - 打包脚本临时生成。
  - 必须被 `.gitignore` 命中。
  - `dist:win` 从空的 `resources/default-subscription.txt` 生成。
  - `dist:win:in` 和 `dist:win:no` 从 `resources/default-subscription.in.txt` 生成，仅用于本地自用或内部分发。
  - `dist:win:release` 生成公开更新用三通道产物，三种通道都从空的 `resources/default-subscription.txt` 生成，禁止携带真实订阅。

如果真实订阅曾经进入 GitHub commit、Actions artifact 或 release asset，要当作已经泄露处理，必须更换订阅 token。删除文件或重写历史只能止血，不能让旧 token 重新安全。

## 三包打包流程

`dist:win`、`dist:win:in` 和 `dist:win:no` 都会先执行 `npm run clean:release`，所以每次打包都会清空上一次的 `release/` 输出。

标准顺序是先打无桌宠版，再打内部版，最后打标准版。这样最终 `release/win-unpacked/resources/default-subscription.txt` 来自标准版，仍然为空，适合继续跑公开版 `smoke`。

通常直接运行 `npm run dist:win:local`。只有排查单个打包步骤时，才按下面的手动顺序执行；临时目录使用随机后缀，避免并行任务互相覆盖：

```powershell
$version = (node -p "require('./package.json').version")
$archive = Join-Path $env:TEMP ("youyu-release-{0}-{1}" -f $version, [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $archive | Out-Null

npm run dist:win:no
Copy-Item "release/YouYu-$version-x64-no.exe" "$archive/YouYu-$version-x64-no.exe" -Force
Copy-Item "release/YouYu-$version-x64-no.exe.blockmap" "$archive/YouYu-$version-x64-no.exe.blockmap" -Force

npm run dist:win:in
Copy-Item "release/YouYu-$version-x64-in.exe" "$archive/YouYu-$version-x64-in.exe" -Force
Copy-Item "release/YouYu-$version-x64-in.exe.blockmap" "$archive/YouYu-$version-x64-in.exe.blockmap" -Force

npm run dist:win
Copy-Item "$archive/YouYu-$version-x64-no.exe" "release/YouYu-$version-x64-no.exe" -Force
Copy-Item "$archive/YouYu-$version-x64-no.exe.blockmap" "release/YouYu-$version-x64-no.exe.blockmap" -Force
Copy-Item "$archive/YouYu-$version-x64-in.exe" "release/YouYu-$version-x64-in.exe" -Force
Copy-Item "$archive/YouYu-$version-x64-in.exe.blockmap" "release/YouYu-$version-x64-in.exe.blockmap" -Force

npm run smoke
Remove-Item -LiteralPath $archive -Recurse -Force
```

`release/`、`release-archive/` 和 `resources/generated/` 都不应该提交。

## 本地归档规则

`release-archive/` 只用于本机备份，不用于打包中转，也不提交到 Git。

归档保留范围：

- 当前构建版本。
- 前两个构建版本。
- 每个保留版本应尽量保留对应安装包和 `.blockmap` 文件。

如果当前目录暂时不满足这个范围，例如刚清空或旧版本缺少 `.blockmap`，可以先忽略，等下一次完整打包后再补齐。

## 单独打包命令

标准版：

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
- GitHub Actions 公开上传必须使用 `npm run dist:win:release` 生成的空订阅更新包。

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
- 产物只能本地使用或内部分发，不能上传 GitHub release。

无桌宠版：

```powershell
npm run dist:win:no
```

预期结果：

```text
release/YouYu-<version>-x64-no.exe
```

验证点：

- `validate:release:no` 通过。
- `release/win-unpacked/resources/default-subscription.txt` 非空。
- `out/renderer/assets` 中没有 `spritesheet` 资源。
- 运行时不创建桌宠窗口，也不显示托盘桌宠入口。

## 版本号

打包前先确认 `package.json` 的 `version`。

- 小修小改递增 patch，例如 `0.7.7` -> `0.7.8`。
- 较大功能或行为变化递增 minor，例如 `0.7.x` -> `0.8.0`。
- 只有用户明确要求大版本时才递增 major。

安装包文件名由 `package.json` 版本自动决定：

```text
YouYu-<version>-x64.exe
YouYu-<version>-x64-in.exe
YouYu-<version>-x64-no.exe
```

不要手动改 exe 文件名来冒充版本。

## GitHub 发布规则

GitHub release 和 GitHub Actions 使用 `npm run dist:win:release`。用于自动更新的公开 Release 需要同时上传：

```text
release/YouYu-<version>-x64.exe
release/YouYu-<version>-x64.exe.blockmap
release/latest.yml
release/YouYu-<version>-x64-in.exe
release/YouYu-<version>-x64-in.exe.blockmap
release/latest-in.yml
release/YouYu-<version>-x64-no.exe
release/YouYu-<version>-x64-no.exe.blockmap
release/latest-no.yml
```

其中 `latest.yml` 只服务标准版，`latest-in.yml` 只服务内部通道，`latest-no.yml` 只服务无桌宠通道。三个公开更新包都必须通过空内置订阅校验，不允许包含 `resources/default-subscription.in.txt` 的内容。

禁止上传本地内置订阅产物：

```text
npm run dist:win:in 生成的 release/YouYu-<version>-x64-in.exe
npm run dist:win:no 生成的 release/YouYu-<version>-x64-no.exe
```

本机 `release/` 里可以保留三通道安装包；上传或发布时要确认 `-in`、`-no` 来自 `dist:win:release`，而不是本地内置订阅包。

## 完整公开发布闭环

面向用户交付并需要客户端自动更新时，不要停在“已打包”。完成下面整套流程后再结束。

1. 确认版本和改动范围。

   ```powershell
   git status --short
   node -p "require('./package.json').version"
   ```

   只提交本次源码、文档、版本号和测试改动。不要提交 `release/`、`release-archive/`、`out/`、`resources/generated/` 或本机私有订阅文件。

2. 运行本地验证。

   ```powershell
   npm run typecheck
   npm test
   npm run test:worker
   npm run typecheck:worker
   npm run build:worker
   npm run lint
   npm run format:check
   npm run build
   ```

   如果改动包含 UI，必须额外做关键尺寸或关键页面验证。优先覆盖最小窗口、断点附近窗口和本次改动页面；可以使用截图、DOM 快照或等价的可重复检查，并在最终说明中写明验证过的尺寸和页面。

3. 生成公开更新资产。

   ```powershell
   npm run dist:win:release
   ```

   该命令必须成功，并生成三通道公开更新资产：

   ```text
   release/YouYu-<version>-x64.exe
   release/YouYu-<version>-x64.exe.blockmap
   release/YouYu-<version>-x64-in.exe
   release/YouYu-<version>-x64-in.exe.blockmap
   release/YouYu-<version>-x64-no.exe
   release/YouYu-<version>-x64-no.exe.blockmap
   release/latest.yml
   release/latest-in.yml
   release/latest-no.yml
   ```

   `dist:win:release` 内部会运行对应校验和 `smoke`。如果它失败，先修复失败原因，不要上传部分产物。

4. 维护本地归档。

   `release-archive/` 只保留当前版本和前两个构建版本。归档当前版本时至少保留三个安装包和对应 `.blockmap`；可以同时保留 `<version>-latest.yml` 方便本机追溯。删除旧版本前先确认目标路径在 `release-archive/` 内。

5. 提交源码改动。

   ```powershell
   git add <本次应提交的源码、文档、测试、版本文件>
   git status --short
   git commit -m "Release YouYu <version>"
   ```

   纯文档或项目规则修改不需要版本号、安装包或 release，提交信息应直接描述文档改动。

6. 创建并推送版本标签。

   ```powershell
   git tag v<version>
   git push origin main
   git push origin v<version>
   ```

   推送版本标签时使用精确标签名。不要使用 `git push --follow-tags`，除非已经确认本地没有无关未推送标签。若误推了无关标签，立即确认它不是本次发布需要的标签，并删除远端误推标签。

7. 创建 GitHub Release 并上传资产。

   ```powershell
   $version = node -p "require('./package.json').version"
   gh release create "v$version" `
     "release/YouYu-$version-x64.exe" `
     "release/YouYu-$version-x64.exe.blockmap" `
     "release/YouYu-$version-x64-in.exe" `
     "release/YouYu-$version-x64-in.exe.blockmap" `
     "release/YouYu-$version-x64-no.exe" `
     "release/YouYu-$version-x64-no.exe.blockmap" `
     "release/latest.yml" `
     "release/latest-in.yml" `
     "release/latest-no.yml" `
     --title "YouYu $version" `
     --notes "<本次用户可读更新说明>"
   ```

   如果 Release 已存在，先检查已有资产是否来自同一次构建。确需覆盖时才使用 `gh release upload "v$version" ... --clobber`。

8. 校验远端发布结果。

   ```powershell
   $version = node -p "require('./package.json').version"
   gh release view "v$version" --json tagName,url,name,isDraft,isPrerelease,assets
   git ls-remote --heads origin main
   git ls-remote --tags origin "refs/tags/v$version"
   ```

   再从 GitHub 下载入口读取三个更新描述文件，确认它们都指向当前版本和正确安装包：

   ```powershell
   $version = node -p "require('./package.json').version"
   foreach ($name in @('latest.yml', 'latest-in.yml', 'latest-no.yml')) {
     $bytes = (Invoke-WebRequest -UseBasicParsing -Uri "https://github.com/fishknowsss/YouYu/releases/download/v$version/$name" -TimeoutSec 30).Content
     if ($bytes -is [byte[]]) { [Text.Encoding]::UTF8.GetString($bytes) } else { $bytes }
   }
   ```

   每个文件都必须显示 `version: <version>`，并分别指向 `YouYu-<version>-x64.exe`、`YouYu-<version>-x64-in.exe`、`YouYu-<version>-x64-no.exe`。

9. 最终收尾。

   ```powershell
   git status --short
   ```

   工作区应保持干净；如果只有被 `.gitignore` 命中的本地产物、缓存或归档目录，不需要提交。

## 快速检查

三包本地交付：

- `resources/default-subscription.txt` 为空。
- `resources/default-subscription.in.txt` 存在，并被 `git check-ignore -v resources/default-subscription.in.txt` 命中。
- 先运行 `npm run dist:win:no`，暂存 `-no.exe` 和 `-no.exe.blockmap`。
- 再运行 `npm run dist:win:in`，暂存 `-in.exe` 和 `-in.exe.blockmap`。
- 最后运行 `npm run dist:win`，把暂存的无桌宠版和内部版产物复制回 `release/`。
- `npm run smoke` 通过。
- `release/YouYu-<version>-x64.exe` 存在。
- `release/YouYu-<version>-x64-in.exe` 存在。
- `release/YouYu-<version>-x64-no.exe` 存在。
- 上传 GitHub 时使用 `npm run dist:win:release` 生成的三通道公开更新产物，并确认 `latest.yml`、`latest-in.yml`、`latest-no.yml` 都存在。
