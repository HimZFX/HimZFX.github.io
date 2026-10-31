/**
 * config.js — 管理后台的全局常量（ADMIN_SPEC §5.1）。
 *
 * 导入时不访问 window / document / localStorage（apiBase() 在调用时才读取），
 * 这样 Node 里的单元测试也能导入它。
 *
 * @module config
 */

/** 网站仓库（GitHub Pages 用户站点）。 */
export const REPO = Object.freeze({ owner: 'HimZFX', repo: 'HimZFX.github.io', branch: 'main' });

/** 正式环境的 GitHub API 地址。 */
export const DEFAULT_API_BASE = 'https://api.github.com';

/** localStorage / sessionStorage 里使用的键名（额外导出，供 main.js 与测试使用）。 */
export const STORAGE_KEYS = Object.freeze({
  token: 'admin.token',
  apiBase: 'admin.apiBase',
});

/**
 * 当前应使用的 API 地址（安全规则 §2.1）。
 *
 * - 正式环境永远是 https://api.github.com —— 令牌只会发往这里。
 * - 只有页面运行在 localhost / 127.0.0.1（本地开发、自动化测试）时，
 *   才允许用 localStorage['admin.apiBase'] 覆盖。
 * - 绝不从网址、查询参数、hash 或仓库内容读取 API 地址（否则别人能构造一个链接把令牌骗走）。
 *
 * @returns {string} 不带结尾 '/' 的 API 根地址
 */
export function apiBase() {
  try {
    const host = typeof location !== 'undefined' ? location.hostname : '';
    if (host === 'localhost' || host === '127.0.0.1') {
      const override = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEYS.apiBase) : null;
      if (override) {
        const u = new URL(override);
        if (u.protocol === 'http:' || u.protocol === 'https:') return override.replace(/\/+$/, '');
      }
    }
  } catch {
    // 无法访问 localStorage（隐私模式等）或地址无效 → 使用默认值
  }
  return DEFAULT_API_BASE;
}

/** 管理后台根地址，例如 https://himzfx.github.io/admin/ */
export const ADMIN_BASE = new URL('../', import.meta.url).href;
/** 第三方库目录（本地副本，不走 CDN）。 */
export const VENDOR = new URL('../vendor/', import.meta.url).href;
/** Vditor 的 cdn 选项：vendor/vditor 的绝对地址，结尾不带 '/'。 */
export const VDITOR_CDN = VENDOR + 'vditor';

/** 仓库里常用的路径。 */
export const PATHS = Object.freeze({
  content: 'content',
  posts: 'content/posts',
  images: 'static/images',
  postImages: 'static/images/posts',
  pageImages: 'static/images/pages',
  documents: 'static/documents',
  avatar: 'static/avatar.jpg',
  favicon: 'static/favicon.jpg',
  params: 'config/_default/params.toml',
  languages: 'config/_default/languages.toml',
  hugo: 'config/_default/hugo.toml',
  effects: 'assets/js/background/effects',
  bgCore: 'assets/js/background/core.js',
  gitignore: '.gitignore',
});

/** 文件大小与图片处理参数。 */
export const LIMITS = Object.freeze({
  warnFileMB: 25,
  maxFileMB: 95,
  imageMaxWidth: 1920,
  imageQuality: 0.85,
  avatarSize: 512,
  faviconSize: 128,
});

/** 语言 → 「中文站 / 英文站」 */
export const SITE_LABELS = Object.freeze({ zh: '中文站', en: '英文站' });
/** 语言 → 「中文 / 英文」 */
export const LANG_NAMES = Object.freeze({ zh: '中文', en: '英文' });

/** 创建 fine-grained 令牌的页面。 */
export const TOKEN_HELP_URL = 'https://github.com/settings/personal-access-tokens/new';
