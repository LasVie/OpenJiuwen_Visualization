from __future__ import annotations

import http.client
import tempfile
import threading
import unittest
from pathlib import Path

from openjiuwen_visualization_server.app import create_http_server
from openjiuwen_visualization_server.config import LocalServiceConfig
from openjiuwen_visualization_server.static_web import StaticWebError, StaticWebRoot


class StaticWebRootTests(unittest.TestCase):
    def test_serves_assets_and_spa_routes_with_bounded_cache_policy(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "assets").mkdir()
            (root / "index.html").write_text("<main>Companion</main>", encoding="utf-8")
            (root / "assets" / "app.js").write_text("export {};", encoding="utf-8")
            static = StaticWebRoot(root)

            index = static.read("/")
            route = static.read("/connections")
            script = static.read("/assets/app.js")

            self.assertEqual(index.body, b"<main>Companion</main>")
            self.assertEqual(route.body, index.body)
            self.assertEqual(index.cache_control, "no-store")
            self.assertIn("text/html", index.content_type)
            self.assertEqual(script.body, b"export {};")
            self.assertIn("immutable", script.cache_control)
            self.assertIn("javascript", script.content_type)

    def test_rejects_traversal_missing_assets_and_invalid_roots(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "web"
            root.mkdir()
            (root / "index.html").write_text("safe", encoding="utf-8")
            static = StaticWebRoot(root)

            self.assertIsNone(static.read("/%2e%2e/outside.txt"))
            self.assertIsNone(static.read("/..\\outside.txt"))
            self.assertIsNone(static.read("/assets/missing.js"))
            with self.assertRaises(StaticWebError):
                StaticWebRoot(root / "missing")


class StaticWebHttpTests(unittest.TestCase):
    def test_static_and_api_routes_share_one_loopback_server(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            workspace = Path(temporary)
            static_root = workspace / "dist"
            static_root.mkdir()
            (static_root / "index.html").write_text(
                "<!doctype html><title>Companion</title>", encoding="utf-8"
            )
            config = LocalServiceConfig.create(allowed_roots=[workspace])
            server = create_http_server(config, port=0, static_root=static_root)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            connection = http.client.HTTPConnection(
                "127.0.0.1", server.server_address[1], timeout=3
            )
            try:
                connection.request("GET", "/")
                landing = connection.getresponse()
                landing_body = landing.read().decode("utf-8")

                connection.request("HEAD", "/connections")
                head = connection.getresponse()
                head.read()

                connection.request("GET", "/api/v1/health")
                health = connection.getresponse()
                health_body = health.read().decode("utf-8")

                self.assertEqual(landing.status, 200)
                self.assertIn("Companion", landing_body)
                self.assertEqual(landing.getheader("X-OpenJiuwen-Companion"), "1")
                self.assertIn("frame-ancestors 'none'", landing.getheader("Content-Security-Policy"))
                self.assertEqual(head.status, 200)
                self.assertEqual(head.getheader("Content-Length"), str(len(landing_body.encode())))
                self.assertEqual(health.status, 200)
                self.assertIn('"status":"ok"', health_body)
                self.assertIn("application/json", health.getheader("Content-Type"))
            finally:
                connection.close()
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
