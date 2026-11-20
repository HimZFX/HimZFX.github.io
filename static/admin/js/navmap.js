/**
 * navmap.js — 后台导航的小工具（纯函数，Node 里可直接导入测试）：
 *   - legacyRedirect：旧地址（#/academic、#/profile、#/background、#/pages）→ 新地址；
 *   - pageHome：一个页面文件属于哪个导航项、编辑器「返回」回到哪里。
 *
 * 新的侧栏：关于（关于我 · 近况）/ 研究（概览 · 论文 · 报告与海报）/ 博客 / 课程 / ── / 资料 / 设置（首页 · 背景动画 · 菜单与页面）。
 *
 * @module navmap
 */

/** 旧路由 → 新地址。返回 null = 不是旧地址。 */
export function legacyRedirect(route, params = {}) {
  const tab = params && typeof params.tab === 'string' ? params.tab : '';
  switch (route) {
    case 'academic':
      if (tab === 'publications' || tab === 'talks') return `#/research?tab=${tab}`;
      if (tab === 'news') return '#/about?tab=news';
      return '#/research';
    case 'profile': return '#/settings?tab=home';
    case 'background': return '#/settings?tab=background';
    case 'pages': return '#/settings?tab=pages';
    default: return null;
  }
}

const LANG_SUFFIX = '(?:\\.[a-z]{2,3}(?:-[a-z0-9]+)?)?';
const ABOUT_RE = new RegExp(`^content/about${LANG_SUFFIX}\\.md$`);
const indexRe = (dir) => new RegExp(`^content/${dir}/_index${LANG_SUFFIX}\\.md$`);
const SECTION_HOMES = [
  [indexRe('research'), { route: 'research', hash: '#/research?tab=overview' }],
  [indexRe('publications'), { route: 'research', hash: '#/research?tab=publications' }],
  [indexRe('talks'), { route: 'research', hash: '#/research?tab=talks' }],
  [indexRe('news'), { route: 'about', hash: '#/about?tab=news' }],
];

/**
 * 一个（不是博客文章、也不是课程里的）页面文件属于哪个导航项。
 * @param {string} path 仓库路径，如 'content/about.en.md'
 * @returns {{ route: string, hash: string }}
 */
export function pageHome(path) {
  const p = String(path || '');
  if (ABOUT_RE.test(p)) return { route: 'about', hash: '#/about?tab=me' };
  for (const [re, home] of SECTION_HOMES) if (re.test(p)) return { ...home };
  return { route: 'settings', hash: '#/settings?tab=pages' };
}

/** 新建页面（#/edit?new=page&dir=<目录>）属于哪个导航项。 */
export function newPageHome(dir) {
  const d = String(dir || '').replace(/^\/+|\/+$/g, '').replace(/^content\//, '');
  if (!d) return { route: 'settings', hash: '#/settings?tab=pages' };
  return pageHome(`content/${d}/_index.md`);
}
