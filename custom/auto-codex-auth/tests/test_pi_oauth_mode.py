from __future__ import annotations

import argparse
import contextlib
import io
import json
import tempfile
import unittest
import urllib.parse
from pathlib import Path
from unittest import mock

import codex_oauth as app


def authorization_url(**overrides: str) -> str:
    params = {
        "response_type": "code",
        "client_id": app.CLIENT_ID,
        "redirect_uri": app.REDIRECT_URI,
        "state": "state-value",
        "code_challenge": "challenge-value",
        "code_challenge_method": "S256",
    }
    params.update(overrides)
    return f"{app.AUTH_URL}?{urllib.parse.urlencode(params)}"


class ExternalAuthorizationUrlTests(unittest.TestCase):
    def test_accepts_pi_desktop_openai_url(self) -> None:
        url = authorization_url()
        self.assertEqual(app.validate_external_authorization_url(url), url)

    def test_rejects_untrusted_or_incomplete_urls(self) -> None:
        cases = [
            authorization_url().replace("auth.openai.com", "evil.example"),
            authorization_url(redirect_uri="http://127.0.0.1:9999/callback"),
            authorization_url(state=""),
            authorization_url(code_challenge_method="plain"),
            authorization_url().replace("https://", "http://", 1),
        ]
        for url in cases:
            with self.subTest(url=url), self.assertRaises(app.OAuthError):
                app.validate_external_authorization_url(url)

    def test_external_wait_stops_at_local_callback(self) -> None:
        class Page:
            url = "https://auth.openai.com/oauth/authorize"

            def wait_for_timeout(self, _milliseconds: int) -> None:
                self.url = f"http://localhost:{app.CALLBACK_PORT}{app.CALLBACK_PATH}?code=hidden"

        page = Page()
        with (
            mock.patch.object(app, "_raise_for_blocked_login"),
            mock.patch.object(app, "_click_authorization_button", return_value=False),
        ):
            app._wait_for_external_callback(page, 1)


class CredentialFileCompatibilityTests(unittest.TestCase):
    def test_accepts_optional_source_url_and_trailing_metadata(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "accounts.txt"
            path.write_text(
                "one@example.com----password----JBSWY3DPEHPK3PXP----https://example.com/source?id=1\n"
                "two@example.com----password----JBSWY3DPEHPK3PXP----http://example.com/source\n"
                "order-id----ok----3----metadata\n",
                encoding="utf-8",
            )
            accounts = app.read_login_credentials(path)
        self.assertEqual([account.email for account in accounts], ["one@example.com", "two@example.com"])

    def test_rejects_non_account_line_between_accounts(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "accounts.txt"
            path.write_text(
                "one@example.com----password----JBSWY3DPEHPK3PXP\n"
                "metadata----not----an-account\n"
                "two@example.com----password----JBSWY3DPEHPK3PXP\n",
                encoding="utf-8",
            )
            with self.assertRaises(app.OAuthError):
                app.read_login_credentials(path)

    def test_rejects_invalid_optional_source_url(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "accounts.txt"
            path.write_text(
                "one@example.com----password----JBSWY3DPEHPK3PXP----not-a-url\n",
                encoding="utf-8",
            )
            with self.assertRaises(app.OAuthError):
                app.read_login_credentials(path)


class PiModeCliTests(unittest.TestCase):
    def test_external_arguments_must_be_paired(self) -> None:
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            app.parse_args(["--authorization-url", authorization_url()])
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            app.parse_args(["--account-index", "1"])

    def test_validate_only_emits_count_without_opening_browser(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            credentials = Path(directory) / "accounts.txt"
            credentials.write_text(
                "user@example.com----password----JBSWY3DPEHPK3PXP\n",
                encoding="utf-8",
            )
            output = io.StringIO()
            with (
                contextlib.redirect_stdout(output),
                mock.patch.object(app, "automate_oauth_login") as automate,
            ):
                code = app.main(
                    [
                        "--credentials-file",
                        str(credentials),
                        "--validate-only",
                        "--json-events",
                    ]
                )
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(output.getvalue()), {"event": "validated", "count": 1})
            automate.assert_not_called()

    def test_pi_authorization_selects_one_account_and_leaves_tokens_to_host(self) -> None:
        accounts = [
            app.LoginCredentials("one@example.com", "pw1", "JBSWY3DPEHPK3PXP"),
            app.LoginCredentials("two@example.com", "pw2", "JBSWY3DPEHPK3PXP"),
        ]
        args = argparse.Namespace(
            credentials_file=Path("accounts.txt"),
            account_index=2,
            authorization_url=authorization_url(),
            timeout=300.0,
            browser_timeout=60.0,
            headed=False,
            json_events=True,
        )
        output = io.StringIO()
        with (
            contextlib.redirect_stdout(output),
            mock.patch.object(app, "read_login_credentials", return_value=accounts),
            mock.patch.object(app, "automate_oauth_login") as automate,
            mock.patch.object(app, "exchange_code_for_tokens") as exchange,
            mock.patch.object(app, "send_import_request") as import_request,
        ):
            app.run_pi_authorization(args)
        automate.assert_called_once()
        call = automate.call_args.kwargs
        self.assertEqual(call["credentials"], accounts[1])
        self.assertIsNone(call["server"])
        self.assertIsNone(call["expected_state"])
        exchange.assert_not_called()
        import_request.assert_not_called()
        self.assertEqual(
            json.loads(output.getvalue()),
            {"event": "completed", "index": 2, "total": 2},
        )

    def test_pi_authorization_rejects_out_of_range_index(self) -> None:
        args = argparse.Namespace(
            credentials_file=Path("accounts.txt"),
            account_index=2,
            authorization_url=authorization_url(),
            timeout=300.0,
            browser_timeout=60.0,
            headed=False,
            json_events=False,
        )
        with (
            mock.patch.object(
                app,
                "read_login_credentials",
                return_value=[app.LoginCredentials("one@example.com", "pw", "JBSWY3DPEHPK3PXP")],
            ),
            self.assertRaises(app.OAuthError),
        ):
            app.run_pi_authorization(args)


if __name__ == "__main__":
    unittest.main()
