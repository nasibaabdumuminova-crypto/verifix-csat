"""
Локальный preview-сервер на Python (для быстрого просмотра UI без Node.js).
Хранит отзывы в памяти. Для продакшена используется server.js + PostgreSQL.
"""
import json
import os
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

PORT = int(os.environ.get("PORT", 3000))
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "123")
PUBLIC_DIR = os.path.join(os.path.dirname(__file__), "public")

reviews = []
next_id = 1


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[{self.command}] {self.path}")

    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, filename, content_type):
        path = os.path.join(PUBLIC_DIR, filename)
        if not os.path.isfile(path):
            self.send_error(404)
            return
        with open(path, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        url = urlparse(self.path)
        path = url.path

        if path == "/" or path == "/index.html":
            return self._send_file("index.html", "text/html; charset=utf-8")
        if path == "/admin":
            return self._send_file("admin.html", "text/html; charset=utf-8")
        if path == "/style.css":
            return self._send_file("style.css", "text/css; charset=utf-8")
        if path == "/logo.svg":
            return self._send_file("logo.svg", "image/svg+xml; charset=utf-8")
        if path == "/logo.png":
            return self._send_file("logo.png", "image/png")
        if path == "/stars.js":
            return self._send_file("stars.js", "application/javascript; charset=utf-8")
        if path == "/healthz":
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"ok")
            return

        if path == "/api/admin/reviews":
            qs = parse_qs(url.query)
            pwd = (qs.get("password") or [""])[0]
            if pwd != ADMIN_PASSWORD:
                return self._send_json(401, {"error": "Неверный пароль"})
            total = len(reviews)
            avg = round(sum(r["rating"] for r in reviews) / total, 2) if total else 0
            return self._send_json(200, {"avg": avg, "total": total, "reviews": reviews})

        self.send_error(404)

    def do_POST(self):
        url = urlparse(self.path)
        if url.path != "/api/reviews":
            return self.send_error(404)
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length).decode("utf-8") if length else ""
        try:
            data = json.loads(raw or "{}")
        except json.JSONDecodeError:
            return self._send_json(400, {"error": "Bad JSON"})
        try:
            rating = int(data.get("rating"))
        except (TypeError, ValueError):
            return self._send_json(400, {"error": "Оценка должна быть от 1 до 5"})
        if rating < 1 or rating > 5:
            return self._send_json(400, {"error": "Оценка должна быть от 1 до 5"})
        comment = (data.get("comment") or "").strip()[:2000] or None

        global next_id
        reviews.insert(0, {
            "id": next_id,
            "rating": rating,
            "comment": comment,
            "created_at": datetime.now().isoformat(),
        })
        next_id += 1
        return self._send_json(200, {"ok": True})


if __name__ == "__main__":
    print(f"CSAT Radar (preview) on http://localhost:{PORT}")
    print(f"Admin: http://localhost:{PORT}/admin (password: {ADMIN_PASSWORD})")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
