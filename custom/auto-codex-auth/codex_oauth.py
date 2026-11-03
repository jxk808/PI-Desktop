#!/usr/bin/env python3
"""Run Codex OAuth and import the resulting credentials into an admin API."""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import hmac
import json
import os
import platform
import queue
import secrets
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Mapping, Sequence, cast


AUTH_URL = "https://auth.openai.com/oauth/authorize"
TOKEN_URL = "https://auth.openai.com/oauth/token"
CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
CALLBACK_HOST = "127.0.0.1"
CALLBACK_PORT = 1455
CALLBACK_PATH = "/auth/callback"
REDIRECT_URI = f"http://localhost:{CALLBACK_PORT}{CALLBACK_PATH}"
OAUTH_SCOPES = "openid profile email offline_access"
DEFAULT_TIMEOUT_SECONDS = 300.0
TOKEN_REQUEST_TIMEOUT_SECONDS = 30.0
DEFAULT_BROWSER_TIMEOUT_SECONDS = 60.0
DEFAULT_IMPORT_URL = "http://127.0.0.1:28082/api/v1/admin/accounts/import/codex-session"
ADMIN_EMAIL = "gray-admin@pgzzzhc.local"
ADMIN_PASSWORD = "d6ed0f51a59c78bbcced138c4f1b9225"
ADMIN_TOKEN_REFRESH_MARGIN_SECONDS = 60.0
DEFAULT_LOGIN_FILE = Path(__file__).with_name("号.txt")
PROJECT_PLAYWRIGHT_BROWSERS_PATH = Path(__file__).with_name(".playwright-browsers")
PROJECT_NODE_RUNTIME_PATH = Path(__file__).with_name(".node-runtime")
PROJECT_NODE_VERSION = "v24.22.2"
TURNSTILE_BRIDGE_PATH = Path(__file__).with_name("turnstile_browser_bridge.js")
TURNSTILE_NODE_MODULE_PATH = Path(__file__).with_name("node_modules") / "puppeteer-real-browser"
TURNSTILE_BRIDGE_READY_PREFIX = "CODEX_TURNSTILE_BRIDGE="
TURNSTILE_BRIDGE_START_TIMEOUT_SECONDS = 60.0
LOGIN_FIELD_SEPARATOR = "----"
TOTP_PERIOD_SECONDS = 30
TOTP_DIGITS = 6
TOTP_MIN_VALIDITY_SECONDS = 5
ADMIN_TOKEN = ""
ADMIN_TOKEN_EXPIRES_AT = 0.0
CREDENTIAL_FIELD_ORDER = (
    "access_token",
    "account_id",
    "disabled",
    "email",
    "expired",
    "id_token",
    "last_refresh",
    "plan_type",
    "refresh_token",
    "type",
)
MODEL_MAPPING = {
    "codex-auto-review": "codex-auto-review",
    "gpt-5.6-luna": "gpt-5.6-luna",
    "gpt-5.6-sol": "gpt-5.6-sol",
    "gpt-5.6-terra": "gpt-5.6-terra",
    "gpt-6-astra": "gpt-6-astra",
    "gpt-6-luna": "gpt-6-luna",
    "gpt-6-sol": "gpt-6-sol",
    "gpt-6.1-sol": "gpt-6.1-sol",
    "gpt-reserve": "gpt-reserve",
}
EMAIL_INPUT_SELECTOR = 'input[type="email"], input[name="email"], input[autocomplete="email"]'
PASSWORD_INPUT_SELECTOR = (
    'input[type="password"], input[name="password"], input[autocomplete="current-password"]'
)
TOTP_INPUT_SELECTOR = (
    'input[autocomplete="one-time-code"], input[name="code"], input[name="otp"], '
    'input[inputmode="numeric"]'
)
SUBMIT_BUTTON_SELECTOR = 'button[type="submit"]'
AUTHORIZATION_BUTTON_SELECTOR = 'button, input[type="submit"], [role="button"]'


class OAuthError(RuntimeError):
    """Raised when the OAuth flow cannot be completed safely."""


@dataclass(frozen=True)
class PKCECodes:
    verifier: str
    challenge: str


@dataclass(frozen=True)
class OAuthCallback:
    code: str = ""
    state: str = ""
    error: str = ""
    error_description: str = ""


@dataclass(frozen=True)
class LoginCredentials:
    email: str
    password: str
    totp_secret: str


@dataclass
class TurnstileBrowserBridge:
    process: subprocess.Popen[str]
    output_thread: threading.Thread

    def close(self) -> None:
        if self.process.poll() is None:
            try:
                if self.process.stdin is not None:
                    self.process.stdin.write("close\n")
                    self.process.stdin.flush()
                self.process.wait(timeout=5)
            except (BrokenPipeError, OSError, subprocess.TimeoutExpired):
                if self.process.poll() is None:
                    self.process.terminate()
                    try:
                        self.process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        self.process.kill()
                        self.process.wait(timeout=5)
        for stream in (self.process.stdin, self.process.stdout):
            if stream is not None:
                try:
                    stream.close()
                except OSError:
                    pass
        self.output_thread.join(timeout=1)


def select_playwright_chromium_executable(chromium: Any) -> str:
    """Select only project-local Playwright Chromium, never a system browser."""
    default_executable = Path(chromium.executable_path)
    project_root = PROJECT_PLAYWRIGHT_BROWSERS_PATH.resolve()
    try:
        default_executable.resolve().relative_to(project_root)
    except ValueError as exc:
        raise OAuthError(
            "Playwright resolved Chromium outside the project browser directory: "
            f"{default_executable}"
        ) from exc
    repaired_executable = default_executable.with_name("chrome_no_sxs.exe")
    if repaired_executable.is_file():
        return str(repaired_executable)
    return str(default_executable)


