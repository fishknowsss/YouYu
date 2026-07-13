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
- For app code or app resource changes that are being delivered locally, read `docs/release-packaging.md`, bump the patch version, and produce the documented Windows installers unless the user explicitly says not to package.
- For release-delivered app changes, finish the full checklist in `docs/release-packaging.md`: validation, packaging, local archive maintenance, commit, explicit tag push, GitHub Release asset upload, and remote `latest*.yml` verification.
- Pure documentation, project-rule, or archive housekeeping changes do not require a version bump or installer rebuild.

## Packaging Rules

- Use `npm run dist:win:local` for a local three-installer delivery. It leaves the standard installer without a bundled subscription and leaves the `-in` and `-no` installers with the private bundled subscription.
- Never hand over the `-in` or `-no` installers produced by `npm run dist:win:release` as private local builds. Those same-named public update installers intentionally contain no bundled subscription.
- Read [docs/release-packaging.md](docs/release-packaging.md) before changing packaging, release, subscription defaults, or versioning.
- Public GitHub update builds must use `npm run dist:win:release` and produce standard, internal-channel, and no-pet-channel update assets plus `latest.yml`, `latest-in.yml`, and `latest-no.yml`.
- Public builds must not contain a bundled subscription. `scripts/validate-windows-release.ts` enforces an empty bundled `default-subscription.txt` for standard public builds and for `--public-update` internal/no-pet channel builds.
- Local internal builds must use `npm run dist:win:in` and produce `release/YouYu-<version>-x64-in.exe`.
- Local no-desktop-pet builds must use `npm run dist:win:no` and produce `release/YouYu-<version>-x64-no.exe`.
- The internal subscription source is `resources/default-subscription.in.txt`; it is local-only and gitignored. Never commit it.
- `dist:win`, `dist:win:in`, and `dist:win:no` run `clean:release`, so each command deletes the previous `release/` output. If multiple installers are needed locally, copy each `.exe` and `.blockmap` pair aside before running the next build.
- `release-archive/` is a local backup folder. Keep only the current build version and the previous two build versions there, including each kept installer and its matching `.blockmap` when present.
- If `release-archive/` does not yet satisfy the current-plus-previous-two policy, it can be left empty or partially populated until the next eligible packaging run.
- When publishing a release, push the exact version tag explicitly. Do not rely on `git push --follow-tags` unless all local tags have been audited.
