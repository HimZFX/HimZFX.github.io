/**
 * views/settings.js — 「设置」（#/settings?tab=home|background|pages）：不常改的网站设置。
 *
 *   首页（home）：views/profile.js（头像、名字简介、按钮、简历、社交链接）
 *   背景动画（background）：views/background.js
 *   菜单与页面（pages）：views/pages.js（顶部菜单的树：4 个栏目和它们下拉菜单里的页面、顺序；其他页面；新建栏目）
 *
 * 每个标签页的「未保存的修改」提醒照常工作：切换标签页、离开「设置」时都会问。
 *
 * @module views/settings
 */

import { mountTabHost } from '../tabhost.js';

export default function mount(container, params, ctx) {
  return mountTabHost(container, params, ctx, {
    route: 'settings',
    title: '设置',
    label: '设置',
    tabs: [
      { id: 'home', label: '首页', icon: 'home', load: () => import('./profile.js') },
      { id: 'background', label: '背景动画', icon: 'background', load: () => import('./background.js') },
      { id: 'pages', label: '菜单与页面', icon: 'menu', load: () => import('./pages.js') },
    ],
  });
}
