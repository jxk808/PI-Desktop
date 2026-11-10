from pathlib import Path
import unittest
from unittest import mock

import codex_oauth as app


class MacRuntimeTests(unittest.TestCase):
    def test_apple_silicon_uses_bundled_node(self):
        with mock.patch.object(app.sys, "platform", "darwin"), mock.patch.object(app.platform, "machine", return_value="arm64"):
            self.assertEqual(
                app.select_project_node_executable(),
                app.PROJECT_NODE_RUNTIME_PATH / f"node-{app.PROJECT_NODE_VERSION}-darwin-arm64" / "bin" / "node",
            )

    def test_unknown_cpu_fails_without_system_node_fallback(self):
        with mock.patch.object(app.sys, "platform", "darwin"), mock.patch.object(app.platform, "machine", return_value="unknown"):
            with self.assertRaises(app.OAuthError):
                app.select_project_node_executable()


if __name__ == "__main__":
    unittest.main()
