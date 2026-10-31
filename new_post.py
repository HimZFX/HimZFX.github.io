#!/usr/bin/env python3
"""
新建文章 / 补充翻译 / 查看双语状态

双语规则（详见 SITE_GUIDE.md「双语机制」）:
    xxx.md      共用版本：中英文站都显示
    xxx.en.md   英文专属：存在时，英文站改用它
    xxx.zh.md   中文专属：存在时，中文站改用它

用法:
    python new_post.py dark-galaxy "暗星系中的中性氢"
        新建一份共用文章，中英文站都会显示（最省事）

    python new_post.py dark-galaxy "暗星系中的中性氢" "Neutral Hydrogen in Dark Galaxies"
        同时新建中文版（dark-galaxy.md）和英文版（dark-galaxy.en.md）

    python new_post.py dark-galaxy --translate en "Neutral Hydrogen in Dark Galaxies"
        给已有文章补一份英文版：复制原文作为翻译底稿，只改标题

    python new_post.py --status
        列出每个页面在各语言站点上实际显示的是哪个文件

    以上命令都可以加 --section <栏目>，在 posts 以外的目录操作，例如 --section research
"""

import argparse
import json
import os
import re
import sys
import unicodedata
from datetime import datetime

ROOT = os.path.dirname(os.path.abspath(__file__))
CONTENT_DIR = os.path.join(ROOT, "content")
CONFIG_DIR = os.path.join(ROOT, "config", "_default")
SITE_NAMES = {"zh": "中文站", "en": "英文站"}

# 与 archetypes/default.md 保持一致
TEMPLATE = """---
title: {title}
date: {date}
draft: true
categories: []
tags: []
# math: false     # 本页没有公式时可关闭 KaTeX（全站默认开启）
# comments: true  # 开启评论区（全站默认关闭）
---

"""


# ---------- 读取站点语言配置 ----------

def read_languages():
    """返回 (默认语言, [所有语言])，从 config/_default/ 中读取，读不到时用 zh/en。"""
    default, langs = "zh", []
    try:
        with open(os.path.join(CONFIG_DIR, "hugo.toml"), encoding="utf-8") as f:
            m = re.search(r'^\s*defaultContentLanguage\s*=\s*"([\w-]+)"', f.read(), re.M)
            if m:
                default = m.group(1)
        with open(os.path.join(CONFIG_DIR, "languages.toml"), encoding="utf-8") as f:
            langs = re.findall(r"^\s*\[([A-Za-z][\w-]*)\]\s*$", f.read(), re.M)
    except OSError:
        pass
    langs = langs or ["zh", "en"]
    if default not in langs:
        langs.insert(0, default)
    return default, langs


DEFAULT_LANG, LANGS = read_languages()


def site_name(lang):
    return SITE_NAMES.get(lang, f"{lang} 站")


def split_name(filename):
    """'post.en.md' -> ('post', 'en')；'post.md' -> ('post', None)。"""
    stem = filename[:-3]
    base, dot, suffix = stem.rpartition(".")
    if dot and suffix in LANGS:
        return base, suffix
    return stem, None


def file_for(directory, slug, lang=None):
    return os.path.join(directory, f"{slug}.{lang}.md" if lang else f"{slug}.md")


def is_draft(path):
    with open(path, encoding="utf-8") as f:
        text = f.read()
    m = re.match(r"---\s*\n(.*?)\n---", text, re.S)
    return bool(m and re.search(r"^draft\s*:\s*true\b", m.group(1), re.M | re.I))


def rel(path):
    return os.path.relpath(path, ROOT)


def fail(msg):
    print(f"错误：{msg}")
    sys.exit(1)


# ---------- 新建 ----------

def create(section_dir, slug, titles):
    targets = [(file_for(section_dir, slug), titles[0])]
    if len(titles) > 1:
        others = [l for l in LANGS if l != DEFAULT_LANG]
        if not others:
            fail("站点只有一种语言，无法创建第二个语言版本")
        targets.append((file_for(section_dir, slug, others[0]), titles[1]))

    for path, _ in targets:
        if os.path.exists(path):
            fail(f"{rel(path)} 已存在")

    os.makedirs(section_dir, exist_ok=True)
    now = datetime.now().astimezone().replace(microsecond=0).isoformat()
    for path, title in targets:
        with open(path, "w", encoding="utf-8") as f:
            f.write(TEMPLATE.format(title=json.dumps(title, ensure_ascii=False), date=now))
        print(f"已创建：{rel(path)}")

    if len(targets) == 1:
        print("\n这是共用版本，中英文站都会显示它。以后想补翻译：")
        print(f'  python new_post.py {slug} --translate en "English Title"')
    print("\n写完后把 draft: true 改成 draft: false 即可发布。")


# ---------- 补翻译 ----------

