import { readFile } from 'node:fs/promises';

const repository = 'https://github.com/fishknowsss/YouYu';
const escape = (value) =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const inline = (value) => escape(value).replace(/`([^`]+)`/g, '<code>$1</code>');

export async function renderSitePages(index, version) {
  const root = new URL('../', import.meta.url);
  const header = index.match(/<div class="header-shell">[\s\S]*?<\/header>\s*<\/div>/)[0];
  const footer = index.match(/<footer class="site-footer">[\s\S]*?<\/footer>/)[0];
  const baseHead = index
    .slice(0, index.indexOf('</head>'))
    .replace(/\s*<script[\s\S]*?<\/script>/g, '')
    .replace(/\s*<link rel="preload"[^>]*>/g, '');
  const script = index.match(/<script src="assets\/pages.js[^>]*><\/script>/)[0];
  function page(file, title, description, content) {
    const url = `https://fishknowsss.github.io/YouYu/${file}`;
    const head = baseHead
      .replace(/<title>[^<]*<\/title>/, `<title>${title} · YouYu</title>`)
      .replace(/(<meta\s+name="description"\s+content=")[^"]+/, `$1${description}`)
      .replace(/(<meta\s+property="og:title"\s+content=")[^"]+/, `$1${title} · YouYu`)
      .replace(/(<meta\s+property="og:description"\s+content=")[^"]+/, `$1${description}`)
      .replace(/(<meta property="og:url" content=")[^"]+/, `$1${url}`)
      .replace(/(<link rel="canonical" href=")[^"]+/, `$1${url}`);
    // Repository hygiene runs before npm ci. Keep generation deterministic and dependency-free.
    return (
      `${head}${script}</head><body><a class="skip-link" href="#top">跳到正文</a>${header}<main id="top" class="subpage">${content}</main>${footer}</body></html>`
        .replace(/\r\n/g, '\n')
        .replace(/>\s*</g, '>\n<') + '\n'
    );
  }
  const release = `${repository}/releases/download/v${version}`;
  const download = `<section class="page-intro page-width centered-intro"><img class="intro-icon" src="assets/youyu-icon.png" width="64" height="64" alt=""/><h1>下载 YouYu</h1><p>选择喜欢的桌面体验，网络功能一样齐全。</p><div class="version-line">v${version} · Windows 10 / 11 x64 · MIT 开源</div></section>
    <section class="page-width download-page-options" aria-label="选择安装包">
    <article class="download-option"><h2>标准版</h2><p>包含完整代理功能和可互动桌宠。<br class="wide-break" />想试试桌面小伙伴，选这一版。</p><ul><li>小白模式与专业模式</li><li>节点、测试、TUN 和网络修复</li><li>桌宠与应用内更新</li></ul><a class="button" href="${release}/YouYu-${version}-x64.exe">下载标准版</a></article>
    <article class="download-option no-pet-option"><h2>无桌宠版</h2><p>相同的网络功能，不包含桌宠素材与窗口。<br class="wide-break" />适合喜欢清静桌面的用户。</p><ul><li>小白模式与专业模式</li><li>节点、测试、TUN 和网络修复</li><li>独立的应用内更新通道</li></ul><a class="button" href="${release}/YouYu-${version}-x64-no.exe">下载无桌宠版</a></article></section>
    <section class="page-width download-support"><div><h2>安装前了解一下</h2><p>公开安装包不内置订阅，请准备自己的订阅地址。<br class="wide-break" />安装时需要管理员授权，日常运行使用普通用户权限。</p><p>当前安装包尚未配置生产代码签名。<br class="wide-break" />请从官方 GitHub Release 下载，确认来源后按 Windows 提示操作。</p></div><div class="resource-links"><a href="guide.html#start">首次安装与使用 <span aria-hidden="true">↗</span></a><a href="${repository}/releases/tag/v${version}">完整 Release 资产 <span aria-hidden="true">↗</span></a><a href="changelog.html">查看更新记录 <span aria-hidden="true">↗</span></a></div></section>
    <section class="page-width subpage-note"><h2>已经装过 YouYu？</h2><p>可在软件设置中检查并安装更新。旧版更新遇到问题时，正常退出 YouYu，再运行同一通道的安装包覆盖安装。</p><a class="story-link" href="guide.html#update">查看更新说明 <span aria-hidden="true">↗</span></a></section>`;

  const changelog = await readFile(new URL('CHANGELOG.md', root), 'utf8');
  const releases = [
    ...changelog.matchAll(/^## \[([\d.]+)\] - (\d{4}-\d{2}-\d{2})\r?\n([\s\S]*?)(?=^## |$(?![\s\S]))/gm)
  ];
  const timeline = releases
    .map(([, tag, date, body], index) => {
      // Public changelog remains the sole source. Keep engineering validation details in the full record.
      const groups = [...body.matchAll(/^### (.+)\r?\n([\s\S]*?)(?=^### |$(?![\s\S]))/gm)].filter(
        (group) => group[1].trim() !== '验证'
      );
      return `<article class="release-entry" id="v${tag}"><div class="release-meta"><time datetime="${date}">${date}</time><a href="${repository}/releases/tag/v${tag}">v${tag}</a>${index === 0 ? '<span>当前版本</span>' : ''}</div><div class="release-body"><h2>版本 ${tag}</h2>${groups
        .map(
          ([, heading, text]) =>
            `<h3>${escape(heading.trim())}</h3><ul>${text
              .split(/\r?\n/)
              .filter((line) => line.startsWith('- '))
              .map((line) => `<li>${inline(line.slice(2))}</li>`)
              .join('')}</ul>`
        )
        .join(
          ''
        )}<a class="story-link" href="${repository}/blob/main/CHANGELOG.md">完整更新日志 <span aria-hidden="true">↗</span></a></div></article>`;
    })
    .join('');
  const changes = `<div class="reading-width"><header class="page-intro"><h1>更新记录</h1><p>记录 YouYu 的功能变化、改进和修复。</p><div class="version-line">当前版本 v${version} · ${releases.length} 个已记录版本</div></header><div class="release-timeline">${timeline}</div></div>`;
  const guide = await readFile(new URL('site/pages/guide.html', root), 'utf8');
  return new Map([
    [
      'download.html',
      page('download.html', '下载', '下载 YouYu Windows x64 标准版或无桌宠版，查看安装要求和更新说明。', download)
    ],
    ['guide.html', page('guide.html', '使用指南', 'YouYu 安装、登记、订阅、双模式操作、网络修复与更新指南。', guide)],
    ['changelog.html', page('changelog.html', '更新记录', '查看 YouYu 每个版本的功能变化、改进和修复。', changes)]
  ]);
}
