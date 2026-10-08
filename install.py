#!/usr/bin/env python3
"""安装 / 卸载 session-relay 插件（DSH profile 本地插件）。

做两件事，都只改一个文件：
  1. 把 `session-relay` 这一行插进 `<profile>/cordis.patch.yml` 的顶层 patch 列表中。
  2. 需要时（`--uninstall`）再把它删掉。

为什么用"绝对路径引用"而不是把 .mjs 复制进 profile 目录：
  - patch 行里相对 `name`（如 `./foo.mjs`）锚定的是**该 patch 文件所在目录**，绝对路径
    则不受位置影响；用绝对路径引用工作区里的插件文件，就不会产生"profile 里那份副本
    与源码不同步"的隐患。
  - profile 目录常被 DSH 沙箱设为只读，少写一个文件就少一处会失败的地方。

幂等：重复运行不会重复插入；`--uninstall` 之后可再次 `--install`。

用法：
    python3 install.py                       # 安装到 web profile（默认）
    python3 install.py --profile headless    # 其它 profile
    python3 install.py --dry-run             # 只打印将要做的改动
    python3 install.py --uninstall           # 卸载
"""

from __future__ import annotations

import argparse
import datetime as dt
import os
import re
import shutil
import sys
from pathlib import Path

# 插件在 patch 文件里的稳定 id（同一 profile 里不重复）。
PLUGIN_ID = "session-relay"
# 本脚本所在目录，即插件源码所在目录。
HERE = Path(__file__).resolve().parent
# 要引用的插件入口文件。
PLUGIN_ENTRY = HERE / "session-relay.mjs"
# DSH 主页；可用 DSH_HOME 覆盖（与 DSH 自身的解析规则一致）。
DSH_HOME = Path(os.environ.get("DSH_HOME", Path.home() / ".dsh")).expanduser()

# 段落标记，卸载时靠它精确删除自己插入的那一段。
BEGIN_MARK = f"# --- {PLUGIN_ID} (managed by dsh-session-relay/install.py) ---"
END_MARK = f"# --- end {PLUGIN_ID} ---"


def patch_path(profile: str) -> Path:
    """返回某个 profile 的 cordis.patch.yml 路径。"""
    return DSH_HOME / "profiles" / profile / "cordis.patch.yml"


def build_block() -> str:
    """生成要追加的 patch 片段（一段完整的顶层列表项）。"""
    entry = PLUGIN_ENTRY.as_posix()
    return (
        f"\n{BEGIN_MARK}\n"
        f"# 让同一工作区内的会话互相发送消息。\n"
        f"# 绝对路径引用工作区里的源码，避免 profile 目录出现不同步的副本。\n"
        f"- insert:\n"
        f"    - id: {PLUGIN_ID}\n"
        f"      name: '{entry}'\n"
        f"{END_MARK}\n"
    )


def strip_block(text: str) -> tuple[str, bool]:
    """删除此前插入的托管段落；返回（新文本, 是否删除过）。"""
    pattern = re.compile(
        r"\n?" + re.escape(BEGIN_MARK) + r".*?" + re.escape(END_MARK) + r"\n?",
        re.DOTALL,
    )
    new_text, count = pattern.subn("\n", text)
    return new_text, count > 0


def verify_yaml_looks_like_sequence(text: str) -> bool:
    """粗校验：未被引号包住的第一行非注释内容必须是列表项或空。"""
    for raw in text.splitlines():
        line = raw.strip()
        if line == "" or line.startswith("#"):
            continue
        return line.startswith("-") or line == "[]"
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="安装/卸载 session-relay 插件")
    parser.add_argument("--profile", default="web", help="目标 DSH profile 名（默认 web）")
    parser.add_argument("--uninstall", action="store_true", help="移除插件行")
    parser.add_argument("--dry-run", action="store_true", help="只打印将要做的改动")
    parser.add_argument("--no-backup", action="store_true", help="不写 .bak 备份")
    args = parser.parse_args()

    if not PLUGIN_ENTRY.is_file():
        print(f"错误：找不到插件入口 {PLUGIN_ENTRY}", file=sys.stderr)
        print("请把 install.py 与 session-relay.mjs 放在同一目录。", file=sys.stderr)
        return 2

    target = patch_path(args.profile)
    if not target.is_file():
        print(f"错误：找不到 profile 的 patch 文件 {target}", file=sys.stderr)
        print("请确认 profile 名，或先让 DSH 启动过一次以生成默认结构。", file=sys.stderr)
        return 2

    original = target.read_text(encoding="utf-8")
    if not verify_yaml_looks_like_sequence(original):
        print(f"错误：{target} 的顶层看起来不是 YAML 列表，拒绝自动改写。", file=sys.stderr)
        print("请手工把 patch 行加进去（见 README.md 的'手工安装'一节）。", file=sys.stderr)
        return 2

    stripped, removed = strip_block(original)

    if args.uninstall:
        if not removed:
            print(f"未发现 {PLUGIN_ID} 的托管段落，无需卸载。")
            return 0
        # 归一化行尾，保证"卸载后"与"从未安装"逐字节一致。
        updated = stripped.rstrip("\n") + "\n"
        action = "卸载"
    else:
        if removed:
            print(f"检测到已存在的 {PLUGIN_ID} 段落，将先移除再以当前路径重写。")
        updated = stripped.rstrip("\n") + "\n" + build_block()
        action = "安装"

    if updated == original:
        print(f"已是目标状态，无需改动：{target}")
        return 0

    print(f"将{action} {PLUGIN_ID} 到：{target}")
    print(f"  插件入口：{PLUGIN_ENTRY}")

    if args.dry_run:
        print("\n--- dry-run：以下内容将被写入 ---")
        print(build_block() if not args.uninstall else f"(删除 {BEGIN_MARK} … {END_MARK})")
        return 0

    try:
        if not args.no_backup:
            stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
            backup = target.with_name(f"{target.name}.bak-{PLUGIN_ID}-{stamp}")
            shutil.copy2(target, backup)
            # 原文件可能是 0600；复制后保持一致。
            print(f"  备份：{backup}")
        target.write_text(updated, encoding="utf-8")
    except PermissionError as error:
        print(f"\n错误：写入被拒绝（{error}）。", file=sys.stderr)
        print("profile 目录可能受沙箱保护。请在沙箱外、或授予写权限后重跑本脚本；", file=sys.stderr)
        print("也可以按 README.md 的'手工安装'一节自行编辑该 YAML。", file=sys.stderr)
        return 3
    except OSError as error:
        print(f"\n错误：写入失败（{error}）。", file=sys.stderr)
        print("profile 目录可能受沙箱保护；见 README.md 的'手工安装'一节。", file=sys.stderr)
        return 3

    print(f"\n完成（{action}）。")
    if not args.uninstall:
        print("\n下一步：")
        print("  1. profile 的 dsh.profile.patchReload 为 'live' 时，保存 YAML 即会热重载；")
        print("     否则重启 DSH。")
        print("  2. 在同一工作区里再开一个会话，然后让某个会话调用")
        print("     list_workspace_sessions，应能看到对方；再用 send_session_message 发消息。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
