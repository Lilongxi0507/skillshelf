#!/usr/bin/env python3
"""Real Clack PTY smoke tests, using only the Python standard library.

Run after building the CLI, using a private temporary fixture directory:
  python3 tests/terminal-smoke.py --cli packages/cli/dist/index.js \
      --catalog catalog/bootstrap.json --tmp "$SKILLSHELF_TEST_TMP"

No installation is confirmed. The supplied catalog is only read; OS/Agent homes,
working directory and all temporary files belong to one exact mkdtemp fixture.
This is POSIX PTY coverage, not a claim of Windows or macOS real-device testing.
"""

from __future__ import annotations

import argparse
import codecs
import errno
import json
import os
from pathlib import Path
import re
import select
import shutil
import signal
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import time

if os.name == "posix":
    import fcntl
    import pty
    import termios

CSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
OSC = re.compile(r"\x1b\][^\x07]*(?:\x07|\x1b\\)")
SGR = re.compile(rb"\x1b\[[0-?]*[ -/]*m")
CAPTURE_LIMIT = 4 * 1024 * 1024
UP, DOWN, ENTER, ESCAPE, CTRL_C = b"\x1b[A", b"\x1b[B", b"\r", b"\x1b", b"\x03"


def plain(value: str) -> str:
    """Keep text for assertions; cursor controls may legitimately be present."""
    return CSI.sub("", OSC.sub("", value)).replace("\r", "")


def compact(value: str) -> str:
    # Clack wraps Chinese labels and repeats guide borders on narrow terminals.
    # Match their text without assuming a particular Unicode border theme.
    return re.sub(r"[\s\u2500-\u257f]", "", plain(value))


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def remove_owned_tree(root: Path, path: Path | None = None) -> None:
    """Clean exactly this fixture; lstat before traversal and never follow links."""
    current = root if path is None else path
    require(current == root or root in current.parents, "cleanup escaped fixture root")
    try:
        info = current.lstat()
    except FileNotFoundError:
        return
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        current.unlink()
        return
    current.chmod(0o700)
    for name in os.listdir(current):
        remove_owned_tree(root, current / name)
    current.rmdir()


def isolated_environment(case: Path, no_color: bool) -> dict[str, str]:
    home = case / "os-home"
    home.mkdir(mode=0o700)
    env = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": str(home), "USERPROFILE": str(home),
        "XDG_CONFIG_HOME": str(home / ".config"),
        "XDG_DATA_HOME": str(home / ".local" / "share"),
        "XDG_STATE_HOME": str(home / ".local" / "state"),
        "XDG_CACHE_HOME": str(home / ".cache"),
        "APPDATA": str(home / "AppData" / "Roaming"),
        "LOCALAPPDATA": str(home / "AppData" / "Local"),
        "CLAUDE_CONFIG_DIR": str(home / ".claude"),
        "CODEX_HOME": str(home / ".codex"),
        "OPENCODE_CONFIG_DIR": str(home / ".config" / "opencode"),
        "DSH_HOME": str(home / ".dsh"),
        "DSH_AGENTS_HOME": str(home / ".agents"),
        "HERMES_HOME": str(home / ".hermes"),
        "SKILLSHELF_HOME": str(case / "data-home"),
        "TMPDIR": str(case), "TMP": str(case), "TEMP": str(case),
        "TERM": "xterm-256color", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8",
    }
    # Do not inherit CI/FORCE_COLOR/CLACK_* overrides, NODE_OPTIONS, real Agent
    # roots, Panel credentials or provider keys. Test actual TTY defaults.
    if no_color:
        env["NO_COLOR"] = "1"
    return env


