/**
 * views/courses.js — 「课程」：课程单元页、子推文、课程资料、批量上传。
 *
 * 路由：
 *   #/courses                     课程列表（有分组时按分组显示）、新建课程、调整顺序、改分组 / 分组改名
 *   #/courses?course=<网址名>      一门课：子推文（顺序、编辑、删除、新子推文）、资料列表（上传 / 删除 / 复制链接）、批量上传
 *
 * 文件约定见 courses.js（纯函数模型）。所有修改都是一次 ctx.publish（一个提交）：
 *   新建课程（_index.md + 可选 _index.en.md）、保存顺序（只改 weight 那一行，注释原样保留）、改分组、
 *   删除子推文（全部语言版本）、批量上传（文件 + 子推文一起）。
 * 上传共用 uploads.js：压缩图片、大小检查、.gitignore 提醒、拒绝网页 / 脚本 / SVG。
 *
 * 安全：界面全部用 h() / textContent 生成；链接只由 ctx.siteUrl + 编码后的路径拼成。
 *
 * @module views/courses
 */

import { PATHS, LIMITS } from '../config.js';
import {
  h, svgIcon, render, clear, toast, modal, confirmDialog, promptDialog, withBusy, badge, emptyState,
  errorState, errorMessage, formatBytes, copyText,
} from '../ui.js';
import {
  languageStatus, statusText, resolveForLang, isDraftFm, isValidSlug, sitePathFor, referencesSitePath, variantPath,
} from '../content.js';
import { safeFileName, extOf } from '../images.js';
import {
  COURSES_DIR, OTHER_GROUP, collectCourses, weightOf, groupOf, sortByWeight, groupCourses, reweight, nextWeights,
  titleFromFileName, itemSlugFor, courseSlugSuggestion, materialsDirFor, showMaterialsOf, courseIndexDocument,
  itemDocument, itemBodyFor, patchFields, frontMatterOf, canonicalGroup, courseDeletionPlan, COURSE_MATERIALS_ROOT,
} from '../courses.js';
import {
  MAX_BYTES, COMPRESSIBLE, isJunkFile, baseNameOf, staticFileUrl, staticPreviewUrl, usesViewer, prepareUpload,
  assignUniqueNames, checkUploads, needsReview, gitignoreMatcher, uploadReviewSections, refusedContent,
  uploadBlockReason, deleteStaticFile,
} from '../uploads.js';
import { readFrontMatters, editHash, skeletonRows } from './posts.js';

const COMPRESS_PREF_KEY = 'admin.files.compress';
const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp']);

function readPref(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v === '1';
  } catch { return fallback; }
}
function writePref(key, on) {
  try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* ignore */ }
}

function kindOf(name) {
  const ext = extOf(name);
  if (ext === 'pdf') return 'pdf';
  if (IMAGE_EXTS.has(ext) || ext === 'heic' || ext === 'heif') return 'image';
  return 'other';
}

function moveIn(list, index, dir) {
  const j = index + dir;
  if (j < 0 || j >= list.length) return list;
  const out = [...list];
  [out[index], out[j]] = [out[j], out[index]];
  return out;
}

/**
 * @param {HTMLElement} container
 * @param {{ course?: string }} params
 * @param {object} ctx
 */
