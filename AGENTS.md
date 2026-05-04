# YouYu Agent Notes

沟通交流部分默认中文输出，必要部分使用原始语言。

## UI Rules

- Do not render implementation notes in the UI.
- Keep Chinese copy natural and concise.
- Avoid tooltip-like filler text and tiny gray captions.
- Prioritize whitespace and alignment over extra borders.

## Copywriting Rules

- 面向中文用户，自然直接。
- 不使用营销口吻，不使用翻译腔。
- 按钮优先 2~4 个字。
- 标签少而准，不堆术语。
- 空状态只说用户下一步该做什么。

## Delivery Rules

- Before coding, propose layout and component tree for UI work.
- After coding, self-check against all forbidden UI/copy patterns.

## Packaging Rules

- Read [docs/release-packaging.md](docs/release-packaging.md) before changing packaging, release, subscription defaults, or versioning.
- Public GitHub builds must use `npm run dist:win` and produce `release/YouYu-<version>-x64.exe`.
- Public builds must not contain a bundled subscription. `scripts/validate-windows-release.ts` enforces an empty bundled `default-subscription.txt`.
- Local internal builds must use `npm run dist:win:in` and produce `release/YouYu-<version>-x64-in.exe`.
- The internal subscription source is `resources/default-subscription.in.txt`; it is local-only and gitignored. Never commit it.
- Both `dist:win` and `dist:win:in` run `clean:release`, so each command deletes the previous `release/` output. If both installers are needed locally, copy one aside before running the other.