def configure_project_playwright_browser_path() -> Path:
    """Force Playwright to use the project-local browser directory on every OS."""
    os.environ["PLAYWRIGHT_BROWSERS_PATH"] = str(PROJECT_PLAYWRIGHT_BROWSERS_PATH)
    return PROJECT_PLAYWRIGHT_BROWSERS_PATH


def select_project_node_executable() -> Path:
    architecture = {
        "amd64": "x64",
        "x86_64": "x64",
        "arm64": "arm64",
        "aarch64": "arm64",
    }.get(platform.machine().lower())
    if architecture is None:
        raise OAuthError(f"unsupported CPU architecture: {platform.machine()}")

    if sys.platform == "win32":
        relative_path = Path(f"node-{PROJECT_NODE_VERSION}-win-{architecture}") / "node.exe"
    elif sys.platform.startswith("linux"):
        relative_path = (
            Path(f"node-{PROJECT_NODE_VERSION}-linux-{architecture}") / "bin" / "node"
        )
    else:
        raise OAuthError(f"unsupported operating system: {platform.system()}")
    return PROJECT_NODE_RUNTIME_PATH / relative_path


def get_host_screen_dimensions() -> tuple[int, int]:
    if sys.platform == "win32":
        try:
            import ctypes

            user32 = ctypes.windll.user32
            width = int(user32.GetSystemMetrics(0))
            height = int(user32.GetSystemMetrics(1))
            if width > 0 and height > 0:
                return width, height
        except (AttributeError, OSError, TypeError, ValueError):
            pass
    return 1920, 1080


def _capture_bridge_output(
    process: subprocess.Popen[str], output_queue: "queue.Queue[str]"
) -> None:
    if process.stdout is None:
        return
    for line in process.stdout:
        output_queue.put(line.rstrip())


