/**
 * views/about.js — 「关于」（#/about?tab=me|news）：网站菜单 About ▾ 下的页面。
 *
 *   关于我（me）：About 页面本身（content/about.md 和各语言版本），「编辑」打开编辑器，「在网站上查看」。
 *   近况（news）：data/news/*.yaml（views/academic.js 的 news 部分）+「在菜单里显示（放在 About ▾ 下）」开关。
 *
 * @module views/about
 */

import { mountTabHost, pageVersionsPanel } from '../tabhost.js';
import { idFromPath, SECTIONS } from '../academic.js';

export default function mount(container, params, ctx) {
  const count = (kind) => () => ctx.repo.list(SECTIONS[kind].dataDir + '/').filter((e) => idFromPath(e.path, SECTIONS[kind].dataDir)).length;
  return mountTabHost(container, params, ctx, {
    route: 'about',
    title: '关于',
    label: '关于',
    tabs: [
      {
        id: 'me', label: '关于我', icon: 'user',
        mount: pageVersionsPanel({
          groupKey: 'content/about', title: '关于我（About 页面）', testid: 'about-page',
          desc: '网站菜单里的「About」页面本身。点「编辑」修改文字；中英文是两个文件时分别编辑。下拉菜单 About ▾ 里的其他页面（近况等）在旁边的标签页里管理。',
        }),
      },
      { id: 'news', label: '近况', icon: 'send', load: () => import('./academic.js'), params: { section: 'news' }, count: count('news') },
    ],
  });
}
