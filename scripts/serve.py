#!/usr/bin/env python3
"""Tiny static file server that disables HTTP caching.

Python's stdlib http.server does not set Cache-Control headers, so browsers
cache JS modules aggressively during local development and you end up
debugging stale code. Serve the workspace through this script instead:

    python3 scripts/serve.py            # listens on :8000
    python3 scripts/serve.py 9000       # listens on :9000

Then open http://localhost:8000.
"""
from __future__ import annotations

import http.server
import os
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), fmt % args))


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    os.chdir(ROOT)
    httpd = http.server.ThreadingHTTPServer(("0.0.0.0", port), NoCacheHandler)
    print(f"Serving {ROOT} (no-cache) at http://localhost:{port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
