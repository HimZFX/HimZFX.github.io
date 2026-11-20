/**
 * views/research.js — 「研究」（#/research?tab=overview|publications|talks）：网站菜单 Research ▾ 下的页面。
 *
 *   概览（overview）：Research 栏目页本身（content/research/_index*.md），「编辑」打开编辑器。
 *   论文（publications）、报告与海报（talks）：views/academic.js 的对应部分（data/*.yaml）+「在菜单里显示（放在 Research ▾ 下）」开关。
 *
 * @module views/research
 */

import { mountTabHost, pageVersionsPanel } from '../tabhost.js';
import { idFromPath, SECTIONS } from '../academic.js';

export default function mount(container, params, ctx) {
  const count = (kind) => () => ctx.repo.list(SECTIONS[kind].dataDir + '/').filter((e) => idFromPath(e.path, SECTIONS[kind].dataDir)).length;
  return mountTabHost(container, params, ctx, {
    route: 'research',
    title: '研究',
    label: '研究',
    tabs: [
      {
        id: 'overview', label: '概览', icon: 'page',
        mount: pageVersionsPanel({
          groupKey: 'content/research/_index', title: '研究概览（Research 页面）', testid: 'research-page',
          desc: '网站菜单里的「Research」页面本身（研究方向、项目介绍）。点「编辑」修改文字。论文、报告与海报在旁边的标签页里管理，打开它们的菜单开关后会出现在 Research ▾ 下拉菜单里。',
        }),
      },
      { id: 'publications', label: '论文', icon: 'post', load: () => import('./academic.js'), params: { section: 'publications' }, count: count('publications') },
      { id: 'talks', label: '报告与海报', icon: 'clock', load: () => import('./academic.js'), params: { section: 'talks' }, count: count('talks') },
    ],
  });
}
