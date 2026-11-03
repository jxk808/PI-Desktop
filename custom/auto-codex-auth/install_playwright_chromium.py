#!/usr/bin/env python3
"""Install only Playwright Chromium into this project's browser directory."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path
from typing import Sequence


PROJECT_ROOT = Path(__file__).resolve().parent
PROJECT_BROWSER_PATH = PROJECT_ROOT / ".playwright-browsers"


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Install Playwright Chromium into .playwright-browsers."
    )
    parser.add_argument(
        "--with-deps",
        action="store_true",
        help="also install Linux system libraries required by Playwright Chromium",
    )
    return parser.parse_args(argv)


def build_install_command(with_deps: bool) -> list[str]:
    command = [sys.executable, "-m", "playwright", "install"]
    if with_deps:
        command.append("--with-deps")
    command.append("chromium")
    return command


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    environment = os.environ.copy()
    environment["PLAYWRIGHT_BROWSERS_PATH"] = str(PROJECT_BROWSER_PATH)
    command = build_install_command(args.with_deps)

    print(f"Installing project-local Playwright Chromium into: {PROJECT_BROWSER_PATH}")
    print("Command: " + " ".join(command))
    completed = subprocess.run(command, cwd=PROJECT_ROOT, env=environment, check=False)
    if completed.returncode == 0:
        print("Playwright Chromium installation completed.")
    return completed.returncode


if __name__ == "__main__":
    raise SystemExit(main())
