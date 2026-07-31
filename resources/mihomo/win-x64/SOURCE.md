# Mihomo 来源与许可证

YouYu 随安装包分发的 `mihomo.exe` 来自 MetaCubeX/mihomo 官方正式版资产，未对该二进制进行修改。

- 项目：`MetaCubeX/mihomo`
- 版本：`v1.19.28`
- Tag commit：`cbd11db1e13a75d8e680e0fe7742c95be4cba2be`
- 官方二进制资产：`mihomo-windows-amd64-v1.19.28.zip`
- 二进制资产地址：<https://github.com/MetaCubeX/mihomo/releases/download/v1.19.28/mihomo-windows-amd64-v1.19.28.zip>
- 二进制资产 SHA256：`27bdbd8f476dfb0f65a2a8ecf43cdf7edc0a132326efc7660308a1302c034a20`
- `mihomo.exe` SHA256：`84f8bcd390ee146cba87746fe5447eb1bfa534c8f03c52dd965ef207ae4f0eeb`

## 对应源码

与该二进制版本对应的上游源码快照固定到上述 commit：

<https://codeload.github.com/MetaCubeX/mihomo/tar.gz/cbd11db1e13a75d8e680e0fe7742c95be4cba2be>

源码快照 SHA256：`c5a42706220537f6067e74518a9befbbc451c12f5cae26c42f0f4debf92cef0a`

每个公开 YouYu GitHub Release 还应上传同一份已校验源码快照，文件名为：

`YouYu-<YouYu 版本>-Mihomo-v1.19.28-source.tar.gz`

源码中的 `Makefile`、`go.mod`、`go.sum` 和上游工作流记录了构建依赖与方式。需要复现时，应以固定 commit 的源码和上游构建说明为准，不要使用 `main`、`latest` 或 Alpha 资产代替。

## 许可证

Mihomo 以 GNU General Public License version 3 发布。完整许可证文本随本文件一同保存在 `LICENSE-GPL-3.0.txt`。Mihomo 的版权归其贡献者所有；YouYu 自身与其他第三方组件的许可不因本说明而被重新定义。