def start_turnstile_browser_bridge(
    browser_executable: str,
    headed: bool,
) -> tuple[TurnstileBrowserBridge, str]:
    node_executable = select_project_node_executable()
    if not node_executable.is_file() or not TURNSTILE_NODE_MODULE_PATH.is_dir():
        raise OAuthError(
            "the project-local Turnstile browser is not installed; run "
            "'.\\.venv\\Scripts\\python.exe .\\install_turnstile_browser.py' first"
        )
    if not TURNSTILE_BRIDGE_PATH.is_file():
        raise OAuthError(f"Turnstile browser bridge is missing: {TURNSTILE_BRIDGE_PATH}")

    screen_width, screen_height = get_host_screen_dimensions()
    config = base64.urlsafe_b64encode(
        json.dumps(
            {
                "chromePath": browser_executable,
                "headless": not headed,
                "metadataUrl": f"http://{CALLBACK_HOST}:{CALLBACK_PORT}/success",
                "screenWidth": screen_width,
                "screenHeight": screen_height,
                "windowWidth": 1365,
                "windowHeight": 820,
            },
            separators=(",", ":"),
        ).encode("utf-8")
    ).rstrip(b"=").decode("ascii")
    environment = os.environ.copy()
    environment["NO_COLOR"] = "1"
    try:
        process = subprocess.Popen(
            [str(node_executable), str(TURNSTILE_BRIDGE_PATH), config],
            cwd=Path(__file__).resolve().parent,
            env=environment,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
    except OSError as exc:
        raise OAuthError(f"could not start the Turnstile browser bridge: {exc}") from exc

    output_queue: queue.Queue[str] = queue.Queue()
    output_thread = threading.Thread(
        target=_capture_bridge_output,
        args=(process, output_queue),
        name="turnstile-browser-output",
        daemon=True,
    )
    output_thread.start()
    bridge = TurnstileBrowserBridge(process=process, output_thread=output_thread)
    output_lines: list[str] = []
    deadline = time.monotonic() + TURNSTILE_BRIDGE_START_TIMEOUT_SECONDS

    try:
        while time.monotonic() < deadline:
            try:
                line = output_queue.get(timeout=0.25)
            except queue.Empty:
                if process.poll() is not None:
                    break
                continue
            if not line:
                continue
            if line.startswith(TURNSTILE_BRIDGE_READY_PREFIX):
                payload = json.loads(line.removeprefix(TURNSTILE_BRIDGE_READY_PREFIX))
                endpoint = str(payload.get("endpoint", "")).strip()
                if not endpoint:
                    raise OAuthError("Turnstile browser bridge returned an empty CDP endpoint")
                return bridge, endpoint
            output_lines.append(line)
            output_lines = output_lines[-10:]
    except (json.JSONDecodeError, OSError, ValueError) as exc:
        bridge.close()
        raise OAuthError(f"Turnstile browser bridge returned invalid startup data: {exc}") from exc

    exit_code = process.poll()
    bridge.close()
    detail = " | ".join(output_lines[-5:]) or "no startup details were produced"
    if exit_code is None:
        raise OAuthError(
            "Turnstile browser bridge did not start within "
            f"{TURNSTILE_BRIDGE_START_TIMEOUT_SECONDS:g} seconds ({detail})"
        )
    raise OAuthError(f"Turnstile browser bridge exited with code {exit_code} ({detail})")


def generate_oauth_state() -> str:
    """Generate the 32-byte hex OAuth state used by pgzzzhc."""
    return secrets.token_hex(32)


def generate_pkce_codes() -> PKCECodes:
    """Create the 64-byte hex verifier and S256 challenge used by pgzzzhc."""
    verifier = secrets.token_hex(64)
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return PKCECodes(verifier=verifier, challenge=challenge)


def read_login_credentials(path: str | Path) -> list[LoginCredentials]:
    credential_path = Path(path)
    try:
        raw = credential_path.read_text(encoding="utf-8-sig").strip()
    except OSError as exc:
        raise OAuthError(f"cannot read login credentials from {credential_path}") from exc

    lines = [line.strip() for line in raw.splitlines() if line.strip()]
    if not lines:
        raise OAuthError(f"{credential_path} does not contain any accounts")

    accounts: list[LoginCredentials] = []
    for line_number, line in enumerate(lines, start=1):
        fields = [field.strip() for field in line.split(LOGIN_FIELD_SEPARATOR)]
        first_field = fields[0] if fields else ""
        if "@" not in first_field:
            later_has_account = any(
                "@" in later.split(LOGIN_FIELD_SEPARATOR, 1)[0]
                for later in lines[line_number:]
            )
            if accounts and not later_has_account:
                # Account suppliers sometimes append order metadata after the
                # credentials. Ignore only a trailing non-account block; a bad
                # line between accounts still rejects the entire batch.
                break
            raise OAuthError(
                f"{credential_path} line {line_number} contains an invalid email address"
            )
        if len(fields) not in {3, 4}:
            raise OAuthError(
                f"{credential_path} line {line_number} must use "
                "email----password----totp-secret[----source-url] format"
            )

        email, password, totp_secret = fields[:3]
        if len(fields) == 4:
            try:
                source_url = urllib.parse.urlsplit(fields[3])
            except ValueError as exc:
                raise OAuthError(
                    f"{credential_path} line {line_number} contains an invalid source URL"
                ) from exc
            if (
                source_url.scheme not in {"http", "https"}
                or not source_url.hostname
                or source_url.username is not None
                or source_url.password is not None
            ):
                raise OAuthError(
                    f"{credential_path} line {line_number} contains an invalid source URL"
                )
        if not password:
            raise OAuthError(f"{credential_path} line {line_number} contains an empty password")

        try:
            normalized_secret = normalize_totp_secret(totp_secret)
        except OAuthError as exc:
            raise OAuthError(f"{credential_path} line {line_number}: {exc}") from exc
        accounts.append(
            LoginCredentials(
                email=email,
                password=password,
                totp_secret=normalized_secret,
            )
        )

    return accounts


def normalize_totp_secret(secret: str) -> str:
    normalized = "".join(secret.split()).upper().rstrip("=")
    if not normalized:
        raise OAuthError("TOTP secret is empty")
    padding = "=" * (-len(normalized) % 8)
    try:
        decoded = base64.b32decode(normalized + padding, casefold=True)
    except (binascii.Error, ValueError, TypeError) as exc:
        raise OAuthError("TOTP secret is not valid Base32") from exc
    if not decoded:
        raise OAuthError("TOTP secret is empty")
    return normalized


def generate_totp(
    secret: str,
    at_time: float | int | None = None,
    period: int = TOTP_PERIOD_SECONDS,
    digits: int = TOTP_DIGITS,
) -> str:
    if period <= 0:
        raise ValueError("TOTP period must be greater than zero")
    if digits <= 0 or digits > 10:
        raise ValueError("TOTP digits must be between 1 and 10")

    normalized = normalize_totp_secret(secret)
    padding = "=" * (-len(normalized) % 8)
    key = base64.b32decode(normalized + padding, casefold=True)
    timestamp = time.time() if at_time is None else float(at_time)
    counter = int(timestamp // period).to_bytes(8, byteorder="big")
    digest = hmac.new(key, counter, hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    binary_code = int.from_bytes(digest[offset : offset + 4], byteorder="big") & 0x7FFFFFFF
    return f"{binary_code % (10**digits):0{digits}d}"


def generate_fresh_totp(secret: str) -> str:
    now = time.time()
    remaining = TOTP_PERIOD_SECONDS - (now % TOTP_PERIOD_SECONDS)
    if remaining < TOTP_MIN_VALIDITY_SECONDS:
        time.sleep(remaining + 0.1)
    return generate_totp(secret)


def build_authorization_url(state: str, pkce: PKCECodes) -> str:
    params = {
        "response_type": "code",
        "client_id": CLIENT_ID,
        "redirect_uri": REDIRECT_URI,
        "scope": OAUTH_SCOPES,
        "state": state,
        "code_challenge": pkce.challenge,
        "code_challenge_method": "S256",
        "id_token_add_organizations": "true",
        "codex_cli_simplified_flow": "true",
    }
    return f"{AUTH_URL}?{urllib.parse.urlencode(sorted(params.items()))}"


def validate_external_authorization_url(url: str) -> str:
    """Accept only the public OpenAI authorization URL generated by PI-Desktop."""
    try:
        parsed = urllib.parse.urlsplit(url)
        params = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
    except ValueError as exc:
        raise OAuthError("PI-Desktop returned an invalid authorization URL") from exc

    if (
        parsed.scheme != "https"
        or parsed.hostname != "auth.openai.com"
        or parsed.port is not None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path != "/oauth/authorize"
        or parsed.fragment
    ):
        raise OAuthError("PI-Desktop authorization URL must use https://auth.openai.com/oauth/authorize")

    required = {
        "client_id": CLIENT_ID,
        "redirect_uri": REDIRECT_URI,
        "response_type": "code",
    }
    for key, expected in required.items():
        if params.get(key) != [expected]:
            raise OAuthError(f"PI-Desktop authorization URL has an invalid {key}")
    for key in ("state", "code_challenge"):
        values = params.get(key, [])
        if len(values) != 1 or not values[0].strip():
            raise OAuthError(f"PI-Desktop authorization URL is missing {key}")
    if params.get("code_challenge_method") != ["S256"]:
        raise OAuthError("PI-Desktop authorization URL must use PKCE S256")
    return url


def _is_local_callback_url(url: str) -> bool:
    parsed = urllib.parse.urlsplit(url)
    return (
        parsed.scheme == "http"
        and parsed.hostname in {"localhost", "127.0.0.1"}
        and parsed.port == CALLBACK_PORT
        and parsed.path in {CALLBACK_PATH, "/success"}
    )


def _page_title_and_text(page: Any) -> tuple[str, str]:
    try:
        title = page.title().lower()
    except Exception:
        title = ""
    try:
        body_text = page.locator("body").inner_text(timeout=1_000).lower()
    except Exception:
        body_text = ""
    return title, body_text


def _is_cloudflare_verification_page(
    page: Any,
    title: str | None = None,
    body_text: str | None = None,
) -> bool:
    current_url = page.url.lower()
    if any(
        marker in current_url
        for marker in ("challenges.cloudflare.com", "/cdn-cgi/challenge-platform/", "__cf_chl_")
    ):
        return True
    try:
        if page.locator('[name="cf-turnstile-response"]').count():
            return True
    except Exception:
        pass
    if title is None or body_text is None:
        title, body_text = _page_title_and_text(page)
    return any(
        marker in title or marker in body_text
        for marker in (
            "verify you are human",
            "verifying you are human",
            "performing security verification",
            "checking your browser",
            "cloudflare security",
            "确认您是真人",
            "正在验证您是否是真人",
            "正在进行安全验证",
            "安全验证",
        )
    )


def _raise_for_blocked_login(page: Any) -> None:
    title, body_text = _page_title_and_text(page)
    if _is_cloudflare_verification_page(page, title, body_text):
        return

    if "unexpected token" in title or "unexpected token" in body_text:
        raise OAuthError(
            "OpenAI login API returned HTML instead of JSON (Unexpected token '<'); "
            "Cloudflare/WAF rejected the email continuation request"
        )

    challenge_phrases = (
        "something went wrong",
        "糟糕，出错了",
    )
    if any(phrase in title or phrase in body_text for phrase in challenge_phrases):
        raise OAuthError(
            "OpenAI blocked or failed the automated login page; retry later or use a manual login flow"
        )


def _wait_for_input_or_callback(
    page: Any,
    selector: str,
    step_name: str,
    timeout_seconds: float,
) -> Any | None:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        _raise_for_blocked_login(page)
        if _is_local_callback_url(page.url):
            return None
        try:
            locators = page.locator(selector)
            for index in range(locators.count()):
                locator = locators.nth(index)
                if locator.is_visible():
                    return locator
        except Exception:
            pass
        page.wait_for_timeout(200)
    if _is_cloudflare_verification_page(page):
        raise OAuthError(
            "Cloudflare verification did not complete within "
            f"{timeout_seconds:g} seconds; retry with --headed for manual verification"
        )
    raise OAuthError(
        f"OpenAI did not show the expected {step_name} field within {timeout_seconds:g} seconds"
    )


def _visible_submit_button(page: Any, timeout_seconds: float) -> Any:
    button = _wait_for_input_or_callback(
        page,
        SUBMIT_BUTTON_SELECTOR,
        "continue button",
        timeout_seconds,
    )
    if button is None:
        raise OAuthError("OpenAI redirected before the login form was submitted")
    return button


def _button_label(button: Any) -> str:
    parts: list[str] = []
    try:
        parts.append(button.inner_text(timeout=500))
    except Exception:
        pass
    for attribute in ("value", "aria-label", "title"):
        try:
            value = button.get_attribute(attribute)
        except Exception:
            value = None
        if value:
            parts.append(value)
    return " ".join(parts).strip().lower()


def _click_authorization_button(page: Any) -> bool:
    title, body_text = _page_title_and_text(page)
    current_url = page.url.lower()
    consent_page = "consent" in current_url or any(
        marker in title or marker in body_text
        for marker in (
            "authorize codex",
            "allow codex",
            "continue to codex",
            "授权 codex",
            "允许 codex",
        )
    )
    if not consent_page:
        return False

    positive_labels = (
        "continue",
        "allow",
        "authorize",
        "approve",
        "confirm",
        "继续",
        "允许",
        "授权",
        "同意",
        "确认",
    )
    negative_labels = ("cancel", "deny", "reject", "back", "取消", "拒绝", "返回")
    candidates: list[Any] = []
    try:
        buttons = page.locator(AUTHORIZATION_BUTTON_SELECTOR)
        for index in range(buttons.count()):
            button = buttons.nth(index)
            if button.is_visible() and button.is_enabled():
                candidates.append(button)
    except Exception:
        return False

    for button in candidates:
        label = _button_label(button)
        if any(word in label for word in negative_labels):
            continue
        if any(word in label for word in positive_labels):
            button.click()
            return True

    if len(candidates) == 1:
        label = _button_label(candidates[0])
        if not any(word in label for word in negative_labels):
            candidates[0].click()
            return True
    return False


def _validate_callback(callback: OAuthCallback, expected_state: str) -> OAuthCallback:
    if callback.error:
        detail = callback.error_description or callback.error
        raise OAuthError(f"authorization failed: {detail}")
    if not hmac.compare_digest(callback.state, expected_state):
        raise OAuthError("OAuth state mismatch; the callback was rejected")
    return callback


def _poll_callback(
    server: "OAuthCallbackServer", expected_state: str
) -> OAuthCallback | None:
    try:
        callback = server.result_queue.get_nowait()
    except queue.Empty:
        return None
    return _validate_callback(callback, expected_state)


def _wait_for_authorization_completion(
    page: Any,
    server: "OAuthCallbackServer",
    expected_state: str,
    callback_timeout: float,
) -> OAuthCallback:
    deadline = time.monotonic() + callback_timeout

    while time.monotonic() < deadline:
        callback = _poll_callback(server, expected_state)
        if callback is not None:
            return callback

        _raise_for_blocked_login(page)
        if _click_authorization_button(page):
            print("Codex authorization confirmed. Waiting for the OAuth callback...")
            page.wait_for_timeout(500)
            continue

        page.wait_for_timeout(200)

    raise OAuthError(
        f"timed out after {callback_timeout:g} seconds waiting for the OAuth callback"
    )


def _wait_for_external_callback(page: Any, callback_timeout: float) -> None:
    """Wait until PI-Desktop receives the callback; never read its authorization code."""
    deadline = time.monotonic() + callback_timeout
    while time.monotonic() < deadline:
        if _is_local_callback_url(page.url):
            return
        _raise_for_blocked_login(page)
        if _click_authorization_button(page):
            print("Codex authorization confirmed. Waiting for PI-Desktop to receive the callback...")
            page.wait_for_timeout(500)
            continue
        page.wait_for_timeout(200)
    raise OAuthError(
        f"timed out after {callback_timeout:g} seconds waiting for the PI-Desktop OAuth callback"
    )


def automate_oauth_login(
    authorization_url: str,
    credentials: LoginCredentials,
    server: "OAuthCallbackServer | None",
    expected_state: str | None,
    callback_timeout: float,
    browser_timeout: float,
    headed: bool = False,
) -> OAuthCallback | None:
    configured_browser_path = configure_project_playwright_browser_path()
    print(f"Using project-local Playwright browsers: {configured_browser_path}")
    try:
        from playwright.sync_api import Error as PlaywrightError
        from playwright.sync_api import sync_playwright
    except ImportError as exc:
        raise OAuthError(
            "Playwright is not installed; run 'python -m pip install -e .' and then "
            "'python install_playwright_chromium.py'"
        ) from exc

    stage = "browser startup"
    try:
        with sync_playwright() as playwright:
            bridge: TurnstileBrowserBridge | None = None
            browser = None
            try:
                browser_executable = select_playwright_chromium_executable(playwright.chromium)
                if not Path(browser_executable).is_file():
                    raise OAuthError(
                        "project-local Playwright Chromium is not installed; follow the "
                        "Windows or Linux installation command in README.md"
                    )
                print(f"Using Playwright Chromium executable: {browser_executable}")
                print("Starting puppeteer-real-browser with Turnstile support...")
                bridge, cdp_endpoint = start_turnstile_browser_bridge(
                    browser_executable=browser_executable,
                    headed=headed,
                )
                browser = playwright.chromium.connect_over_cdp(
                    cdp_endpoint,
                    timeout=int(TURNSTILE_BRIDGE_START_TIMEOUT_SECONDS * 1_000),
                )
                if not browser.contexts:
                    raise OAuthError("Turnstile browser did not expose a Chromium context")
                context = browser.contexts[0]
                page = context.pages[0] if context.pages else context.new_page()
                print("Turnstile-enabled browser connected.")
            except OAuthError:
                if bridge is not None:
                    bridge.close()
                raise
            except PlaywrightError as exc:
                if bridge is not None:
                    bridge.close()
                error_detail = str(exc).splitlines()[0]
                raise OAuthError(
                    "project-local Turnstile browser could not be started "
                    f"({error_detail})"
                ) from exc

            try:
                stage = "authorization page"
                page.goto(
                    authorization_url,
                    wait_until="domcontentloaded",
                    timeout=int(browser_timeout * 1_000),
                )

                stage = "email"
                email_input = _wait_for_input_or_callback(
                    page,
                    EMAIL_INPUT_SELECTOR,
                    "email",
                    browser_timeout,
                )
                if email_input is None:
                    if server is None:
                        return None
                    if expected_state is None:
                        raise OAuthError("missing OAuth state for the local callback")
                    return wait_for_callback(server, expected_state, callback_timeout)
                email_input.fill(credentials.email)
                _visible_submit_button(page, browser_timeout).click()

                stage = "password"
                password_input = _wait_for_input_or_callback(
                    page,
                    PASSWORD_INPUT_SELECTOR,
                    "password",
                    browser_timeout,
                )
                if password_input is None:
                    if server is None:
                        return None
                    if expected_state is None:
                        raise OAuthError("missing OAuth state for the local callback")
                    return wait_for_callback(server, expected_state, callback_timeout)
                password_input.fill(credentials.password)
                _visible_submit_button(page, browser_timeout).click()

                stage = "authenticator code"
                totp_input = _wait_for_input_or_callback(
                    page,
                    TOTP_INPUT_SELECTOR,
                    "authenticator code",
                    browser_timeout,
                )
                if totp_input is not None:
                    totp_input.fill(generate_fresh_totp(credentials.totp_secret))
                    _visible_submit_button(page, browser_timeout).click()

                print("Login form submitted. Checking the Codex authorization page...")
                stage = "authorization confirmation"
                if server is None:
                    _wait_for_external_callback(page, callback_timeout)
                    return None
                if expected_state is None:
                    raise OAuthError("missing OAuth state for the local callback")
                return _wait_for_authorization_completion(
                    page=page,
                    server=server,
                    expected_state=expected_state,
                    callback_timeout=callback_timeout,
                )
            finally:
                if browser is not None:
                    browser.close()
                if bridge is not None:
                    bridge.close()
    except OAuthError:
        raise
    except PlaywrightError as exc:
        raise OAuthError(f"browser automation failed during the {stage} step") from exc
    except Exception as exc:
        raise OAuthError(f"unexpected browser automation failure during the {stage} step") from exc


class OAuthCallbackServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, server_address: tuple[str, int]) -> None:
        self.result_queue: queue.Queue[OAuthCallback] = queue.Queue(maxsize=1)
        super().__init__(server_address, OAuthCallbackHandler)

    def publish(self, callback: OAuthCallback) -> None:
        try:
            self.result_queue.put_nowait(callback)
        except queue.Full:
            pass


class OAuthCallbackHandler(BaseHTTPRequestHandler):
    server_version = "CodexOAuth/1.0"

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path == CALLBACK_PATH:
            self._handle_callback(parsed.query)
            return
        if parsed.path == "/success":
            self._send_html(
                200,
                "<h1>Codex authentication received</h1>"
                "<p>You can close this window and return to the terminal.</p>",
            )
            return
        self.send_error(404)

    def _handle_callback(self, raw_query: str) -> None:
        params = urllib.parse.parse_qs(raw_query, keep_blank_values=True)
        callback = OAuthCallback(
            code=_first(params, "code"),
            state=_first(params, "state"),
            error=_first(params, "error"),
            error_description=_first(params, "error_description"),
        )

        if not callback.error and not callback.code:
            callback = OAuthCallback(error="missing_code")
        elif not callback.error and not callback.state:
            callback = OAuthCallback(error="missing_state")

        cast(OAuthCallbackServer, self.server).publish(callback)
        if callback.error:
            message = callback.error_description or callback.error
            self._send_html(400, f"<h1>Codex authentication failed</h1><p>{_html_escape(message)}</p>")
            return

        self.send_response(302)
        self.send_header("Location", "/success")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def _send_html(self, status: int, body: str) -> None:
        payload = (
            "<!doctype html><html><head><meta charset=\"utf-8\">"
            "<title>Codex OAuth</title></head><body>"
            f"{body}</body></html>"
        ).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format: str, *args: object) -> None:
        return


def _first(params: Mapping[str, list[str]], key: str) -> str:
    values = params.get(key)
    return values[0].strip() if values else ""


def _html_escape(value: str) -> str:
    return (
        value.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#x27;")
    )


def wait_for_callback(
    server: OAuthCallbackServer, expected_state: str, timeout: float
) -> OAuthCallback:
    try:
        callback = server.result_queue.get(timeout=timeout)
    except queue.Empty as exc:
        raise OAuthError(f"timed out after {timeout:g} seconds waiting for the OAuth callback") from exc

    return _validate_callback(callback, expected_state)


def exchange_code_for_tokens(code: str, verifier: str) -> dict[str, Any]:
    form = urllib.parse.urlencode(
        {
            "grant_type": "authorization_code",
            "client_id": CLIENT_ID,
            "code": code,
            "redirect_uri": REDIRECT_URI,
            "code_verifier": verifier,
        }
    ).encode("ascii")
    request = urllib.request.Request(
        TOKEN_URL,
        data=form,
        headers={
            "Accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=TOKEN_REQUEST_TIMEOUT_SECONDS) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise OAuthError(f"token exchange failed with HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise OAuthError(f"token exchange request failed: {exc.reason}") from exc

    try:
        token_response = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise OAuthError("token endpoint returned invalid JSON") from exc
    if not isinstance(token_response, dict):
        raise OAuthError("token endpoint returned an unexpected JSON value")

    for field in ("access_token", "refresh_token", "id_token"):
        if not isinstance(token_response.get(field), str) or not token_response[field].strip():
            raise OAuthError(f"token response is missing {field}")
    return token_response


def parse_jwt_claims(token: str) -> dict[str, Any]:
    parts = token.split(".")
    if len(parts) != 3:
        raise OAuthError("ID token has an invalid JWT format")
    padded = parts[1] + "=" * (-len(parts[1]) % 4)
    try:
        payload = base64.urlsafe_b64decode(padded.encode("ascii"))
        claims = json.loads(payload)
    except (ValueError, UnicodeError, json.JSONDecodeError) as exc:
        raise OAuthError("ID token contains invalid claims") from exc
    if not isinstance(claims, dict):
        raise OAuthError("ID token claims are not a JSON object")
    return claims


def build_credentials(token_response: Mapping[str, Any], now: datetime | None = None) -> dict[str, Any]:
    id_token = _required_string(token_response, "id_token")
    claims = parse_jwt_claims(id_token)
    auth_info = claims.get("https://api.openai.com/auth")
    if not isinstance(auth_info, dict):
        auth_info = {}

    email = _optional_string(claims.get("email"))
    if not email:
        raise OAuthError("ID token is missing the account email")
    account_id = _optional_string(auth_info.get("chatgpt_account_id"))
    plan_type = _optional_string(auth_info.get("chatgpt_plan_type")) or "free"

    expires_in = token_response.get("expires_in")
    if isinstance(expires_in, bool):
        raise OAuthError("token response contains an invalid expires_in value")
    try:
        expires_in_seconds = int(expires_in)
    except (TypeError, ValueError) as exc:
        raise OAuthError("token response is missing a valid expires_in value") from exc
    if expires_in_seconds <= 0:
        raise OAuthError("token response contains a non-positive expires_in value")

    refreshed_at = now or datetime.now().astimezone()
    if refreshed_at.tzinfo is None:
        refreshed_at = refreshed_at.astimezone()
    expires_at = refreshed_at + timedelta(seconds=expires_in_seconds)

    return {
        "access_token": _required_string(token_response, "access_token"),
        "account_id": account_id,
        "disabled": False,
        "email": email,
        "expired": _rfc3339(expires_at),
        "id_token": id_token,
        "last_refresh": _rfc3339(refreshed_at),
        "plan_type": plan_type,
        "refresh_token": _required_string(token_response, "refresh_token"),
        "type": "codex",
    }


def _required_string(values: Mapping[str, Any], key: str) -> str:
    value = _optional_string(values.get(key))
    if not value:
        raise OAuthError(f"token response is missing {key}")
    return value


def _optional_string(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _rfc3339(value: datetime) -> str:
    return value.replace(microsecond=0).isoformat()


def serialize_credentials(credentials: Mapping[str, Any]) -> str:
    data = dict(credentials)
    data.setdefault("disabled", False)
    ordered_data = {key: data.pop(key) for key in CREDENTIAL_FIELD_ORDER if key in data}
    ordered_data.update(data)
    return json.dumps(ordered_data, ensure_ascii=True, separators=(",", ":"))


def build_import_payload(credentials: Mapping[str, Any]) -> dict[str, Any]:
    account_name = _optional_string(credentials.get("email"))
    if not account_name:
        raise OAuthError("cannot import account without an email from the ID token")
    return {
        "content": serialize_credentials(credentials),
        "name": account_name,
        "notes": None,
        "proxy_id": None,
        "concurrency": 10,
        "priority": 1,
        "rate_multiplier": 1,
        "group_ids": [2],
        "expires_at": None,
        "auto_pause_on_expired": True,
        "credential_extras": {"model_mapping": dict(MODEL_MAPPING)},
        "extra": {
            "openai_oauth_responses_websockets_v2_mode": "off",
            "openai_oauth_responses_websockets_v2_enabled": False,
        },
        "update_existing": True,
    }


def build_admin_login_url(api_url: str) -> str:
    parsed = urllib.parse.urlsplit(api_url.strip())
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise OAuthError("admin import API URL must be an absolute HTTP or HTTPS URL")
    return urllib.parse.urlunsplit(
        (parsed.scheme, parsed.netloc, "/api/v1/auth/login", "", "")
    )


def _admin_token_is_fresh() -> bool:
    return bool(ADMIN_TOKEN) and (
        ADMIN_TOKEN_EXPIRES_AT > time.time() + ADMIN_TOKEN_REFRESH_MARGIN_SECONDS
    )


def login_admin(api_url: str) -> str:
    global ADMIN_TOKEN, ADMIN_TOKEN_EXPIRES_AT

    login_url = build_admin_login_url(api_url)
    body = json.dumps(
        {"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    request = urllib.request.Request(
        login_url,
        data=body,
        headers={
            "Accept": "application/json, text/plain, */*",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    opener = urllib.request.build_opener()
    opener.addheaders = []
    try:
        with opener.open(request, timeout=TOKEN_REQUEST_TIMEOUT_SECONDS) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise OAuthError(f"admin login failed with HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise OAuthError(f"admin login request failed: {exc.reason}") from exc

    try:
        result = json.loads(raw)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise OAuthError("admin login returned invalid JSON") from exc
    if not isinstance(result, dict):
        raise OAuthError("admin login returned an unexpected JSON value")
    if result.get("code") not in (None, 0):
        message = _optional_string(result.get("message")) or "unknown error"
        raise OAuthError(f"admin login failed: {message}")

    data = result.get("data", result)
    if not isinstance(data, dict):
        raise OAuthError("admin login response is missing its data object")
    token = _optional_string(data.get("access_token"))
    if not token:
        raise OAuthError("admin login response is missing access_token")

    claims = parse_jwt_claims(token)
    expires_at = claims.get("exp")
    if isinstance(expires_at, bool) or not isinstance(expires_at, (int, float)):
        expires_in = data.get("expires_in")
        if isinstance(expires_in, bool) or not isinstance(expires_in, (int, float)):
            raise OAuthError("admin login token is missing a valid expiration time")
        expires_at = time.time() + float(expires_in)

    ADMIN_TOKEN = token
    ADMIN_TOKEN_EXPIRES_AT = float(expires_at)
    print("Admin API login succeeded. Preparing the account import request...")
    return ADMIN_TOKEN


def get_admin_token(api_url: str, force_refresh: bool = False) -> str:
    if not force_refresh and _admin_token_is_fresh():
        return ADMIN_TOKEN
    return login_admin(api_url)


def send_import_request(api_url: str, payload: Mapping[str, Any]) -> tuple[int, str]:
    api_url = api_url.strip()
    if not api_url:
        raise OAuthError("admin import API URL is required")

    body = json.dumps(dict(payload), ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    opener = urllib.request.build_opener()
    opener.addheaders = []
    admin_token = get_admin_token(api_url)

    for attempt in range(2):
        request = urllib.request.Request(
            api_url,
            data=body,
            headers={
                "Accept": "application/json, text/plain, */*",
                "Authorization": f"Bearer {admin_token}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with opener.open(request, timeout=TOKEN_REQUEST_TIMEOUT_SECONDS) as response:
                status = response.status
                response_body = response.read().decode("utf-8", errors="replace")
                return status, response_body
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            if exc.code == 401 and attempt == 0:
                admin_token = get_admin_token(api_url, force_refresh=True)
                continue
            raise OAuthError(f"account import failed with HTTP {exc.code}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise OAuthError(f"account import request failed: {exc.reason}") from exc

    raise OAuthError("account import failed after refreshing the admin token")


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Sign in to OpenAI Codex with credentials from a local file and import the account "
            "into the admin API."
        )
    )
    parser.add_argument(
        "--api-url",
        default=DEFAULT_IMPORT_URL,
        help=f"admin import endpoint (default: {DEFAULT_IMPORT_URL})",
    )
    parser.add_argument(
        "--credentials-file",
        type=Path,
        default=DEFAULT_LOGIN_FILE,
        help=f"login file in email----password----totp-secret format (default: {DEFAULT_LOGIN_FILE})",
    )
    browser_mode = parser.add_mutually_exclusive_group()
    browser_mode.add_argument(
        "--headed",
        dest="headed",
        action="store_true",
        help="show the Chromium window instead of using the default headless mode",
    )
    browser_mode.add_argument(
        "--headless",
        dest="headed",
        action="store_false",
        help="hide the Chromium window and enable deterministic compatibility (default)",
    )
    parser.set_defaults(headed=False)
    parser.add_argument(
        "--timeout",
        type=float,
        default=DEFAULT_TIMEOUT_SECONDS,
        help=f"seconds to wait for the callback (default: {DEFAULT_TIMEOUT_SECONDS:g})",
    )
    parser.add_argument(
        "--browser-timeout",
        type=float,
        default=DEFAULT_BROWSER_TIMEOUT_SECONDS,
        help=(
            "seconds to wait for each login-page step "
            f"(default: {DEFAULT_BROWSER_TIMEOUT_SECONDS:g})"
        ),
    )
    parser.add_argument(
        "--validate-only",
        action="store_true",
        help="validate the complete credentials file and exit without opening a browser",
    )
    parser.add_argument(
        "--authorization-url",
        help=(
            "complete one PI-Desktop-generated OpenAI authorization URL; PI-Desktop keeps "
            "the PKCE verifier and stores the resulting token"
        ),
    )
    parser.add_argument(
        "--account-index",
        type=int,
        help="1-based account number used with --authorization-url",
    )
    parser.add_argument(
        "--json-events",
        action="store_true",
        help="emit machine-readable completion events for PI-Desktop",
    )
    args = parser.parse_args(argv)
    if args.timeout <= 0:
        parser.error("--timeout must be greater than zero")
    if args.browser_timeout <= 0:
        parser.error("--browser-timeout must be greater than zero")
    external_values = (args.authorization_url is not None, args.account_index is not None)
    if any(external_values) and not all(external_values):
        parser.error("--authorization-url and --account-index must be used together")
    if args.account_index is not None and args.account_index <= 0:
        parser.error("--account-index must be greater than zero")
    if args.validate_only and any(external_values):
        parser.error("--validate-only cannot be combined with --authorization-url")
    return args


def emit_json_event(event: str, **payload: object) -> None:
    print(json.dumps({"event": event, **payload}, ensure_ascii=False), flush=True)


def run_pi_authorization(args: argparse.Namespace) -> None:
    accounts = read_login_credentials(args.credentials_file)
    index = args.account_index
    if index is None or index > len(accounts):
        raise OAuthError(
            f"--account-index must be between 1 and {len(accounts)} for this credentials file"
        )
    authorization_url = validate_external_authorization_url(args.authorization_url)
    automate_oauth_login(
        authorization_url=authorization_url,
        credentials=accounts[index - 1],
        server=None,
        expected_state=None,
        callback_timeout=args.timeout,
        browser_timeout=args.browser_timeout,
        headed=args.headed,
    )
    if args.json_events:
        emit_json_event("completed", index=index, total=len(accounts))
    else:
        print(f"PI-Desktop authorization completed for account {index}/{len(accounts)}.")


def process_account(
    args: argparse.Namespace,
    login_credentials: LoginCredentials,
) -> tuple[int, str]:
    pkce = generate_pkce_codes()
    state = generate_oauth_state()
    authorization_url = build_authorization_url(state, pkce)

    try:
        server = OAuthCallbackServer((CALLBACK_HOST, CALLBACK_PORT))
    except OSError as exc:
        raise OAuthError(
            f"cannot listen on {CALLBACK_HOST}:{CALLBACK_PORT}; stop the process using that port and retry"
        ) from exc

    server_thread = threading.Thread(target=server.serve_forever, name="codex-oauth-callback", daemon=True)
    server_thread.start()
    try:
        callback = automate_oauth_login(
            authorization_url=authorization_url,
            credentials=login_credentials,
            server=server,
            expected_state=state,
            callback_timeout=args.timeout,
            browser_timeout=args.browser_timeout,
            headed=args.headed,
        )
        if callback is None:
            raise OAuthError("local OAuth flow completed without a callback")
        token_response = exchange_code_for_tokens(callback.code, pkce.verifier)
        credentials = build_credentials(token_response)
        payload = build_import_payload(credentials)
        return send_import_request(args.api_url, payload)
    finally:
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=2)


def run(args: argparse.Namespace) -> tuple[int, int]:
    accounts = read_login_credentials(args.credentials_file)
    total = len(accounts)
    succeeded = 0
    failed = 0

    print(f"Found {total} account(s). Processing them in file order.")
    for index, account in enumerate(accounts, start=1):
        prefix = f"[{index}/{total}]"
        print(f"\n{prefix} Starting login for {account.email}...")
        try:
            status, response_body = process_account(args, account)
        except KeyboardInterrupt:
            raise
        except (OAuthError, OSError) as exc:
            failed += 1
            print(f"{prefix} Failed for {account.email}: {exc}", file=sys.stderr)
            continue

        succeeded += 1
        print(f"{prefix} Login and import succeeded for {account.email} (HTTP {status}).")
        if response_body.strip():
            print(response_body)

    print(f"\nFinished all {total} account(s): {succeeded} succeeded, {failed} failed.")
    return succeeded, failed


def main(argv: Sequence[str] | None = None) -> int:
    args: argparse.Namespace | None = None
    try:
        args = parse_args(argv)
        if args.validate_only:
            accounts = read_login_credentials(args.credentials_file)
            if args.json_events:
                emit_json_event("validated", count=len(accounts))
            else:
                print(f"Validated {len(accounts)} account(s).")
            return 0
        if args.authorization_url is not None:
            run_pi_authorization(args)
            return 0
        _, failed = run(args)
    except KeyboardInterrupt:
        print("\nAuthentication cancelled.", file=sys.stderr)
        if args is not None and args.json_events:
            emit_json_event("cancelled")
        return 130
    except (OAuthError, OSError) as exc:
        print(f"Authentication failed: {exc}", file=sys.stderr)
        if args is not None and args.json_events:
            emit_json_event("failed", message=str(exc))
        return 1

    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