class Terminal:
    def __init__(self, command: list[str], env: dict[str, str], cwd: Path,
                 columns: int, timeout: float):
        self.timeout = timeout
        self.raw = bytearray()
        self.text = ""
        self.decoder = codecs.getincrementaldecoder("utf-8")("replace")
        self.eof = False
        self.master, slave = pty.openpty()
        self.exit_read, exit_write = os.pipe()
        self.exit_notified = False
        self.process = None
        self.waiter = None
        try:
            fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 36, columns, 0, 0))
            self.process = subprocess.Popen(
                command, stdin=slave, stdout=slave, stderr=slave, cwd=cwd,
                env=env, start_new_session=True, close_fds=True,
            )
            # One blocking waitpid thread signals a pipe; select therefore sees
            # both PTY data and exit on POSIX, without Linux-only pidfd or polls.
            def reap() -> None:
                try:
                    self.process.wait()
                    os.write(exit_write, b"x")
                finally:
                    os.close(exit_write)
            self.waiter = threading.Thread(target=reap, name="skillshelf-pty-reaper", daemon=True)
            self.waiter.start()
        except BaseException:
            if self.process is not None:
                self.process.kill()
                self.process.wait()
            os.close(self.master)
            os.close(self.exit_read)
            if self.waiter is None or not self.waiter.is_alive():
                os.close(exit_write)
            raise
        finally:
            os.close(slave)

    def mark(self) -> int:
        return len(self.text)

    def _pump(self, deadline: float) -> None:
        """Block for output/process readiness, never sleep or busy-poll."""
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("PTY deadline expired")
        descriptors = ([] if self.eof else [self.master])
        if not self.exit_notified:
            descriptors.append(self.exit_read)
        if not descriptors:
            raise AssertionError("child closed its PTY without a process-exit notification")
        ready, _, _ = select.select(descriptors, [], [], remaining)
        if not ready:
            raise TimeoutError("no PTY output/process exit before deadline")
        if self.master in ready:
            try:
                chunk = os.read(self.master, 65536)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                chunk = b""
            if chunk:
                self.raw.extend(chunk)
                require(len(self.raw) <= CAPTURE_LIMIT, "PTY transcript exceeded bounded capture")
                self.text += self.decoder.decode(chunk)
            else:
                self.eof = True
                self.text += self.decoder.decode(b"", final=True)
        if self.exit_read in ready:
            os.read(self.exit_read, 1)
            self.exit_notified = True

    def expect(self, *tokens: str, since: int = 0) -> str:
        deadline = time.monotonic() + self.timeout
        expected = [compact(token) for token in tokens]
        while True:
            segment = self.text[since:]
            normalized = compact(segment)
            if all(token in normalized for token in expected):
                return segment
            if self.eof:
                raise AssertionError("CLI exited before text appeared: " + repr(tokens))
            try:
                self._pump(deadline)
            except TimeoutError as error:
                raise TimeoutError("waiting for " + repr(tokens)) from error

    def send(self, data: bytes) -> int:
        require(self.process.returncode is None, "cannot type into an exited CLI")
        marker = self.mark()
        deadline = time.monotonic() + self.timeout
        view = memoryview(data)
        while view:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("PTY input deadline expired")
            _, ready, _ = select.select([], [self.master], [], remaining)
            if not ready:
                raise TimeoutError("PTY not writable before deadline")
            count = os.write(self.master, view)
            require(count > 0, "PTY write made no progress")
            view = view[count:]
        return marker

    def resize(self, columns: int) -> int:
        marker = self.mark()
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", 36, columns, 0, 0))
        os.kill(self.process.pid, signal.SIGWINCH)
        return marker

    def wait_exit(self, expected: int = 0) -> None:
        deadline = time.monotonic() + self.timeout
        while not self.exit_notified or not self.eof:
            self._pump(deadline)
        require(self.process.returncode == expected,
                "CLI exit code " + str(self.process.returncode) + " != " + str(expected))

    def close(self) -> None:
        try:
            if self.process.returncode is None:
                # Only this Popen-created session/process group is terminated.
                try:
                    os.killpg(self.process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            if not self.exit_notified:
                ready, _, _ = select.select([self.exit_read], [], [], self.timeout)
                require(bool(ready), "child did not exit before cleanup deadline")
                os.read(self.exit_read, 1)
                self.exit_notified = True
            self.waiter.join(self.timeout)
            require(not self.waiter.is_alive(), "PTY reaper did not finish before deadline")
        finally:
            os.close(self.exit_read)
            os.close(self.master)


def assert_main(terminal: Terminal, since: int = 0) -> None:
    terminal.expect("全局库 0 项", "0 个Agent目标", "浏览与安装技能", "退出", since=since)


def exit_main(terminal: Terminal) -> None:
    # The current eight-option menu is freshly rendered with its first item
    # active. Clack select supports wrap-around arrows, not an End action.
    marker = terminal.send(UP + ENTER)
    terminal.expect("本地技能保持可用，再见。", since=marker)
    terminal.wait_exit()


def cancel_subflow(terminal: Terminal, key: bytes) -> None:
    marker = terminal.send(ENTER)
    terminal.expect("安装范围", "全局共享技能库", since=marker)
    marker = terminal.send(key)
    terminal.expect("已取消，返回菜单", since=marker)
    assert_main(terminal, since=marker)


def resize_long_prompt_and_cancel(terminal: Terminal, columns: int) -> None:
    marker = terminal.send(ENTER)
    terminal.expect("安装范围", "全局共享技能库", "同一系统用户的多个Agent共用", since=marker)
    # Clack deliberately emits nothing when resize leaves its frame identical.
    # The main menu fits 40 columns, so its lack of repaint is not a failure.
    # This scope option + long hint necessarily wraps at 40 but fits at 120.
    # Assert actual post-signal reflow text, not a stale full-transcript match.
    resized = 120 if columns == 40 else 40
    marker = terminal.resize(resized)
    terminal.expect("同一系统用户的多个Agent共用", since=marker)
    marker = terminal.resize(columns)
    terminal.expect("同一系统用户的多个Agent共用", since=marker)
    marker = terminal.send(ESCAPE)
    terminal.expect("已取消，返回菜单", since=marker)
    assert_main(terminal, since=marker)


def shared_query(catalog: dict) -> str:
    """Find a real catalog label substring matching at least two selectable rows."""
    titles = [entry["title"] for entry in catalog["skills"]]
    require(len(titles) >= 2, "preview smoke needs at least two catalog skills")
    candidates = ["Taste"]
    for title in titles:
        candidates.extend(re.findall(r"[A-Za-z][A-Za-z0-9/-]+", title))
        candidates.extend(title[index:index + 2] for index in range(len(title) - 1)
                          if all("\u4e00" <= char <= "\u9fff" for char in title[index:index + 2]))
    for query in dict.fromkeys(candidates):
        count = sum(query.casefold() in title.casefold() for title in titles)
        if 2 <= count < len(titles):
            return query
    raise AssertionError("catalog needs a shared title keyword matching 2+ but not all skills for real search smoke")


def preview_without_install(terminal: Terminal, query: str) -> None:
    marker = terminal.send(ENTER)
    terminal.expect("安装范围", since=marker)
    marker = terminal.send(ENTER)  # explicit global default
    terminal.expect("浏览分类", since=marker)
    marker = terminal.send(ENTER)  # all categories
    terminal.expect("搜索并选择技能", "Search:", since=marker)
    marker = terminal.send(query.encode("utf-8"))
    terminal.expect("Search:", query, "match", since=marker)
    # Clack autocomplete uses Space for selection only after arrow navigation.
    # Type/search first, then navigate to and select two distinct filtered rows.
    marker = terminal.send(DOWN + b" " + DOWN + b" " + ENTER)
    terminal.expect("2 items selected", "选择共享技能的 Agent", since=marker)
    marker = terminal.send(ENTER)  # empty target selection => preview only download
    terminal.expect("完整包与目标预览", "确认下载完整技能", since=marker)
    preview = compact(terminal.text[marker:])
    require("安装预览" in preview or '"dryRun":true' in preview,
            "expected an actual dry-run installation preview")
    # The current confirmation's initial value is false. Enter declines; never
    # send 'y', space or left/right here, and never confirm an installation.
    marker = terminal.send(ENTER)
    assert_main(terminal, since=marker)
    require("下载、逐文件校验并接入" not in terminal.text, "preview unexpectedly started installation")


def run_case(root: Path, args: argparse.Namespace, columns: int,
             no_color: bool, preview: bool, query: str) -> dict:
    case = root / ("width-" + str(columns) + ("-no-color" if no_color else "-tty-color"))
    case.mkdir(mode=0o700)
    env = isolated_environment(case, no_color)
    cwd = case / "project"
    cwd.mkdir(mode=0o700)
    command = [args.node, str(args.cli), "--home", env["SKILLSHELF_HOME"],
               "--catalog", str(args.catalog), "--offline"]
    terminal = Terminal(command, env, cwd, columns, args.timeout)
    checks = []
    try:
        terminal.expect("SkillShelf", "个人精选", "本地共享", "不依赖云面板")
        assert_main(terminal)
        checks.append("real-clack-no-subcommand-chinese-menu")
        resize_long_prompt_and_cancel(terminal, columns)
        checks.append("SIGWINCH-long-hint-reflow-and-restore")
        cancel_subflow(terminal, CTRL_C)
        checks.append("escape-and-ctrl-c-subflow-return-to-main")
        if preview:
            preview_without_install(terminal, query)
            checks.append("search-two-space-selections-dry-run-decline")
        exit_main(terminal)
        checks.append("eight-option-main-wrap-up-exit")
        require("\ufffd" not in terminal.text, "UTF-8 terminal text was corrupted")
        if no_color:
            require(SGR.search(terminal.raw) is None,
                    "NO_COLOR still emitted SGR styling (cursor controls are allowed)")
            checks.append("NO_COLOR-no-SGR")
        # Menus, cancelled subflows and dry-run preview must not create a ledger,
        # cache, downloaded skill, Agent directory or provider configuration.
        require(not Path(env["SKILLSHELF_HOME"]).exists(), "read-only smoke created a SkillShelf data home")
        require(not any(Path(env["HOME"]).iterdir()), "read-only smoke changed the isolated OS/Agent home")
        require(not any(cwd.iterdir()), "read-only smoke changed its project directory")
        checks.append("no-install-no-agent-or-state-writes")
        return {"columns": columns, "noColor": no_color, "status": "passed",
                "capturedBytes": len(terminal.raw), "checks": checks}
    except BaseException as error:
        # JSON escaping keeps cursor codes out of the parent's terminal. This
        # fixture has no credentials, and only reports its bounded output tail.
        detail = {"columns": columns, "noColor": no_color, "error": str(error),
                  "transcriptTail": plain(terminal.text[-10000:])}
        print(json.dumps(detail, ensure_ascii=False), file=sys.stderr)
        raise
    finally:
        terminal.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--cli", required=True, type=Path, help="built CLI entry (read-only)")
    parser.add_argument("--catalog", required=True, type=Path, help="real catalog JSON (read-only)")
    parser.add_argument("--tmp", required=True, type=Path, help="existing user-owned private test directory")
    parser.add_argument("--node", default=shutil.which("node"), help="Node executable; defaults to PATH node")
    parser.add_argument("--timeout", type=float, default=15.0, help="deadline seconds per PTY interaction")
    args = parser.parse_args()
    if os.name != "posix":
        print(json.dumps({"status": "skipped", "reason": "POSIX PTY and SIGWINCH required; not Windows validation"}))
        return 0
    require(args.node is not None, "Node executable not found; pass --node")
    require(0 < args.timeout <= 120, "timeout must be within (0, 120] seconds")
    args.node = str(Path(args.node).resolve(strict=True))
    args.cli = args.cli.resolve(strict=True)
    args.catalog = args.catalog.resolve(strict=True)
    base = args.tmp.resolve(strict=True)
    require(base.is_dir(), "--tmp must be an existing directory")
    require(args.cli.is_file() and args.catalog.is_file(), "CLI and catalog must be regular files")
    catalog = json.loads(args.catalog.read_text(encoding="utf-8"))
    query = shared_query(catalog)
    root = Path(tempfile.mkdtemp(prefix="skillshelf-pty-", dir=base))
    identity = root.lstat()
    cases = []
    try:
        for width in (40, 80, 120):
            cases.append(run_case(root, args, width, True, width == 80, query))
        # Also exercise ordinary TTY capability detection, without forcing color.
        cases.append(run_case(root, args, 80, False, False, query))
        print(json.dumps({"schemaVersion": 1, "status": "passed", "platform": sys.platform,
                          "scope": "local POSIX PTY only; no cross-platform real-device claim",
                          "cases": cases}, ensure_ascii=False))
        return 0
    finally:
        current = root.lstat()
        require(stat.S_ISDIR(current.st_mode) and not stat.S_ISLNK(current.st_mode)
                and (current.st_dev, current.st_ino) == (identity.st_dev, identity.st_ino),
                "fixture root identity changed; refusing cleanup")
        remove_owned_tree(root)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (AssertionError, OSError, ValueError, TimeoutError) as error:
        print("terminal-smoke failed: " + str(error), file=sys.stderr)
        raise SystemExit(1)
