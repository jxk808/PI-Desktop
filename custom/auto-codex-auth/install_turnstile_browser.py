#!/usr/bin/env python3
"""Install a project-local Node runtime and puppeteer-real-browser bridge dependencies."""

from __future__ import annotations

import argparse
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path
from typing import Sequence


PROJECT_ROOT = Path(__file__).resolve().parent
NODE_VERSION = "v24.22.2"
NODE_RUNTIME_PARENT = PROJECT_ROOT / ".node-runtime"


def _platform_asset() -> tuple[str, str, Path]:
    machine = platform.machine().lower()
    architecture = {
        "amd64": "x64",
        "x86_64": "x64",
        "arm64": "arm64",
        "aarch64": "arm64",
    }.get(machine)
    if architecture is None:
        raise RuntimeError(f"unsupported CPU architecture: {platform.machine()}")

    if sys.platform == "win32":
        folder = f"node-{NODE_VERSION}-win-{architecture}"
        return f"{folder}.zip", folder, Path("node.exe")
    if sys.platform.startswith("linux"):
        folder = f"node-{NODE_VERSION}-linux-{architecture}"
        return f"{folder}.tar.xz", folder, Path("bin") / "node"
    raise RuntimeError(f"unsupported operating system: {platform.system()}")


def _download(url: str, destination: Path) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "codex-oauth-installer/1.0"})
    with urllib.request.urlopen(request, timeout=60) as response:
        with destination.open("wb") as output:
            shutil.copyfileobj(response, output)


def _validate_archive_path(base: Path, member_name: str) -> None:
    destination = (base / member_name).resolve()
    try:
        destination.relative_to(base.resolve())
    except ValueError as exc:
        raise RuntimeError(f"unsafe path in Node archive: {member_name}") from exc


def _extract_archive(archive: Path, destination: Path) -> None:
    if archive.suffix == ".zip":
        with zipfile.ZipFile(archive) as bundle:
            for member in bundle.infolist():
                _validate_archive_path(destination, member.filename)
            bundle.extractall(destination)
        return

    with tarfile.open(archive, mode="r:xz") as bundle:
        for member in bundle.getmembers():
            _validate_archive_path(destination, member.name)
        bundle.extractall(destination)


def install_node_runtime() -> Path:
    asset, folder, relative_executable = _platform_asset()
    runtime_root = NODE_RUNTIME_PARENT / folder
    node_executable = runtime_root / relative_executable
    if node_executable.is_file():
        return node_executable
    if runtime_root.exists():
        raise RuntimeError(
            f"incomplete Node runtime already exists at {runtime_root}; remove that folder and retry"
        )

    NODE_RUNTIME_PARENT.mkdir(parents=True, exist_ok=True)
    url = f"https://nodejs.org/dist/{NODE_VERSION}/{asset}"
    print(f"Downloading project-local Node.js {NODE_VERSION}: {url}")
    with tempfile.TemporaryDirectory(prefix="codex-node-install-") as temporary:
        temporary_path = Path(temporary)
        archive = temporary_path / asset
        extraction_root = temporary_path / "extracted"
        extraction_root.mkdir()
        _download(url, archive)
        _extract_archive(archive, extraction_root)
        extracted_runtime = extraction_root / folder
        if not (extracted_runtime / relative_executable).is_file():
            raise RuntimeError("downloaded Node archive does not contain the expected executable")
        shutil.move(str(extracted_runtime), str(runtime_root))

    if sys.platform != "win32":
        node_executable.chmod(node_executable.stat().st_mode | 0o111)
    return node_executable


def install_node_dependencies(node_executable: Path) -> None:
    runtime_root = node_executable.parent if sys.platform == "win32" else node_executable.parent.parent
    npm_cli = runtime_root / "node_modules" / "npm" / "bin" / "npm-cli.js"
    if not npm_cli.is_file():
        raise RuntimeError(f"npm was not found in the project-local Node runtime: {npm_cli}")

    command = [
        str(node_executable),
        str(npm_cli),
        "install",
        "--omit=dev",
        "--no-audit",
        "--no-fund",
    ]
    environment = os.environ.copy()
    environment["npm_config_update_notifier"] = "false"
    print("Installing puppeteer-real-browser dependencies...")
    subprocess.run(command, cwd=PROJECT_ROOT, env=environment, check=True)


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Install the local Node runtime and Turnstile browser bridge dependencies."
    )
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    parse_args(argv)
    try:
        node_executable = install_node_runtime()
        print(f"Using project-local Node.js: {node_executable}")
        install_node_dependencies(node_executable)
    except (OSError, RuntimeError, subprocess.CalledProcessError) as exc:
        print(f"Turnstile browser installation failed: {exc}", file=sys.stderr)
        return 1
    print("Turnstile browser installation completed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
