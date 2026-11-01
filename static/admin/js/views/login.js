/**
 * views/login.js — 登录页（ADMIN_SPEC §6.1）。
 *
 * ctx（由 main.js 提供，和其他视图的 ctx 不同）：
 *   { notice?: string, remember?: boolean, repoName: string, siteUrl: string, login(token, remember): Promise<void> }
 * remember：「在此设备上记住」的默认值（默认不勾选：记住的令牌存在整个网站共用的浏览器存储里，
 * 网站页面上加载的第三方脚本也能读到）。
 * login() 失败时 reject，message 是可以直接展示的中文；成功后由 main.js 切换整个页面。
 *
 * @module views/login
 */

import { h, svgIcon } from '../ui.js';
import { TOKEN_HELP_URL } from '../config.js';

/**
 * @param {HTMLElement} container
 * @param {object} params
 * @param {{ notice?: string, repoName?: string, siteUrl?: string, login: (token: string, remember: boolean) => Promise<void> }} ctx
 */
export default async function mount(container, params, ctx) {
  const repoName = ctx.repoName || 'HimZFX/HimZFX.github.io';
  let unmounted = false;

  // --- 表单 -------------------------------------------------------------
  const tokenInput = h('input', {
    class: 'input login-token-input',
    id: 'login-token',
    type: 'password',
    name: 'token',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    placeholder: 'github_pat_…',
    'aria-describedby': 'login-token-hint',
    dataset: { testid: 'login-token' },
  });
  const toggleBtn = h('button', {
    type: 'button', class: 'btn btn-ghost btn-icon login-reveal', 'aria-label': '显示令牌', title: '显示 / 隐藏令牌',
    'aria-pressed': 'false',
  }, svgIcon('eye'));
  toggleBtn.addEventListener('click', () => {
    const show = tokenInput.type === 'password';
    tokenInput.type = show ? 'text' : 'password';
    toggleBtn.setAttribute('aria-pressed', String(show));
    toggleBtn.setAttribute('aria-label', show ? '隐藏令牌' : '显示令牌');
    tokenInput.focus();
  });

  const remember = h('input', {
    type: 'checkbox', id: 'login-remember', checked: ctx.remember === true,
    'aria-describedby': 'login-remember-note', dataset: { testid: 'login-remember' },
  });
  const error = h('div', { class: 'error login-error', role: 'alert', id: 'login-error', dataset: { testid: 'login-error' } });
  error.hidden = true;
  const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-block btn-lg', dataset: { testid: 'login-submit' } }, '登录');

  const showError = (msg) => {
    error.textContent = msg || '';
    error.hidden = !msg;
    tokenInput.setAttribute('aria-invalid', msg ? 'true' : 'false');
    if (msg) tokenInput.setAttribute('aria-errormessage', 'login-error');
  };
  tokenInput.addEventListener('input', () => { if (!error.hidden) showError(''); });

  let busy = false;
  const form = h('form', { class: 'stack login-form', novalidate: true, autocomplete: 'off' },
    h('div', { class: 'field' },
      h('label', { htmlFor: 'login-token' }, '访问令牌（Personal access token）'),
      h('div', { class: 'input-group' }, tokenInput, toggleBtn),
      h('div', { class: 'hint', id: 'login-token-hint' }, '粘贴你在 GitHub 上创建的令牌，通常以 github_pat_ 开头。')),
    h('div', { class: 'stack login-remember' },
      h('label', { class: 'checkbox', htmlFor: 'login-remember' },
        remember,
        h('span', {}, '在此设备上记住'),
        h('span', { class: 'muted checkbox-note' }, '（只在自己的手机 / 电脑上勾选）')),
      h('div', { class: 'hint', id: 'login-remember-note', dataset: { testid: 'login-remember-note' } },
        '不勾选：关掉这个标签页后令牌就会删除，下次再粘贴一次。勾选：下次打开不用再粘贴，但令牌会一直存在这个浏览器里，'
        + '网站页面上加载的第三方脚本（数学公式、评论区）理论上也能读到它。')),
    error,
    submit,
    h('p', { class: 'login-safe muted' },
      svgIcon('lock'),
      h('span', {}, '令牌只保存在这个浏览器里，只会发送给 GitHub。它能修改网站仓库里的所有文件（包括自动部署的设置），请像密码一样保管，不要发给别人。')));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    const token = tokenInput.value.trim();
    if (!token) {
      showError('请先粘贴令牌');
      tokenInput.focus();
      return;
    }
    busy = true;
    showError('');
    submit.disabled = true;
    submit.classList.add('is-busy');
    submit.setAttribute('aria-busy', 'true');
    tokenInput.readOnly = true;
    try {
      await ctx.login(token, remember.checked);
    } catch (err) {
      if (!unmounted) {
        showError((err && err.message) || '登录失败，请重试');
        tokenInput.focus();
        tokenInput.select();
      }
    } finally {
      busy = false;
      if (!unmounted) {
        submit.disabled = false;
        submit.classList.remove('is-busy');
        submit.removeAttribute('aria-busy');
        tokenInput.readOnly = false;
      }
    }
  });

  // --- 创建令牌的步骤 ---------------------------------------------------------
  const step = (n, title, ...body) => h('li', { class: 'login-step' },
    h('span', { class: 'login-step-num', 'aria-hidden': 'true' }, String(n)),
    h('div', { class: 'login-step-body' },
      h('div', { class: 'login-step-title' }, title),
      body.length ? h('div', { class: 'login-step-text muted' }, ...body) : null));
  const kbd = (t) => h('code', { class: 'kbd' }, t);

  const guide = h('section', { class: 'card login-guide', 'aria-labelledby': 'login-guide-title' },
    h('h2', { class: 'card-title', id: 'login-guide-title' }, '还没有令牌？按下面 5 步创建'),
    h('ol', { class: 'login-steps' },
      step(1, '打开 GitHub 的「新建令牌」页面',
        h('a', { class: 'btn btn-sm login-guide-link', href: TOKEN_HELP_URL, target: '_blank', rel: 'noopener noreferrer' },
          '打开创建页面', svgIcon('external'))),
      step(2, '填写名称和有效期',
        'Token name 随便填（例如「主页管理」）；Expiration 选一个你能接受的期限。到期后在 GitHub 的令牌页面点 ',
        kbd('Regenerate token'), '（或按这几步重新创建一个），再把新令牌粘贴进来。'),
      step(3, '只授权网站仓库',
        'Repository access 选 ', kbd('Only select repositories'), '，然后只勾选 ', kbd(repoName), '。'),
      step(4, '设置权限',
        '在 Repository permissions 里（新版页面是点 ', kbd('Add permissions'), ' 搜索添加）：把 ',
        kbd('Contents'), ' 设为 ', kbd('Read and write'), '；', kbd('Actions'), ' 设为 ', kbd('Read-only'),
        '（可选，用来显示「部署中 / 已上线」）。', kbd('Metadata: Read-only'), ' 会自动出现，是必需的，保持不动即可。'),
      step(5, '生成并粘贴',
        '点 ', kbd('Generate token'), '，复制生成的令牌（只显示一次），粘贴到登录框里。')));

  const notice = ctx.notice
    ? h('div', { class: 'banner banner-warning', role: 'status', dataset: { testid: 'login-notice' } },
      svgIcon('warning'), h('span', {}, ctx.notice))
    : null;

  container.classList.add('login-view');
  container.append(
    h('header', { class: 'login-hero' },
      h('span', { class: 'brand-mark brand-mark-lg', 'aria-hidden': 'true' }, 'H'),
      h('h1', { class: 'login-title' }, "HimZFX's Lab · 主页管理"),
      h('p', { class: 'login-subtitle muted' }, '写文章、换头像、换背景动画、上传资料——改完点「发表」或「保存并发布」，网站 1–2 分钟后自动更新。')),
    h('div', { class: 'login-grid' },
      h('section', { class: 'card login-card', 'aria-labelledby': 'login-card-title' },
        h('h2', { class: 'card-title', id: 'login-card-title' }, '用 GitHub 令牌登录'),
        notice,
        form),
      guide));

  requestAnimationFrame(() => { if (!unmounted) tokenInput.focus({ preventScroll: true }); });

  return {
    unmount() {
      unmounted = true;
      // 不在内存里多留令牌
      tokenInput.value = '';
    },
  };
}
