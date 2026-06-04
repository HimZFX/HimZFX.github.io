#!/usr/bin/env python3
"""
bilingual post creator

usage:
    python new_post.py my-post-slug "Chinese Title" "English Title"
    python new_post.py my-post-slug "Chinese Title"  # English title optional

generates:
    content/posts/my-post-slug.md      (Chinese)
    content/posts/my-post-slug.en.md   (English)
"""

import sys
import os
from datetime import datetime

def main():
    if len(sys.argv) < 3:
        print("Usage: python new_post.py <slug> <Chinese title> [English title]")
        print('Example: python new_post.py dark-galaxy "暗星系研究" "Dark Galaxy Research"')
        sys.exit(1)

    slug = sys.argv[1]
    title_zh = sys.argv[2]
    title_en = sys.argv[3] if len(sys.argv) > 3 else f"[English] {title_zh}"

    now = datetime.now().strftime("%Y-%m-%dT%H:%M:%S+08:00")
    base_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "content", "posts")

    zh_path = os.path.join(base_dir, f"{slug}.md")
    en_path = os.path.join(base_dir, f"{slug}.en.md")

    for path in [zh_path, en_path]:
        if os.path.exists(path):
            print(f"Error: {path} already exists!")
            sys.exit(1)

    template = """---
title: "{title}"
date: {date}
draft: true
categories: []
tags: []
math: false
---

"""

    with open(zh_path, "w", encoding="utf-8") as f:
        f.write(template.format(title=title_zh, date=now))
    print(f"Created: {zh_path}")

    with open(en_path, "w", encoding="utf-8") as f:
        f.write(template.format(title=title_en, date=now))
    print(f"Created: {en_path}")

    print(f"\nDone! Edit both files, then set draft: false when ready to publish.")

if __name__ == "__main__":
    main()