def translate(section_dir, slug, lang, title):
    if lang not in LANGS:
        fail(f"未知语言 {lang!r}，可选：{', '.join(LANGS)}")
    target = file_for(section_dir, slug, lang)
    if os.path.exists(target):
        fail(f"{rel(target)} 已存在")

    # 优先以共用版本为底稿，其次是任一语言的专属版本
    sources = [file_for(section_dir, slug)] + [file_for(section_dir, slug, l) for l in LANGS if l != lang]
    source = next((p for p in sources if os.path.exists(p)), None)
    if not source:
        fail(f"找不到 {rel(file_for(section_dir, slug))}，请先创建原文")

    with open(source, encoding="utf-8") as f:
        text = f.read()
    if title:
        m = re.match(r"(---\s*\n)(.*?)(\n---)", text, re.S)
        if not m:
            fail(f"{rel(source)} 没有 front matter")
        new_title = "title: " + json.dumps(title, ensure_ascii=False)
        fm = re.sub(r"^title\s*:.*$", lambda _: new_title, m.group(2), count=1, flags=re.M)
        text = m.group(1) + fm + m.group(3) + text[m.end():]

    with open(target, "w", encoding="utf-8") as f:
        f.write(text)
    print(f"已创建：{rel(target)}（以 {rel(source)} 为底稿）")
    print(f"\n从现在起{site_name(lang)}显示这个文件，其他语言不受影响。")
    print("注意：不要把它单独改成 draft: true —— 专属版本是草稿时，")
    print(f"{site_name(lang)}上这篇会暂时消失，而不是退回显示共用版本。")


# ---------- 状态 ----------

def display_width(s):
    return sum(2 if unicodedata.east_asian_width(c) in "WF" else 1 for c in s)


def pad(s, width):
    return s + " " * max(0, width - display_width(s))


def status(root_dir):
    groups = {}
    for dirpath, _, files in os.walk(root_dir):
        for name in sorted(files):
            if name.endswith(".md"):
                base, lang = split_name(name)
                groups.setdefault((dirpath, base), {})[lang] = os.path.join(dirpath, name)

    rows, notes = [], []
    for (dirpath, base), variants in sorted(groups.items()):
        page = os.path.relpath(os.path.join(dirpath, base), CONTENT_DIR).replace(os.sep, "/")
        cells = []
        for lang in LANGS:
            path = variants.get(lang) or variants.get(None)
            if not path:
                cells.append("—")
                continue
            cell = os.path.basename(path)
            if is_draft(path):
                cell += " (草稿)"
                shared = variants.get(None)
                if lang in variants and shared and not is_draft(shared):
                    notes.append(f"⚠ {page}：{site_name(lang)}专属版本是草稿，发布后{site_name(lang)}上这篇会消失")
            cells.append(cell)

        specific = [l for l in LANGS if l in variants]
        if None in variants and len(specific) == len(LANGS):
            notes.append(f"提示：{page}：每种语言都有专属版本，{base}.md 不会被任何站点使用")
        rows.append([page] + cells)

    header = ["页面"] + [site_name(l) for l in LANGS]
    widths = [max(display_width(r[i]) for r in rows + [header]) + 2 for i in range(len(header))]
    print("".join(pad(h, w) for h, w in zip(header, widths)))
    for r in rows:
        print("".join(pad(c, w) for c, w in zip(r, widths)))
    print("\n说明：两列文件名相同 = 中英共用；不同 = 中英分开；— = 该站点没有这一页。")
    for n in notes:
        print(n)


# ---------- 入口 ----------

def main():
    parser = argparse.ArgumentParser(
        description="新建文章 / 补充翻译 / 查看双语状态",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__.split("用法:")[1])
    parser.add_argument("slug", nargs="?", help="文件名（英文小写 + 连字符），如 dark-galaxy")
    parser.add_argument("titles", nargs="*", help="标题；给两个则同时创建两个语言版本")
    parser.add_argument("--section", default="posts", help="栏目目录，默认 posts")
    parser.add_argument("--translate", metavar="LANG", help="为已有文章补充该语言的专属版本")
    parser.add_argument("--status", action="store_true", help="查看所有页面的双语状态")
    args = parser.parse_args()

    if args.status:
        status(CONTENT_DIR)
        return
    if not args.slug:
        parser.print_help()
        sys.exit(1)

    section_dir = os.path.join(CONTENT_DIR, args.section)
    if args.translate:
        if len(args.titles) > 1:
            fail("--translate 只接受一个标题")
        translate(section_dir, args.slug, args.translate, args.titles[0] if args.titles else None)
    else:
        if not args.titles:
            fail("请提供标题，例如：python new_post.py dark-galaxy \"暗星系中的中性氢\"")
        if len(args.titles) > 2:
            fail("最多提供两个标题（中文、英文）")
        create(section_dir, args.slug, args.titles)


if __name__ == "__main__":
    main()
