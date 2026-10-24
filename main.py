"""Serve the AetherFold browser app locally; never serve workspace secrets."""

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parent


def public_path(request_path):
    """Resolve only app assets and image fixtures, denying traversal/symlinks."""
    try:
        path = unquote(urlsplit(request_path).path, errors="strict")
    except (ValueError, UnicodeError):
        return None
    parts = path.strip("/").split("/")
    if any(p.startswith(".") or "\\" in p or "\x00" in p for p in parts):
        return None
    base = ROOT / ("images" if parts[0] == "images" else "web")
    relative = "/".join(parts[1:] if parts[0] == "images" else parts) or "index.html"
    target = (base / relative).resolve()
    if not target.is_relative_to(base.resolve()) or not target.is_file():
        return None
    allowed = {".png", ".jpg", ".jpeg", ".webp", ".avif", ".bmp"} if parts[0] == "images" else {".html", ".js", ".css", ".svg", ".ico"}
    if target.suffix.lower() not in allowed:
        return None
    return target


class AppHandler(SimpleHTTPRequestHandler):
    def send_head(self):
        self._asset_path = public_path(self.path)
        if self._asset_path is None:
            self.send_error(404, "Asset not found")
            return None
        return super().send_head()

    def translate_path(self, path):
        return str(self._asset_path)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        super().end_headers()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    handler = partial(AppHandler, directory=str(ROOT / "web"))
    try:
        with ThreadingHTTPServer(("127.0.0.1", args.port), handler) as server:
            print(f"AetherFold → http://127.0.0.1:{server.server_port}", flush=True)
            print("Press Ctrl+C to stop. Camera and sound start only when enabled.", flush=True)
            server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