export default async function mount(container, params, ctx) {
  const repo = ctx.repo;
  const langs = ctx.langs && ctx.langs.length ? ctx.langs : ['zh', 'en'];
  const slug = params && params.course ? String(params.course) : '';
  const state = {
    courses: null,          // 加载好的课程；null = 加载中
    loadError: null,
    loadSeq: 0,
    disposed: false,
    courseOrder: null,      // 列表页：调整中的顺序（课程网址名，按显示顺序）
    itemOrder: null,        // 详情页：调整中的子推文顺序（页面组 key）
    saving: false,
    uses: new Map(),        // 资料网站路径 → [子推文标题]
    usesSeq: 0,
    pendingBatch: null,     // 批量上传因冲突 / 失败没有完成时保留，可以「重试」
    compress: readPref(COMPRESS_PREF_KEY, true),
  };

  ctx.setTitle('课程');
  container.classList.add('courses-view', 'stack');

  const host = h('div', { class: 'stack courses-host' });
  render(container, host);
  render(host, h('ul', { class: 'list' }, skeletonRows(3)));

  let changeTimer = null;
  const unsubscribe = repo.onChange(() => {
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => { if (!state.disposed) load(); }, 0);
  });

  // ---- 拖放：详情页任何地方放下文件 → 批量上传 ----
  const hasFiles = (e) => !!e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  const onDragOver = (e) => { if (slug && hasFiles(e)) { e.preventDefault(); container.classList.add('is-drag-over'); } };
  const onDragLeave = (e) => { if (e.target === container) container.classList.remove('is-drag-over'); };
  const onDrop = (e) => {
    if (!slug || !hasFiles(e)) return;
    e.preventDefault();
    container.classList.remove('is-drag-over');
    const files = [...(e.dataTransfer.files || [])].filter((f) => f.size > 0 || f.type);
    if (files.length) startBatch(files, 'item');
  };
  const blockWindowDrop = (e) => { if (hasFiles(e)) e.preventDefault(); };
  container.addEventListener('dragover', onDragOver);
  container.addEventListener('dragleave', onDragLeave);
  container.addEventListener('drop', onDrop);
  window.addEventListener('dragover', blockWindowDrop);
  window.addEventListener('drop', blockWindowDrop);

  // =========================================================================
  // 数据

  async function load() {
    const seq = ++state.loadSeq;
    const raw = collectCourses(repo.list(PATHS.content + '/'), langs);
    const paths = raw.flatMap((c) => [
      ...(c.index ? Object.values(c.index.variants) : []),
      ...c.items.flatMap((g) => Object.values(g.variants)),
    ]);
    let fms;
    try {
      fms = await readFrontMatters(repo, paths);
    } catch (err) {
      if (state.disposed || seq !== state.loadSeq) return;
      state.loadError = err;
      renderAll();
      return;
    }
    if (state.disposed || seq !== state.loadSeq) return;
    state.loadError = null;
    state.courses = raw.map((c) => buildCourse(c, fms));
    // 已经不存在的调整丢掉
    if (state.courseOrder && (state.courseOrder.length !== state.courses.length ||
      state.courseOrder.some((s) => !state.courses.find((c) => c.slug === s)))) state.courseOrder = null;
    const cur = currentCourse();
    if (state.itemOrder && (!cur || state.itemOrder.length !== cur.items.length ||
      state.itemOrder.some((k) => !cur.items.find((it) => it.key === k)))) state.itemOrder = null;
    renderAll();
    if (cur) loadUses(cur);
  }

  function fmOfPath(fms, p) {
    const r = p && fms.get(p);
    return r ? r.fm || {} : {};
  }

  function buildCourse(c, fms) {
    const variants = c.index ? c.index.variants : {};
    const mainPath = (c.index && (resolveForLang(c.index, ctx.defaultLang) || Object.values(variants)[0])) || null;
    const fm = fmOfPath(fms, mainPath);
    const perLang = langs.map((lang) => {
      const p = c.index ? resolveForLang(c.index, lang) : null;
      const f = fmOfPath(fms, p);
      return { lang, path: p, fm: f, title: typeof f.title === 'string' ? f.title.trim() : '' };
    });
    const errors = Object.values(variants).map((p) => ({ p, r: fms.get(p) })).filter((x) => x.r && x.r.error).map((x) => `${x.p}：${x.r.error}`);
    const items = sortByWeight(c.items.map((g) => {
      const p = resolveForLang(g, ctx.defaultLang) || Object.values(g.variants)[0];
      const f = fmOfPath(fms, p);
      return {
        key: g.key, group: g, path: p, fm: f, base: g.base,
        title: (typeof f.title === 'string' && f.title.trim()) || g.base,
        description: typeof f.description === 'string' ? f.description.trim() : '',
        weight: weightOf(f),
        draft: isDraftFm(f),
        status: languageStatus(g, langs),
        error: (fms.get(p) || {}).error || null,
        variantPaths: Object.values(g.variants),
      };
    }));
    const materialsDir = materialsDirFor(c.slug, fm);
    const materials = repo.list(materialsDir + '/')
      .filter((e) => !e.path.slice(materialsDir.length + 1).includes('/'))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return {
      slug: c.slug, dir: c.dir, index: c.index, hasIndex: c.hasIndex, mainPath, fm, perLang, errors,
      title: (typeof fm.title === 'string' && fm.title.trim()) || c.slug,
      description: typeof fm.description === 'string' ? fm.description.trim() : '',
      group: groupOf(fm),
      weight: weightOf(fm),
      draft: !!mainPath && isDraftFm(fm),
      status: c.index ? languageStatus(c.index, langs) : null,
      indexPaths: Object.values(variants),
      materialsDir,
      showMaterials: showMaterialsOf(fm),
      materials,
      items,
    };
  }

  function currentCourse() {
    return slug && state.courses ? state.courses.find((c) => c.slug === slug) || null : null;
  }

  /** 哪些子推文用到了哪些资料（读子推文正文；失败就不显示）。 */
  async function loadUses(course) {
    const seq = ++state.usesSeq;
    const out = new Map();
    for (const it of course.items) {
      let text = '';
      try { text = await repo.readText(it.path); } catch { continue; }
      for (const m of course.materials) {
        const sp = sitePathFor(m.path);
        if (referencesSitePath(text, sp)) {
          if (!out.has(sp)) out.set(sp, []);
          out.get(sp).push(it);
        }
      }
    }
    if (state.disposed || seq !== state.usesSeq) return;
    state.uses = out;
    for (const row of container.querySelectorAll('[data-testid="material-row"]')) {
      const used = out.get(row.dataset.site) || [];
      const slot = row.querySelector('.courses-material-used');
      if (slot) render(slot, usedLinks(used));
    }
  }

  // =========================================================================
  // 渲染

  function renderAll() {
    if (state.disposed) return;
    if (state.loadError) {
      render(host, h('div', { class: 'card' }, errorState('课程读取失败', {
        detail: errorMessage(state.loadError),
        retry: () => { state.loadError = null; render(host, h('ul', { class: 'list' }, skeletonRows(3))); load(); },
      })));
      return;
    }
    if (!state.courses) return;
    if (slug) renderDetail();
    else renderList();
    document.body.dataset.coursesReady = slug ? 'detail' : 'list';
  }

  // ---- 列表 ----

  function orderedCourses() {
    const all = state.courses || [];
    if (!state.courseOrder) {
      return groupCourses(all);
    }
    // 调整中：按调整后的顺序，分组按第一次出现的顺序
    const bySlug = new Map(all.map((c) => [c.slug, c]));
    const list = state.courseOrder.map((s) => bySlug.get(s)).filter(Boolean);
    if (!list.some((c) => c.group)) return [{ name: null, courses: list }];
    const groups = new Map();
    for (const c of list) {
      const name = c.group || OTHER_GROUP;
      const key = c.group ? 'g:' + c.group : 'other';
      if (!groups.has(key)) groups.set(key, { name, other: !c.group, courses: [] });
      groups.get(key).courses.push(c);
    }
    const out = [...groups.values()];
    // 「其他」永远在最后（和网站一致）
    return [...out.filter((g) => !g.other), ...out.filter((g) => g.other)];
  }

  function flatOrder(groups) {
    return groups.flatMap((g) => g.courses.map((c) => c.slug));
  }

  function courseOrderChanged() {
    if (!state.courseOrder) return [];
    const target = reweight(state.courseOrder, new Map(state.courses.map((c) => [c.slug, c.weight])));
    // 没有介绍页（_index.md）的课程改不了顺序，不算
    return state.courses.filter((c) => c.indexPaths.length && target.get(c.slug) !== c.weight)
      .map((c) => ({ course: c, weight: target.get(c.slug) }));
  }

  function renderList() {
    const all = state.courses;
    const landing = PATHS.content + '/courses/_index.md';
    const hasLanding = repo.has(landing) || langs.some((l) => repo.has(variantPath(COURSES_DIR, '_index', l)));
    const newBtn = h('button', { type: 'button', class: 'btn btn-primary', dataset: { testid: 'courses-new' } }, svgIcon('plus'), '新建课程');
    newBtn.addEventListener('click', () => openNewCourse());
    const refreshBtn = refreshButton();

    const header = h('div', { class: 'page-header' },
      h('div', {},
        h('h1', {}, '课程'),
        h('p', { class: 'page-desc' }, '每门课是网站「课程资料」里的一个单元：有自己的介绍、资料列表，需要的话还可以有子推文（例如每个实验一篇报告）。')),
      h('div', { class: 'actions' }, refreshBtn, newBtn));

    const landingNote = h('div', { class: 'courses-landing muted small', dataset: { testid: 'courses-landing' } },
      svgIcon('info', { size: 14 }),
      hasLanding
        ? h('span', {}, '网站上的「课程资料」页（/courses/）会按这里的顺序列出课程卡片，上面是你写的说明文字。',
          h('a', { href: editHash(repo.has(landing) ? landing : variantPath(COURSES_DIR, '_index', langs.find((l) => repo.has(variantPath(COURSES_DIR, '_index', l))))), dataset: { testid: 'courses-edit-landing' } }, '编辑说明文字'))
        : h('span', {}, '还没有「课程资料」总页（content/courses/_index.md）。可以在「页面」里新建一个网址为 courses 的栏目。'));

    if (!all.length) {
      render(host, header, landingNote, h('div', { class: 'card', dataset: { testid: 'courses-empty' } },
        emptyState('还没有课程。新建一门课，它就会出现在网站的「课程资料」页上。', { text: '新建课程', onClick: () => openNewCourse(), icon: 'plus' }, { icon: 'course' })));
      return;
    }

    const groups = orderedCourses();
    const grouped = groups.length > 1 || (groups[0] && groups[0].name);
    const sections = groups.map((g, gi) => {
      const rows = g.courses.map((c, i) => courseRow(c, { index: i, count: g.courses.length, group: g }));
      let head = null;
      if (grouped) {
        const up = h('button', {
          type: 'button', class: 'btn btn-ghost btn-sm btn-icon', 'aria-label': `把分组「${g.name}」往前移`, title: '整组往前移',
          dataset: { testid: 'group-up' }, disabled: gi === 0 || g.other || undefined,
        }, svgIcon('up'));
        const down = h('button', {
          type: 'button', class: 'btn btn-ghost btn-sm btn-icon', 'aria-label': `把分组「${g.name}」往后移`, title: '整组往后移',
          dataset: { testid: 'group-down' }, disabled: gi >= groups.length - 1 || g.other || (groups[gi + 1] && groups[gi + 1].other) || undefined,
        }, svgIcon('down'));
        up.addEventListener('click', () => moveGroup(groups, gi, -1));
        down.addEventListener('click', () => moveGroup(groups, gi, +1));
        const rename = !g.other ? h('button', {
          type: 'button', class: 'btn btn-ghost btn-sm', dataset: { testid: 'group-rename' }, title: '给这个分组改名（这组所有课程一起改）',
        }, svgIcon('edit'), h('span', { class: 'courses-btn-text' }, '改名')) : null;
        if (rename) rename.addEventListener('click', () => withBusy(rename, () => renameGroup(g.name)));
        head = h('div', { class: 'courses-group-head', dataset: { testid: 'courses-group', name: g.name } },
          h('h2', { class: 'courses-group-title' }, svgIcon('folder', { size: 15 }), h('span', {}, g.name),
            h('span', { class: 'muted small' }, `${g.courses.length} 门`)),
          h('div', { class: 'courses-group-actions' }, rename, groups.filter((x) => !x.other).length > 1 && !g.other ? [up, down] : null));
      }
      return h('section', { class: 'card courses-group', dataset: { testid: 'courses-section', name: g.name || '' } },
        head,
        h('ul', { class: 'list courses-list', dataset: { testid: 'courses-list' } }, rows));
    });

    const changed = courseOrderChanged();
    const saveBtn = h('button', { type: 'button', class: 'btn btn-primary', dataset: { testid: 'courses-save-order' }, disabled: state.saving || !changed.length || undefined }, svgIcon('check'), '保存顺序');
    const resetBtn = h('button', { type: 'button', class: 'btn btn-ghost', dataset: { testid: 'courses-reset-order' } }, '撤销');
    saveBtn.addEventListener('click', () => withBusy(saveBtn, saveCourseOrder));
    resetBtn.addEventListener('click', () => { state.courseOrder = null; renderAll(); });
    const saveBar = state.courseOrder ? h('div', { class: ['lists-savebar', changed.length && 'is-dirty'], dataset: { testid: 'courses-savebar' } },
      h('span', { class: 'muted small lists-save-hint' }, changed.length ? `调整了 ${changed.length} 门课的顺序，还没有保存` : '顺序没有变化'),
      h('div', { class: 'row' }, resetBtn, saveBtn)) : null;

    render(host, header, landingNote,
      grouped ? null : h('p', { class: 'muted small courses-hint' }, '想把课程分成几组（例如「实验课」「理论课」「大三」）？在课程的「分组」里填上同一个名字就行。'),
      ...sections, saveBar);
  }

  /** 刷新按钮（重新读取 GitHub 上的最新内容；有没保存的顺序时先确认）。 */
  function refreshButton() {
    const btn = h('button', {
      type: 'button', class: 'btn btn-ghost btn-icon', 'aria-label': '刷新（重新读取网站内容）', title: '刷新',
      dataset: { testid: 'courses-refresh' },
    }, svgIcon('refresh'));
    btn.addEventListener('click', () => withBusy(btn, async () => {
      if ((state.courseOrder || state.itemOrder) && !(await confirmDialog({ title: '放弃没保存的顺序？', message: '刷新会重新读取网站上的内容，你刚才调整的顺序还没有保存。', okText: '放弃并刷新', danger: true }))) return;
      state.courseOrder = null;
      state.itemOrder = null;
      try { await repo.load(); toast('已是最新内容', { type: 'success' }); renderAll(); } catch (err) { toast(`刷新失败：${errorMessage(err)}`, { type: 'error' }); }
    }));
    return btn;
  }

  function courseRow(c, { index, count }) {
    const up = h('button', {
      type: 'button', class: 'btn btn-ghost btn-sm btn-icon', 'aria-label': `把「${c.title}」往前移`, title: '往前移',
      dataset: { testid: 'course-up' }, disabled: index === 0 || undefined,
    }, svgIcon('up'));
    const down = h('button', {
      type: 'button', class: 'btn btn-ghost btn-sm btn-icon', 'aria-label': `把「${c.title}」往后移`, title: '往后移',
      dataset: { testid: 'course-down' }, disabled: index === count - 1 || undefined,
    }, svgIcon('down'));
    up.addEventListener('click', () => moveCourse(c.slug, -1));
    down.addEventListener('click', () => moveCourse(c.slug, +1));
    const groupBtn = h('button', { type: 'button', class: 'btn btn-ghost btn-sm', dataset: { testid: 'course-group' }, title: '设置分组', 'aria-label': `设置「${c.title}」的分组` },
      svgIcon('tag'), h('span', { class: 'courses-btn-text' }, '分组'));
    groupBtn.addEventListener('click', () => withBusy(groupBtn, () => changeCourseGroup(c)));
    const detail = '#/courses?course=' + encodeURIComponent(c.slug);
    const langBadge = c.status ? badge(statusText(c.status, ctx), c.status.kind === 'split' ? 'blue' : 'gray') : badge('没有介绍页', 'orange');
    return h('li', { class: 'list-item courses-row', dataset: { testid: 'course-row', slug: c.slug } },
      h('div', { class: 'list-item-main' },
        h('a', { class: 'list-item-title', href: detail, dataset: { testid: 'course-title' } }, c.title),
        c.description ? h('div', { class: 'courses-desc', dataset: { testid: 'course-desc' } }, c.description) : null,
        h('div', { class: 'list-item-meta' },
          h('span', { class: 'lists-meta-item', dataset: { testid: 'course-count-items' } }, svgIcon('post'), `${c.items.length} 篇子推文`),
          h('span', { class: 'lists-meta-item', dataset: { testid: 'course-count-materials' } }, svgIcon('files'), `${c.materials.length} 个资料`),
          langBadge,
          c.draft ? (() => { const b = badge('草稿（网站上不显示）', 'gray'); b.dataset.testid = 'course-draft'; return b; })() : null,
          c.errors.length ? (() => { const b = badge('设置区有问题', 'red'); b.title = c.errors.join('\n'); return b; })() : null)),
      h('div', { class: 'list-item-actions courses-row-actions' },
        h('div', { class: 'lists-order' }, up, down),
        groupBtn,
        h('a', { class: 'btn btn-sm', href: detail, dataset: { testid: 'course-open' } }, svgIcon('chevron-right'), '打开')));
  }

  function currentFlat() {
    return state.courseOrder ? [...state.courseOrder] : flatOrder(groupCourses(state.courses));
  }

  function moveCourse(s, dir) {
    const groups = orderedCourses();
    const g = groups.find((x) => x.courses.some((c) => c.slug === s));
    if (!g) return;
    const idx = g.courses.findIndex((c) => c.slug === s);
    const j = idx + dir;
    if (j < 0 || j >= g.courses.length) return;
    const flat = flatOrder(groups);
    const a = flat.indexOf(s);
    const b = flat.indexOf(g.courses[j].slug);
    [flat[a], flat[b]] = [flat[b], flat[a]];
    setCourseOrder(flat);
    focusAfter(`[data-testid="course-row"][data-slug="${CSS.escape(s)}"] [data-testid="${dir < 0 ? 'course-up' : 'course-down'}"]`);
  }

  function moveGroup(groups, gi, dir) {
    const j = gi + dir;
    if (j < 0 || j >= groups.length || groups[gi].other || groups[j].other) return;
    const arr = moveIn(groups, gi, dir);
    setCourseOrder(flatOrder(arr));
    focusAfter(`[data-testid="courses-group"][data-name="${CSS.escape(groups[gi].name)}"] [data-testid="${dir < 0 ? 'group-up' : 'group-down'}"]`);
  }

  function setCourseOrder(flat) {
    const base = flatOrder(groupCourses(state.courses));
    state.courseOrder = flat.join('\n') === base.join('\n') ? null : flat;
    renderAll();
  }

  function focusAfter(selector) {
    const el = container.querySelector(selector);
    if (el && !el.disabled) try { el.focus({ preventScroll: true }); } catch { /* ignore */ }
  }

  /** 保存课程顺序：一个提交，只改 weight 那一行（各语言版本一起改）。 */
  async function saveCourseOrder() {
    const changed = courseOrderChanged();
    if (!changed.length) return;
    const changes = [];
    const summary = [];
    try {
      for (const { course, weight } of changed) {
        for (const p of course.indexPaths) {
          const entry = repo.entry(p);
          if (!entry) continue;
          const text = await repo.readText(p);
          const out = patchFields(text, { weight }, p);
          if (out !== text) changes.push({ path: p, content: out, baseSha: entry.sha });
        }
        summary.push(`${course.title}：${course.weight ?? '未设置'} → ${weight}`);
      }
    } catch (err) {
      toast(errorMessage(err), { type: 'error', timeout: 9000 });
      return;
    }
    if (!changes.length) { state.courseOrder = null; renderAll(); return; }
    state.saving = true;
    let res;
    try {
      res = await ctx.publish({ message: 'admin: 调整课程顺序', changes, summary });
    } catch {
      return; // 外壳已提示；调整保留
    } finally {
      state.saving = false;
    }
    if (res && res.conflict) {
      if (res.reloaded) toast('已读取最新内容，你调整的顺序还在，确认后再点一次「保存顺序」', { type: 'info', timeout: 6000 });
      renderAll();
      return;
    }
    state.courseOrder = null;
    renderAll();
  }

  /** 已有的分组名（datalist 用）。 */
  function existingGroups() {
    const set = new Set();
    for (const c of state.courses || []) {
      if (c.group) set.add(c.group);
      for (const v of c.perLang) { const g = groupOf(v.fm); if (g) set.add(g); }
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }

  function groupInput(value, testid) {
    const id = 'dl-groups-' + Math.random().toString(36).slice(2);
    const input = h('input', {
      class: 'input', type: 'text', value: value || '', maxlength: 40, autocomplete: 'off', list: id,
      placeholder: '例如：实验课、理论课、讨论班、大三', dataset: { testid },
    });
    const dl = h('datalist', { id }, existingGroups().map((g) => h('option', { value: g })));
    return { input, el: h('div', { class: 'courses-group-input' }, input, dl) };
  }

  function guardOrder() {
    if (state.courseOrder || state.itemOrder) {
      toast('请先保存或撤销刚才调整的顺序', { type: 'warning' });
      return false;
    }
    if (ctx.isPublishing && ctx.isPublishing()) { toast('正在发布，请稍候', { type: 'warning' }); return false; }
    return true;
  }

  /** 改一门课的分组：默认语言版本，以及分组名和它一样（或没有分组）的其他语言版本。 */
  async function changeCourseGroup(c) {
    if (!guardOrder()) return;
    if (!c.indexPaths.length) { toast('这门课还没有介绍页（_index.md），请先在编辑器里创建', { type: 'warning' }); return; }
    const gi = groupInput(c.group, 'course-group-input');
    const value = await new Promise((resolve) => {
      let result = null;
      const m = modal({
        title: `「${c.title}」的分组`,
        testid: 'course-group-dialog',
        content: h('div', { class: 'stack-sm' },
          h('div', { class: 'field' },
            h('label', {}, '分组名', h('span', { class: 'optional' }, '（可选）')),
            gi.el,
            h('div', { class: 'hint' }, '自由填写，同名的课程在网站上放在一起；留空 = 不分组（有其他分组时放在最后的「其他」里）。'))),
        actions: [
          { text: '取消', kind: 'ghost', testid: 'course-group-cancel' },
          { text: '保存', kind: 'primary', testid: 'course-group-ok', onClick: (close) => { result = gi.input.value.trim(); close(); } },
        ],
        onClose: () => resolve(result),
      });
      gi.input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); result = gi.input.value.trim(); m.close(); } });
    });
    if (value === null) return;
    const canon = canonicalGroup(value, existingGroups());
    if (canon === c.group) return;
    return applyCourseGroup(c, canon);
  }

  async function applyCourseGroup(c, value) {
    const changes = [];
    try {
      for (const p of c.indexPaths) {
        const entry = repo.entry(p);
        if (!entry) continue;
        const text = await repo.readText(p);
        const old = groupOf(parseFm(text));
        if (p !== c.mainPath && old && old !== c.group) continue; // 其他语言自己写了分组名（例如英文）：不动
        const out = patchFields(text, { group: value || undefined }, p);
        if (out !== text) changes.push({ path: p, content: out, baseSha: entry.sha });
      }
    } catch (err) { toast(errorMessage(err), { type: 'error', timeout: 9000 }); return; }
    if (!changes.length) return;
    try {
      await ctx.publish({
        message: value ? `admin: 课程《${c.title}》分组改为「${value}」` : `admin: 课程《${c.title}》取消分组`,
        changes, summary: changes.map((x) => x.path),
      });
    } catch { /* 外壳已提示 */ }
  }

  function parseFm(text) {
    try { return frontMatter(text); } catch { return {}; }
  }

  /** 分组改名：所有分组名等于旧名字的文件一起改（一个提交）。 */
  async function renameGroup(oldName) {
    if (!guardOrder()) return;
    const name = await promptDialog({
      title: `分组「${oldName}」改名`, label: '新的分组名', value: oldName, okText: '改名',
      hint: '这个分组里的所有课程会一起改。',
      validate: (v) => (!v.trim() ? '请填写分组名' : v.trim().length > 40 ? '分组名太长了' : null),
    });
    if (name === null) return;
    // 改成和另一个已有分组只差大小写 / 空格的名字 = 合并进那个分组（用它的写法）
    const newName = canonicalGroup(name, existingGroups().filter((g) => g !== oldName));
    if (!newName || newName === oldName) return;
    const changes = [];
    try {
      for (const c of state.courses) {
        for (const p of c.indexPaths) {
          const entry = repo.entry(p);
          if (!entry) continue;
          const text = await repo.readText(p);
          if (groupOf(parseFm(text)) !== oldName) continue;
          const out = patchFields(text, { group: newName }, p);
          if (out !== text) changes.push({ path: p, content: out, baseSha: entry.sha });
        }
      }
    } catch (err) { toast(errorMessage(err), { type: 'error', timeout: 9000 }); return; }
    if (!changes.length) return;
    try {
      await ctx.publish({ message: `admin: 课程分组「${oldName}」改名为「${newName}」`, changes, summary: changes.map((x) => x.path) });
    } catch { /* 外壳已提示 */ }
  }

  // ---- 新建课程 ----

  function openNewCourse() {
    if (ctx.isPublishing && ctx.isPublishing()) { toast('正在发布，请稍候', { type: 'warning' }); return; }
    const other = langs.find((l) => l !== ctx.defaultLang) || null;
    let slugTouched = false;
    const mk = (id, label, input, { hint, optional } = {}) => {
      const err = h('div', { class: 'error', role: 'alert' });
      err.hidden = true;
      input.id = id;
      return {
        el: h('div', { class: 'field' }, h('label', { htmlFor: id }, label, optional ? h('span', { class: 'optional' }, '（可选）') : null), input, hint ? h('div', { class: 'hint' }, hint) : null, err),
        setError(msg) { err.textContent = msg || ''; err.hidden = !msg; input.setAttribute('aria-invalid', msg ? 'true' : 'false'); },
      };
    };
    const zh = h('input', { class: 'input', type: 'text', maxlength: 80, autocomplete: 'off', placeholder: '例如：近代物理实验', 'data-autofocus': true, dataset: { testid: 'new-course-name-zh' } });
    const en = h('input', { class: 'input', type: 'text', maxlength: 80, autocomplete: 'off', placeholder: 'e.g. Modern Physics Lab', dataset: { testid: 'new-course-name-en' } });
    const slugIn = h('input', { class: 'input mono', type: 'text', maxlength: 60, autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'modern-physics-lab', dataset: { testid: 'new-course-slug' } });
    const urlPreview = h('div', { class: 'hint lists-url-preview', dataset: { testid: 'new-course-url' } });
    const gi = groupInput('', 'new-course-group');
    const desc = h('input', { class: 'input', type: 'text', maxlength: 160, autocomplete: 'off', placeholder: '一句话介绍，显示在课程卡片上', dataset: { testid: 'new-course-desc' } });
    const descEn = h('input', { class: 'input', type: 'text', maxlength: 160, autocomplete: 'off', placeholder: 'One line for the English site', dataset: { testid: 'new-course-desc-en' } });
    const fZh = mk('nc-zh', `${ctx.langName(ctx.defaultLang)}名称`, zh);
    const fEn = other ? mk('nc-en', `${ctx.langName(other)}名称`, en, { optional: true, hint: `填了就同时生成${ctx.siteLabel(other)}的版本（_index.${other}.md），并用它生成网址` }) : null;
    const fSlug = mk('nc-slug', '网址', slugIn, { hint: '只能用小写英文字母、数字和 -，以后不能改' });
    fSlug.el.appendChild(urlPreview);
    const fGroup = mk('nc-group', '分组', gi.input, { optional: true, hint: '自由填写，例如「实验课」「理论课」「大三」；同名的课程在网站上放在一起。不填也可以。' });
    // groupInput 自带 datalist：把它放回字段里
    fGroup.el.insertBefore(gi.el, fGroup.el.children[1] || null);
    const fDesc = mk('nc-desc', '一句话简介', desc, { optional: true });
    const fDescEn = other ? mk('nc-desc-en', `${ctx.langName(other)}简介`, descEn, { optional: true, hint: `只在填了${ctx.langName(other)}名称时使用` }) : null;

    const updatePreview = () => {
      const s = slugIn.value.trim();
      urlPreview.textContent = s ? '网站上的地址：' + langs.map((l) => `/${l === ctx.defaultLang ? '' : l + '/'}courses/${s}/`).join('  ·  ') : '';
    };
    const suggest = () => {
      if (slugTouched) return;
      slugIn.value = courseSlugSuggestion(en.value, zh.value);
      updatePreview();
    };
    zh.addEventListener('input', () => { fZh.setError(null); suggest(); });
    en.addEventListener('input', () => { suggest(); });
    slugIn.addEventListener('input', () => { slugTouched = slugIn.value.trim() !== ''; fSlug.setError(null); updatePreview(); });

    const validate = () => {
      let ok = true;
      const title = zh.value.trim();
      fZh.setError(title ? null : `请填写${ctx.langName(ctx.defaultLang)}名称`);
      if (!title) ok = false;
      const s = slugIn.value.trim();
      let e = null;
      if (!s) e = '请填写网址（小写英文字母、数字和 -）';
      else if (!isValidSlug(s)) e = '网址只能用小写英文字母、数字和 -，并以字母或数字开头';
      else if (repo.list(`${COURSES_DIR}/${s}/`).length) e = '已经有一门课用了这个网址';
      else if (langs.includes(s) || s === 'page' || s === 'index') e = '这个网址是网站保留的，换一个吧';
      else if ([null, ...langs].some((l) => repo.has(variantPath(COURSES_DIR, s, l)))) e = '课程资料里已经有一个同名的页面了';
      fSlug.setError(e);
      if (e) ok = false;
      return ok ? {
        title, enTitle: other ? en.value.trim() : '', slug: s, group: canonicalGroup(gi.input.value, existingGroups()),
        description: desc.value.trim(), enDescription: other ? descEn.value.trim() : '',
      } : null;
    };

    const form = h('form', { class: 'stack lists-new-form', novalidate: true },
      fZh.el, fEn && fEn.el, fSlug.el, fGroup.el, fDesc.el, fDescEn && fDescEn.el,
      h('p', { class: 'muted small' }, '创建后会打开这门课：可以批量上传资料（每个文件生成一篇子推文），也可以写课程介绍。'));
    form.addEventListener('submit', (e) => e.preventDefault());
    let m;
    form.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing && e.target instanceof HTMLInputElement) {
        e.preventDefault();
        const btn = m && m.footer.querySelector('[data-testid="new-course-ok"]');
        if (btn && !btn.disabled) btn.click();
      }
    });
    m = modal({
      title: '新建课程',
      testid: 'new-course',
      content: form,
      actions: [
        { text: '取消', kind: 'ghost', testid: 'new-course-cancel' },
        {
          text: '创建并发布', kind: 'primary', testid: 'new-course-ok',
          onClick: async (close) => {
            const v = validate();
            if (!v) { const bad = form.querySelector('[aria-invalid="true"]'); if (bad) bad.focus(); return; }
            const ok = await createCourse(v);
            if (ok) { close(); ctx.navigate('#/courses?course=' + encodeURIComponent(v.slug)); }
          },
        },
      ],
    });
  }

  async function createCourse({ title, enTitle, slug: s, group, description, enDescription }) {
    const dir = `${COURSES_DIR}/${s}`;
    const weight = nextWeights((state.courses || []).map((c) => c.weight), 1)[0];
    const changes = [{
      path: variantPath(dir, '_index', null),
      content: courseIndexDocument({ title, description, group, weight }),
      baseSha: null,
    }];
    const other = langs.find((l) => l !== ctx.defaultLang);
    if (other && enTitle) {
      changes.push({
        path: variantPath(dir, '_index', other),
        content: courseIndexDocument({ title: enTitle, description: enDescription, group, weight }),
        baseSha: null,
      });
    }
    let res;
    try {
      res = await ctx.publish({
        message: `admin: 新建课程《${title}》`,
        changes,
        summary: changes.map((c) => c.path),
        viewUrl: `${ctx.siteUrl.replace(/\/?$/, '/')}courses/${s}/`, viewLabel: '查看课程',
      });
    } catch {
      return false;
    }
    if (!res || res.conflict) {
      toast('这个网址刚刚已经被占用了，请换一个网址', { type: 'warning' });
      return false;
    }
    return true;
  }

  // ---- 详情 ----

  function orderedItems(course) {
    if (!state.itemOrder) return course.items;
    const byKey = new Map(course.items.map((it) => [it.key, it]));
    return state.itemOrder.map((k) => byKey.get(k)).filter(Boolean);
  }

  function itemOrderChanged(course) {
    if (!state.itemOrder) return [];
    const target = reweight(state.itemOrder, new Map(course.items.map((it) => [it.key, it.weight])));
    return course.items.filter((it) => target.get(it.key) !== it.weight).map((it) => ({ item: it, weight: target.get(it.key) }));
  }

  function siteCourseUrl(course, lang = ctx.defaultLang) {
    const prefix = lang === ctx.defaultLang ? '' : `${lang}/`;
    return `${ctx.siteUrl.replace(/\/?$/, '/')}${prefix}courses/${encodeURIComponent(course.slug)}/`;
  }

  function renderDetail() {
    const course = currentCourse();
    if (!course) {
      render(host, h('div', { class: 'card', dataset: { testid: 'course-missing' } },
        errorState('找不到这门课', { detail: `content/courses/${slug}/ 不存在，可能已经被删除或改名。` }),
        h('div', { class: 'row', style: { justifyContent: 'center', paddingBottom: '12px' } },
          h('a', { class: 'btn btn-primary', href: '#/courses' }, svgIcon('back'), '返回课程列表'))));
      return;
    }
    ctx.setTitle(course.title);
    const editIntro = course.mainPath
      ? h('a', { class: 'btn', href: editHash(course.mainPath), dataset: { testid: 'course-edit' } }, svgIcon('edit'), '编辑介绍')
      : h('a', { class: 'btn', href: '#/edit?new=page&dir=' + encodeURIComponent(course.dir), dataset: { testid: 'course-edit' } }, svgIcon('edit'), '创建介绍页');
    const view = h('a', {
      class: 'btn btn-ghost', href: siteCourseUrl(course), target: '_blank', rel: 'noopener noreferrer', dataset: { testid: 'course-view' },
      title: '在网站上打开（刚发布的修改约 1–2 分钟后生效）',
    }, svgIcon('external'), h('span', { class: 'courses-btn-text' }, '查看网站'));
    const groupBtn = h('button', { type: 'button', class: 'btn btn-ghost', dataset: { testid: 'course-group-btn' } }, svgIcon('tag'), h('span', { class: 'courses-btn-text' }, course.group ? `分组：${course.group}` : '分组'));
    groupBtn.addEventListener('click', () => withBusy(groupBtn, () => changeCourseGroup(course)));

    const header = h('div', { class: 'page-header courses-detail-head' },
      h('div', { class: 'courses-detail-title' },
        h('a', { class: 'btn btn-ghost btn-sm courses-back', href: '#/courses', dataset: { testid: 'course-back' } }, svgIcon('back'), '全部课程'),
        h('h1', { dataset: { testid: 'course-heading' } }, course.title),
        course.description ? h('p', { class: 'page-desc' }, course.description) : null,
        h('div', { class: 'row courses-detail-badges' },
          course.group ? badge(course.group, 'green') : null,
          course.draft ? badge('草稿（网站上不显示）', 'gray') : null,
          course.status ? badge(statusText(course.status, ctx), course.status.kind === 'split' ? 'blue' : 'gray') : null,
          h('code', { class: 'muted small' }, `/courses/${course.slug}/`))),
      h('div', { class: 'actions' }, refreshButton(), groupBtn, view, editIntro));

    render(host, header,
      state.pendingBatch ? pendingBatchBanner() : null,
      itemsCard(course),
      materialsCard(course),
      // 删除整门课放在页面最后，不和常用按钮挤在一起
      h('div', { class: 'courses-danger-zone' }, deleteCourseButton(course)));
  }

  // ---- 删除整门课 ----

  function deleteCourseButton(course) {
    const btn = h('button', {
      type: 'button', class: 'btn btn-ghost btn-danger', dataset: { testid: 'course-delete' }, title: '删除这门课（介绍页、全部子推文，可选资料）',
      'aria-label': `删除课程「${course.title}」`,
    }, svgIcon('trash'), '删除课程');
    btn.addEventListener('click', () => withBusy(btn, () => deleteCourse(course)));
    return btn;
  }

  /**
   * 删除整门课：content/courses/<课程>/ 下的全部文件 + 这门课的图片文件夹；资料文件夹可选（默认不删）。
   * 确认框里列出每一类会删除的文件数量，和引用了这门课资料的其他页面。一个提交。
   */
  async function deleteCourse(course) {
    if (!guardOrder()) return;
    const plan = courseDeletionPlan(repo.list(''), course.slug, course.materialsDir);
    if (!plan.content.length) { toast('这门课已经没有文件了', { type: 'info' }); return; }
    const own = course.materialsDir === `${COURSE_MATERIALS_ROOT}/${course.slug}`;
    // 资料被课程以外的页面引用：删资料会让那里的链接失效
    const outside = [];
    if (own && plan.materials.length) {
      const mds = repo.list(PATHS.content + '/').filter((e) => e.path.endsWith('.md') && !e.path.startsWith(plan.dir));
      if (mds.length <= 400) {
        for (const e of mds) {
          let text = '';
          try { text = await repo.readText(e.path); } catch { continue; }
          if (plan.materials.some((m) => referencesSitePath(text, sitePathFor(m.path)))) outside.push(e.path);
        }
      }
      if (state.disposed) return;
    }
    const subPosts = course.items.length;
    const indexFiles = course.indexPaths.filter((p) => repo.has(p));
    const otherContent = plan.content.length - indexFiles.length - course.items.reduce((n, it) => n + it.variantPaths.filter((p) => repo.has(p)).length, 0);
    const matBytes = plan.materials.reduce((n, e) => n + (e.size || 0), 0);
    const cb = h('input', { type: 'checkbox', dataset: { testid: 'course-delete-materials' } });
    const lines = [
      h('li', {}, `介绍页 ${indexFiles.length} 个文件（${indexFiles.map((p) => p.slice(plan.dir.length)).join('、') || '无'}）`),
      h('li', {}, `子推文 ${subPosts} 篇`, subPosts ? `：${course.items.slice(0, 6).map((it) => `《${it.title}》`).join('')}${subPosts > 6 ? ` 等` : ''}` : ''),
      otherContent > 0 ? h('li', {}, `这门课文件夹里的其他文件 ${otherContent} 个（例如子文件夹）`) : null,
      plan.images.length ? h('li', {}, `子推文的图片 ${plan.images.length} 张（${plan.imgDir}）`) : null,
    ];
    const content = h('div', { class: 'stack-sm', dataset: { testid: 'course-delete-dialog' } },
      h('p', { class: 'modal-message' }, `网站上的「${course.title}」课程页和它的全部子推文都会被删除（所有语言版本）。将删除 ${plan.dir} 里的 ${plan.content.length} 个文件：`),
      h('ul', { class: 'lists-file-list', dataset: { testid: 'course-delete-list' } }, lines),
      plan.materials.length && own
        ? h('div', { class: 'stack-sm' },
          h('label', { class: 'checkbox' }, cb, `同时删除资料文件夹 ${plan.materialsDir}（${plan.materials.length} 个文件，${formatBytes(matBytes)}）`),
          h('p', { class: 'muted small' }, '不勾选的话资料文件会留在网站上（知道网址的人仍然能打开），在「资料」页里还能看到；以后新建同一个网址的课程，它们会重新出现在资料列表里。'),
          outside.length ? h('div', { class: 'banner banner-warning', dataset: { testid: 'course-delete-refs' } }, svgIcon('warning'),
            h('div', { class: 'banner-text' },
              h('div', {}, `课程以外有 ${outside.length} 个页面引用了这些资料，删除资料后那里的链接会失效：`),
              h('ul', { class: 'files-name-list' }, outside.slice(0, 8).map((p) => h('li', {}, h('code', {}, p)))))) : null)
        : plan.materials.length
          ? h('p', { class: 'muted small' }, `这门课的资料在自定义的文件夹 ${plan.materialsDir}（materialsDir）里，不会被删除。`)
          : h('p', { class: 'muted small' }, '这门课没有资料文件。'),
      h('p', { class: 'muted small' }, '删除后可以在 GitHub 的提交历史里找回。'));
    let confirmed = false;
    await new Promise((resolve) => {
      modal({
        title: `删除课程「${course.title}」？`,
        content,
        actions: [
          { text: '取消', kind: 'ghost', testid: 'confirm-cancel' },
          { text: '删除课程', kind: 'danger', testid: 'confirm-ok', onClick: (close) => { confirmed = true; close(); } },
        ],
        onClose: resolve,
      });
    });
    if (!confirmed || state.disposed) return;
    const withMaterials = cb.checked && own;
    const del = [...plan.content, ...plan.images, ...(withMaterials ? plan.materials : [])];
    let res;
    try {
      res = await ctx.publish({
        message: `admin: 删除课程《${course.title}》`,
        changes: del.map((e) => ({ path: e.path, delete: true, baseSha: e.sha })),
        summary: [
          `删除 ${plan.dir}（${plan.content.length} 个文件，其中子推文 ${subPosts} 篇）`,
          plan.images.length ? `删除 ${plan.imgDir}（${plan.images.length} 张图片）` : null,
          withMaterials ? `删除 ${plan.materialsDir}（${plan.materials.length} 个资料文件）` : null,
        ].filter(Boolean),
      });
    } catch { return; }
    if (res && res.conflict) return;
    ctx.navigate('#/courses', { replace: true });
  }

  function pendingBatchBanner() {
    const retry = h('button', { type: 'button', class: 'btn btn-sm btn-primary', dataset: { testid: 'course-batch-retry' } }, svgIcon('refresh'), '重新检查并上传');
    retry.addEventListener('click', () => withBusy(retry, async () => {
      const b = state.pendingBatch;
      if (b && b.needsReload) {
        try { await repo.load(); } catch (err) { toast(`读取最新版本失败：${errorMessage(err)}`, { type: 'error' }); return; }
        b.needsReload = false;
      }
      await reviewBatch();
    }));
    const drop = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', dataset: { testid: 'course-batch-discard' } }, '放弃');
    drop.addEventListener('click', () => { state.pendingBatch = null; renderAll(); });
    return h('div', { class: 'banner banner-warning', dataset: { testid: 'course-batch-pending' } },
      svgIcon('warning'),
      h('span', {}, `还有 ${state.pendingBatch.items.length} 个文件没有上传成功（${state.pendingBatch.reason || '网站内容刚刚有变化'}）。`),
      h('div', { class: 'banner-actions' }, drop, retry));
  }

  function itemsCard(course) {
    const items = orderedItems(course);
    const newItem = h('a', {
      class: 'btn btn-sm', href: '#/edit?new=page&dir=' + encodeURIComponent(course.dir), dataset: { testid: 'course-new-item' },
    }, svgIcon('plus'), '新子推文');
    const batchBtn = h('button', { type: 'button', class: 'btn btn-sm btn-primary', dataset: { testid: 'course-batch-upload' } }, svgIcon('upload'), '批量上传');
    batchBtn.addEventListener('click', () => pickFiles('item'));

    const rows = items.map((it, i) => itemRow(course, it, i, items.length));
    const changed = itemOrderChanged(course);
    const saveBtn = h('button', { type: 'button', class: 'btn btn-primary', dataset: { testid: 'items-save-order' }, disabled: state.saving || !changed.length || undefined }, svgIcon('check'), '保存顺序');
    const resetBtn = h('button', { type: 'button', class: 'btn btn-ghost', dataset: { testid: 'items-reset-order' } }, '撤销');
    saveBtn.addEventListener('click', () => withBusy(saveBtn, () => saveItemOrder(course)));
    resetBtn.addEventListener('click', () => { state.itemOrder = null; renderAll(); });
    return h('section', { class: 'card courses-items', dataset: { testid: 'course-items' } },
      h('div', { class: 'card-header' },
        h('div', { class: 'courses-card-title' },
          h('h2', { class: 'card-title' }, '子推文'),
          h('span', { class: 'muted small' }, items.length ? `${items.length} 篇 · 网站上按这个顺序显示` : '')),
        h('div', { class: 'row courses-card-actions' }, newItem, batchBtn)),
      items.length
        ? h('ul', { class: 'list courses-item-list', dataset: { testid: 'item-list' } }, rows)
        : h('div', { dataset: { testid: 'items-empty' } }, emptyState(
          '这门课还没有子推文。不需要的话可以不建：资料会直接列在课程页上。需要每个实验 / 每次作业一篇时，点「批量上传」一次选好几个文件，每个文件生成一篇。',
          null, { icon: 'post' })),
      state.itemOrder ? h('div', { class: ['lists-savebar', changed.length && 'is-dirty'], dataset: { testid: 'items-savebar' } },
        h('span', { class: 'muted small lists-save-hint' }, changed.length ? `调整了 ${changed.length} 篇的顺序，还没有保存` : '顺序没有变化'),
        h('div', { class: 'row' }, resetBtn, saveBtn)) : null);
  }

  function itemRow(course, it, index, count) {
    const up = h('button', {
      type: 'button', class: 'btn btn-ghost btn-sm btn-icon', 'aria-label': `把「${it.title}」往前移`, title: '往前移',
      dataset: { testid: 'item-up' }, disabled: index === 0 || undefined,
    }, svgIcon('up'));
    const down = h('button', {
      type: 'button', class: 'btn btn-ghost btn-sm btn-icon', 'aria-label': `把「${it.title}」往后移`, title: '往后移',
      dataset: { testid: 'item-down' }, disabled: index === count - 1 || undefined,
    }, svgIcon('down'));
    up.addEventListener('click', () => moveItem(course, it.key, -1));
    down.addEventListener('click', () => moveItem(course, it.key, +1));
    const del = h('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-danger', dataset: { testid: 'item-delete' }, 'aria-label': `删除「${it.title}」` },
      svgIcon('trash'), h('span', { class: 'courses-btn-text' }, '删除'));
    del.addEventListener('click', () => withBusy(del, () => deleteItem(course, it)));
    return h('li', { class: 'list-item courses-item-row', dataset: { testid: 'item-row', key: it.key, path: it.path, slug: it.base } },
      h('div', { class: 'list-item-main' },
        h('a', { class: 'list-item-title', href: editHash(it.path), dataset: { testid: 'item-title' } }, it.title),
        it.description ? h('div', { class: 'courses-desc' }, it.description) : null,
        h('div', { class: 'list-item-meta' },
          h('code', { class: 'muted small' }, `${it.base}.md`),
          badge(statusText(it.status, ctx), it.status.kind === 'split' ? 'blue' : 'gray'),
          it.draft ? badge('草稿', 'gray') : null,
          it.weight == null ? badge('没有顺序', 'orange') : null,
          it.error ? (() => { const b = badge('设置区有问题', 'red'); b.title = it.error; return b; })() : null)),
      h('div', { class: 'list-item-actions courses-row-actions' },
        h('div', { class: 'lists-order' }, up, down),
        h('a', { class: 'btn btn-sm', href: editHash(it.path), dataset: { testid: 'item-edit' }, 'aria-label': `编辑「${it.title}」` }, svgIcon('edit'), h('span', { class: 'courses-btn-text' }, '编辑')),
        del));
  }

  function moveItem(course, key, dir) {
    const list = (state.itemOrder || course.items.map((it) => it.key));
    const i = list.indexOf(key);
    const next = moveIn(list, i, dir);
    const base = course.items.map((it) => it.key);
    state.itemOrder = next.join('\n') === base.join('\n') ? null : next;
    renderAll();
    focusAfter(`[data-testid="item-row"][data-key="${CSS.escape(key)}"] [data-testid="${dir < 0 ? 'item-up' : 'item-down'}"]`);
  }

  async function saveItemOrder(course) {
    const changed = itemOrderChanged(course);
    if (!changed.length) return;
    const changes = [];
    const summary = [];
    try {
      for (const { item, weight } of changed) {
        for (const p of item.variantPaths) {
          const entry = repo.entry(p);
          if (!entry) continue;
          const text = await repo.readText(p);
          const out = patchFields(text, { weight }, p);
          if (out !== text) changes.push({ path: p, content: out, baseSha: entry.sha });
        }
        summary.push(`${item.title}：${item.weight ?? '未设置'} → ${weight}`);
      }
    } catch (err) {
      toast(errorMessage(err), { type: 'error', timeout: 9000 });
      return;
    }
    if (!changes.length) { state.itemOrder = null; renderAll(); return; }
    state.saving = true;
    let res;
    try {
      res = await ctx.publish({ message: `admin: 调整课程《${course.title}》的子推文顺序`, changes, summary, viewUrl: siteCourseUrl(course), viewLabel: '查看课程' });
    } catch {
      return;
    } finally {
      state.saving = false;
    }
    if (res && res.conflict) {
      if (res.reloaded) toast('已读取最新内容，你调整的顺序还在，确认后再点一次「保存顺序」', { type: 'info', timeout: 6000 });
      renderAll();
      return;
    }
    state.itemOrder = null;
    renderAll();
  }

  async function deleteItem(course, it) {
    if (!guardOrder()) return;
    const files = it.variantPaths.filter((p) => repo.has(p));
    const ok = await confirmDialog({
      title: `删除子推文「${it.title}」？`,
      message: h('div', { class: 'stack-sm' },
        h('p', {}, '网站上的这篇子推文会被删除（所有语言版本）：'),
        h('ul', { class: 'lists-file-list' }, files.map((p) => h('li', {}, h('code', {}, p)))),
        h('p', { class: 'muted small' }, '它用到的 PDF、图片等资料不会被删除，仍然列在这门课的资料里。GitHub 会保留历史版本，误删了也能找回。')),
      okText: '删除', danger: true,
    });
    if (!ok || state.disposed) return;
    try {
      await ctx.publish({
        message: `admin: 删除子推文《${it.title}》`,
        changes: files.map((p) => ({ path: p, delete: true, baseSha: repo.entry(p).sha })),
        summary: files.map((p) => `删除 ${p}`),
      });
    } catch { /* 外壳已提示 */ }
  }

  // ---- 资料 ----

  function usedLinks(used) {
    if (!used || !used.length) return null;
    return [h('span', { class: 'muted' }, '用在'), ...used.slice(0, 3).map((it) => h('a', { href: editHash(it.path), dataset: { testid: 'material-used' } }, `《${it.title}》`))];
  }

  function materialsCard(course) {
    const total = course.materials.reduce((s, e) => s + (e.size || 0), 0);
    const compressBox = h('input', { type: 'checkbox', checked: state.compress, dataset: { testid: 'course-compress' } });
    compressBox.addEventListener('change', () => { state.compress = compressBox.checked; writePref(COMPRESS_PREF_KEY, state.compress); });
    const uploadBtn = h('button', { type: 'button', class: 'btn btn-sm', dataset: { testid: 'course-upload-materials' } }, svgIcon('upload'), '上传资料');
    uploadBtn.addEventListener('click', () => pickFiles('materials'));
    const rows = course.materials.map((e) => materialRow(course, e));
    return h('section', { class: 'card courses-materials', dataset: { testid: 'course-materials' } },
      h('div', { class: 'card-header' },
        h('div', { class: 'courses-card-title' },
          h('h2', { class: 'card-title' }, '资料'),
          h('span', { class: 'muted small', dataset: { testid: 'materials-count' } }, course.materials.length ? `${course.materials.length} 个文件 · ${formatBytes(total)}` : '')),
        h('div', { class: 'row courses-card-actions' }, uploadBtn)),
      h('div', { class: 'courses-materials-info muted small' },
        svgIcon('info', { size: 14 }),
        h('span', {},
          course.showMaterials
            ? '这个文件夹里的文件会自动列在网站的课程页上（按文件名排序，PDF 和图片点开就能在线看）。'
            : '这门课设置了 showMaterials: false：网站的课程页上不显示资料列表。',
          ' 保存在 ', h('code', { class: 'files-code' }, course.materialsDir + '/'), ' · ',
          h('a', { href: '#/files?dir=' + encodeURIComponent(course.materialsDir), dataset: { testid: 'course-files-link' } }, '在「资料」页里打开'))),
      h('div', { class: 'files-options courses-options' },
        h('label', { class: 'checkbox' }, compressBox, '压缩图片'),
        h('span', { class: 'muted small' }, `JPG / PNG 会缩小到最宽 ${LIMITS.imageMaxWidth} 像素；PDF 原样上传。不能上传网页、脚本和 SVG 文件。`)),
      rows.length
        ? h('ul', { class: 'list files-list courses-material-list', dataset: { testid: 'material-list' } }, rows)
        : h('div', { dataset: { testid: 'materials-empty' } }, emptyState('还没有资料。点「上传资料」或「批量上传」，或者直接把文件拖到这个页面上。', null, { icon: 'files' })));
  }

  function materialRow(course, e) {
    const name = baseNameOf(e.path);
    const sp = sitePathFor(e.path);
    const viewer = usesViewer(e.path);
    const fileUrl = staticFileUrl(ctx.siteUrl, e.path);
    const openUrl = viewer ? staticPreviewUrl(ctx.siteUrl, e.path) : fileUrl;
    const copy = h('button', {
      type: 'button', class: ['btn btn-ghost btn-sm', viewer && 'btn-primary'], dataset: { testid: viewer ? 'material-copy-preview' : 'material-copy' },
      'aria-label': viewer ? `复制「${name}」的预览链接` : `复制「${name}」的链接`,
      title: viewer ? '复制在线预览的网址（安卓手机和微信里也能看）' : '复制完整网址',
    }, svgIcon(viewer ? 'eye' : 'link'), h('span', { class: 'courses-btn-text' }, viewer ? '复制预览链接' : '复制链接'));
    copy.addEventListener('click', async () => {
      try { await copyText(openUrl); toast(viewer ? `已复制预览链接：${openUrl}` : `已复制链接：${openUrl}`, { type: 'success' }); } catch (err) { toast(`${errorMessage(err)}：${openUrl}`, { type: 'error', timeout: 9000 }); }
    });
    const open = h('a', {
      class: 'btn btn-ghost btn-sm btn-icon', href: openUrl, target: '_blank', rel: 'noopener noreferrer', dataset: { testid: 'material-open' },
      'aria-label': viewer ? `在线预览「${name}」` : `在网站上打开「${name}」`, title: viewer ? '在线预览' : '在网站上打开',
    }, svgIcon('external'));
    const del = h('button', { type: 'button', class: 'btn btn-ghost btn-sm btn-icon btn-danger', dataset: { testid: 'material-delete' }, 'aria-label': `删除「${name}」`, title: '删除' }, svgIcon('trash'));
    del.addEventListener('click', () => withBusy(del, () => deleteStaticFile(ctx, e, { isDisposed: () => state.disposed })));
    const ext = extOf(name);
    return h('li', { class: 'list-item files-row courses-material-row', dataset: { testid: 'material-row', path: e.path, site: sp } },
      h('div', { class: ['files-thumb', `files-type-${kindOf(name) === 'image' ? 'image' : ext === 'pdf' ? 'pdf' : 'other'}`], 'aria-hidden': 'true' },
        kindOf(name) === 'image' ? svgIcon('image') : h('span', { class: 'files-ext' }, (ext || '文件').slice(0, 4).toUpperCase())),
      h('div', { class: 'list-item-main' },
        h('div', { class: 'list-item-title files-name', title: name, dataset: { testid: 'material-name' } }, name),
        h('div', { class: 'list-item-meta' },
          h('span', { class: 'files-size' }, formatBytes(e.size)),
          h('span', { class: 'courses-material-used' }, usedLinks(state.uses.get(sp))))),
      h('div', { class: 'list-item-actions courses-material-actions' }, copy, open, del));
  }

  // =========================================================================
  // 批量上传

  const fileInput = h('input', { type: 'file', multiple: true, class: 'files-input', tabindex: '-1', 'aria-hidden': 'true', dataset: { testid: 'course-files-input' } });
  let pickMode = 'item';
  fileInput.addEventListener('change', () => {
    const list = [...(fileInput.files || [])];
    fileInput.value = '';
    if (list.length) startBatch(list, pickMode);
  });
  container.appendChild(fileInput);

  function pickFiles(mode) {
    if (!guardOrder()) return;
    if (state.pendingBatch) { toast('还有一批文件没有上传成功：请先「重新检查并上传」或「放弃」', { type: 'warning' }); return; }
    pickMode = mode;
    fileInput.click();
  }

  /**
   * @param {File[]} rawFiles
   * @param {'item'|'materials'} defaultMode 每个文件默认「生成子推文」还是「只放进资料列表」
   */
  async function startBatch(rawFiles, defaultMode) {
    const course = currentCourse();
    if (!course || state.disposed) return;
    if (!guardOrder()) return;
    if (state.pendingBatch) { toast('还有一批文件没有上传成功：请先「重新检查并上传」或「放弃」', { type: 'warning' }); return; }
    const files = rawFiles.filter((f) => !isJunkFile(f.name));
    if (!files.length) return;
    const items = files.map((file) => ({
      file, origName: file.name, name: safeFileName(file.name), blob: file, size: file.size, origSize: file.size,
      compressed: false, note: '', title: titleFromFileName(file.name), mode: defaultMode,
    }));
    const busy = items.some((it) => state.compress && COMPRESSIBLE.has(extOf(it.name))) ? toast('正在压缩图片…', { type: 'info', timeout: 0 }) : null;
    try {
      for (const it of items) {
        if (state.disposed) return;
        if (state.compress && !uploadBlockReason(it.origName, it.name) && COMPRESSIBLE.has(extOf(it.name)) && it.file.size < MAX_BYTES) {
          const r = await prepareUpload(it.file, it.name, { compress: true });
          Object.assign(it, { blob: r.blob, name: r.name, size: r.size, compressed: r.compressed, note: r.note });
        }
      }
    } finally {
      if (busy) busy.close();
    }
    state.pendingBatch = { slug: course.slug, items, reason: '' };
    await reviewBatch();
  }

  /** 检查（文件名、大小、.gitignore、替换）→ 确认对话框 → 一次提交。冲突 / 失败后「重试」也从这里开始。 */
  async function reviewBatch() {
    const b = state.pendingBatch;
    const course = currentCourse();
    if (!b || !course || state.disposed) return;
    const items = b.items;
    // 每次都从压缩后的名字和说明重新开始（重试时文件夹里的文件可能变了）
    for (const it of items) {
      if (it.baseName === undefined) { it.baseName = it.name; it.baseNote = it.note || ''; }
      it.name = it.baseName;
      it.note = it.baseNote;
      it.blocked = false;
    }
    const renamed = assignUniqueNames(items);
    for (const it of renamed) it.note = [it.note, '和同一批里的文件重名，已自动改名'].filter(Boolean).join('；');
    for (const it of items) it.path = `${course.materialsDir}/${it.name}`;
    const ignore = await gitignoreMatcher(repo);
    if (state.disposed) return;
    const review = checkUploads(repo, items, ignore);
    if (!review.ready.length) {
      state.pendingBatch = null;
      renderAll();
      await alertDialog('无法上传', refusedContent(review.refused));
      return;
    }
    const submitted = await batchDialog(course, review);
    if (!submitted) {
      if (state.pendingBatch === b && !b.failedOnce) state.pendingBatch = null;
      renderAll();
    }
  }

  function alertDialog(title, content) {
    return new Promise((resolve) => {
      modal({ title, content, actions: [{ text: '知道了', kind: 'primary', testid: 'confirm-ok', autofocus: true }], onClose: resolve });
    });
  }

  /** 对话框：每个文件一行（标题、生成子推文 / 只放进资料），提醒，确认。返回是否提交了（成功或冲突）。 */
  function batchDialog(course, review) {
    const ready = review.ready;
    return new Promise((resolve) => {
      let done = false;
      const summaryEl = h('p', { class: 'muted small courses-batch-summary', dataset: { testid: 'batch-summary' } });
      const updateSummary = () => {
        const n = ready.filter((it) => it.mode === 'item').length;
        summaryEl.textContent = `将上传 ${ready.length} 个文件到 ${course.materialsDir}/` + (n ? `，并生成 ${n} 篇子推文（排在现有子推文后面）。` : '，不生成子推文。') + ' 一次发布。';
      };
      const rows = ready.map((it) => {
        const title = h('input', {
          class: 'input courses-batch-title', type: 'text', value: it.title, maxlength: 120, 'aria-label': `「${it.name}」的子推文标题`,
          dataset: { testid: 'batch-title' },
        });
        const err = h('div', { class: 'error', role: 'alert' });
        err.hidden = true;
        title.addEventListener('input', () => { it.title = title.value; err.hidden = true; title.removeAttribute('aria-invalid'); });
        const radioName = 'bm-' + Math.random().toString(36).slice(2);
        const rItem = h('input', { type: 'radio', name: radioName, value: 'item', checked: it.mode === 'item', dataset: { testid: 'batch-mode-item' } });
        const rMat = h('input', { type: 'radio', name: radioName, value: 'materials', checked: it.mode === 'materials', dataset: { testid: 'batch-mode-materials' } });
        const titleField = h('div', { class: 'courses-batch-title-wrap' }, title, err);
        const sync = () => { titleField.hidden = it.mode !== 'item'; row.dataset.mode = it.mode; updateSummary(); };
        rItem.addEventListener('change', () => { if (rItem.checked) { it.mode = 'item'; sync(); } });
        rMat.addEventListener('change', () => { if (rMat.checked) { it.mode = 'materials'; sync(); } });
        const k = kindOf(it.name);
        const row = h('li', { class: 'courses-batch-row', dataset: { testid: 'batch-row', name: it.name, mode: it.mode } },
          h('div', { class: 'courses-batch-file' },
            h('div', { class: ['files-thumb', 'files-thumb-sm', `files-type-${k === 'image' ? 'image' : k === 'pdf' ? 'pdf' : 'other'}`], 'aria-hidden': 'true' },
              k === 'image' ? svgIcon('image') : h('span', { class: 'files-ext' }, (extOf(it.name) || '文件').slice(0, 4).toUpperCase())),
            h('div', { class: 'courses-batch-name' },
              h('div', { class: 'truncate', title: it.name, dataset: { testid: 'batch-file-name' } }, it.name),
              h('div', { class: 'muted small' },
                it.compressed ? `${formatBytes(it.origSize)} → ${formatBytes(it.size)}` : formatBytes(it.size),
                it.note && !(it.compressed && /^已压缩/.test(it.note)) ? ` · ${it.note}` : '',
                it.name !== safeFileName(it.origName) && !it.compressed ? ` · 原名 ${it.origName}` : ''))),
          h('div', { class: 'courses-batch-choice', role: 'radiogroup', 'aria-label': `「${it.name}」怎么放` },
            h('label', { class: 'checkbox' }, rItem, '生成子推文'),
            h('label', { class: 'checkbox' }, rMat, '只放进资料列表')),
          titleField);
        it.titleInput = title;
        it.titleError = err;
        it.row = row;
        queueMicrotask(sync);
        return row;
      });
      updateSummary();
      const sections = uploadReviewSections(review);
      const content = h('div', { class: 'stack courses-batch', dataset: { testid: 'batch-review' } },
        h('p', { class: 'muted small' }, '每个文件默认生成一篇子推文（标题可以改，PDF 会直接嵌在子推文里，图片显示在子推文里）；选「只放进资料列表」的只出现在课程页的资料列表里。'),
        sections.some(Boolean) ? h('div', { class: 'stack-sm files-confirm', dataset: { testid: 'files-review' } }, sections) : null,
        h('ul', { class: 'courses-batch-list' }, rows),
        summaryEl);
      modal({
        title: `批量上传到「${course.title}」`,
        wide: true,
        testid: 'course-batch',
        className: 'courses-batch-modal',
        content,
        actions: [
          { text: '取消', kind: 'ghost', testid: 'batch-cancel' },
          {
            text: review.ignored.length ? '仍然上传并发布' : '上传并发布', kind: review.ignored.length ? 'danger' : 'primary', testid: 'batch-submit',
            onClick: async (close) => {
              // 标题必填（生成子推文的）
              const bad = ready.filter((it) => it.mode === 'item' && !String(it.title || '').trim());
              for (const it of bad) { it.titleError.textContent = '请填写标题'; it.titleError.hidden = false; it.titleInput.setAttribute('aria-invalid', 'true'); }
              if (bad.length) { bad[0].titleInput.focus(); return; }
              done = true;
              close();
              // 成功或冲突 / 失败（保留这一批，可以重试）都算提交过
              try { await publishBatch(course, ready); } finally { resolve(true); }
            },
          },
        ],
        onClose: () => { if (!done) resolve(false); },
      });
    });
  }

  async function publishBatch(course, ready) {
    const b = state.pendingBatch;
    {
      if (ctx.isPublishing && ctx.isPublishing()) {
        for (let i = 0; i < 600 && ctx.isPublishing(); i++) await new Promise((r) => setTimeout(r, 100));
      }
      const asItems = ready.filter((it) => it.mode === 'item');
      const weights = nextWeights(course.items.map((it) => it.weight), asItems.length);
      const taken = new Set(repo.list(course.dir + '/').map((e) => {
        const rest = e.path.slice(course.dir.length + 1);
        const first = rest.split('/')[0];
        return first.replace(/(\.[a-z]{2,3})?\.md$/i, '').toLowerCase();
      }));
      taken.add('_index');
      const changes = ready.map((it) => ({ path: it.path, content: it.blob, baseSha: it.existing ? it.existing.sha : null }));
      const created = [];
      asItems.forEach((it, i) => {
        const s = itemSlugFor(it.title, it.origName, taken);
        taken.add(s);
        const path = variantPath(course.dir, s, null);
        const title = String(it.title).trim();
        changes.push({ path, content: itemDocument({ title, weight: weights[i] }, itemBodyFor(it.path, title)), baseSha: null });
        created.push({ path, title });
      });
      const first = ready[0].name;
      const message = created.length
        ? `admin: 课程《${course.title}》上传 ${ready.length} 个文件，新增 ${created.length} 篇子推文`
        : (ready.length === 1 ? `admin: 课程《${course.title}》上传资料 ${first}` : `admin: 课程《${course.title}》上传资料 ${first} 等 ${ready.length} 个文件`);
      const summary = [
        ...ready.map((it) => `${it.existing ? '替换' : '上传'} ${it.path}（${formatBytes(it.size)}）`),
        ...created.map((c) => `新增子推文 ${c.path}《${c.title}》`),
      ];
      let res;
      try {
        res = await ctx.publish({ message, changes, summary, viewUrl: siteCourseUrl(course), viewLabel: '查看课程' });
      } catch (err) {
        if (b) { b.failedOnce = true; b.reason = `上传失败：${errorMessage(err)}`; }
        renderAll();
        return;
      }
      if (res && res.conflict) {
        if (b) { b.failedOnce = true; b.needsReload = !res.reloaded; b.reason = '网站上的内容刚刚有变化，这次没有上传'; }
        renderAll();
        return;
      }
      state.pendingBatch = null;
      renderAll();
    }
  }

  // =========================================================================

  await load();

  return {
    isDirty: () => !!(state.courseOrder || state.itemOrder || state.pendingBatch),
    async canLeave() {
      if (!(state.courseOrder || state.itemOrder || state.pendingBatch) || state.saving) return true;
      return confirmDialog({
        title: state.pendingBatch ? '还有文件没有上传' : '顺序还没有保存',
        message: state.pendingBatch ? '有一批文件还没有上传成功，离开后需要重新选择这些文件。确定离开吗？' : '你调整的顺序还没有发布，离开后这些修改会丢失。确定离开吗？',
        okText: '离开', cancelText: '留下', danger: true,
      });
    },
    unmount() {
      state.disposed = true;
      clearTimeout(changeTimer);
      unsubscribe();
      window.removeEventListener('dragover', blockWindowDrop);
      window.removeEventListener('drop', blockWindowDrop);
      delete document.body.dataset.coursesReady;
    },
  };
}

function frontMatter(text) {
  return frontMatterOf(text).fm;
}
