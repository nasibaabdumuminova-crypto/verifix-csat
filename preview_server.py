"""
Локальный preview-сервер на Python. Поддерживает трёхъязычный опросник v9
(RU / UZ-Cyr / UZ-Lat), старую 5-звёздочную форму и полный админ-API.
Seed вопросов читается из seed_questions.json. Данные в памяти.
"""
import copy
import csv
import io
import json
import os
import re
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

PORT = int(os.environ.get("PORT", 3000))
ADMIN_PASSWORD = os.environ.get("ADMIN_PASSWORD", "123")
BASE_DIR = os.path.dirname(__file__)
PUBLIC_DIR = os.path.join(BASE_DIR, "public")
SEED_PATH = os.path.join(BASE_DIR, "seed_questions.json")

LANGS = ["ru", "uz_cyr", "uz_lat"]
DEFAULT_LANG = "ru"

# ========== In-memory stores ==========
reviews = []
next_review_id = 1
questions = []
next_question_id = 1
responses = []
next_response_id = 1
answers = []
next_answer_id = 1


def tr(x, lang):
    if x is None:
        return ""
    if isinstance(x, str):
        return x
    return x.get(lang) or x.get(DEFAULT_LANG) or x.get("ru") or (list(x.values())[0] if x else "")


def load_seed():
    global questions, next_question_id
    if questions:
        return
    with open(SEED_PATH, encoding="utf-8") as f:
        seed = json.load(f)
    for q in seed:
        q2 = copy.deepcopy(q)
        q2["id"] = next_question_id
        q2["deleted_at"] = None
        q2["required"] = bool(q2.get("required"))
        q2.setdefault("show_if", None)
        q2.setdefault("config", None)
        q2.setdefault("help_text", None)
        q2.setdefault("step_help", None)
        next_question_id += 1
        questions.append(q2)


def get_visible_questions():
    return sorted(
        (q for q in questions if not q.get("deleted_at")),
        key=lambda q: (q["step_number"], q["position"], q["id"]),
    )


def get_all_questions():
    return sorted(questions, key=lambda q: (q["step_number"], q["position"], q["id"]))


def is_visible(question, answer_map):
    rule = question.get("show_if")
    if not rule:
        return True
    v = answer_map.get(rule.get("question_key"))
    if v is None:
        return False
    op = rule.get("op", "in")
    if op == "in":
        arr = rule.get("values", [])
        if isinstance(v, list):
            return any(x in arr for x in v)
        return v in arr
    if op == "eq":
        return v == rule.get("value")
    try:
        n = float(v)
    except (TypeError, ValueError):
        return False
    target = float(rule.get("value"))
    return {"lte": n <= target, "gte": n >= target,
            "lt": n < target, "gt": n > target}.get(op, False)


# ========== Stats ==========
def compute_stats():
    def vals(key):
        out = []
        for r in responses:
            for a in answers:
                if a["response_id"] == r["id"] and a["question_key"] == key:
                    out.append(a["value"])
                    break
        return out

    def num_vals(key):
        result = []
        for v in vals(key):
            try:
                result.append(float(v))
            except (TypeError, ValueError):
                pass
        return result

    def avg(arr):
        return round(sum(arr) / len(arr), 2) if arr else None

    nps_vals = num_vals("nps")
    prom = sum(1 for v in nps_vals if v >= 9)
    det = sum(1 for v in nps_vals if v <= 6)
    neu = len(nps_vals) - prom - det
    nps_score = round((prom - det) / len(nps_vals) * 100) if nps_vals else None

    def distribution(key):
        out = {}
        for v in vals(key):
            k = "—" if isinstance(v, list) else str(v)
            out[k] = out.get(k, 0) + 1
        return out

    lang_dist = {}
    for r in responses:
        l = r.get("language", "ru")
        lang_dist[l] = lang_dist.get(l, 0) + 1

    return {
        "totalResponses": len(responses),
        "nps": {"score": nps_score, "promoters": prom, "neutrals": neu,
                "detractors": det, "count": len(nps_vals)},
        "csatProduct": avg(num_vals("csat_product")),
        "scales": {
            "web_ux_score": avg(num_vals("web_ux_score")),
            "mobile_ux_score": avg(num_vals("mobile_ux_score")),
            "support_score": avg(num_vals("support_score")),
            "manager_score": avg(num_vals("manager_score")),
        },
        "distributions": {
            "roi_category": distribution("roi_category"),
            "renewal_intent": distribution("renewal_intent"),
            "industry": distribution("industry"),
            "company_size": distribution("company_size"),
            "mobile_usage": distribution("mobile_usage"),
            "callback_request": distribution("callback_request"),
        },
        "languageDistribution": lang_dist,
    }


# ========== HTTP handler ==========
PHONE_RE = re.compile(r"^[\+\-\d\s()]{5,}$")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[{self.command}] {self.path}")

    def _send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
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

    def _check_auth(self, url):
        qs = parse_qs(url.query)
        pwd = (qs.get("password") or [""])[0]
        if not pwd:
            pwd = self.headers.get("x-admin-password", "")
        return pwd == ADMIN_PASSWORD

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length).decode("utf-8") if length else ""
        try:
            return json.loads(raw or "{}")
        except json.JSONDecodeError:
            return None

    # =============== GET ===============
    def do_GET(self):
        url = urlparse(self.path)
        path = url.path

        static_map = {
            "/": ("index.html", "text/html; charset=utf-8"),
            "/index.html": ("index.html", "text/html; charset=utf-8"),
            "/admin": ("admin.html", "text/html; charset=utf-8"),
            "/survey": ("survey.html", "text/html; charset=utf-8"),
            "/admin/survey": ("admin-survey.html", "text/html; charset=utf-8"),
            "/style.css": ("style.css", "text/css; charset=utf-8"),
            "/logo.svg": ("logo.svg", "image/svg+xml; charset=utf-8"),
            "/logo.png": ("logo.png", "image/png"),
            "/stars.js": ("stars.js", "application/javascript; charset=utf-8"),
        }
        if path in static_map:
            fn, ct = static_map[path]
            return self._send_file(fn, ct)

        if path == "/healthz":
            self.send_response(200); self.end_headers(); self.wfile.write(b"ok"); return

        if path == "/api/admin/reviews":
            if not self._check_auth(url):
                return self._send_json(401, {"error": "Неверный пароль"})
            total = len(reviews)
            avg = round(sum(r["rating"] for r in reviews) / total, 2) if total else 0
            return self._send_json(200, {"avg": avg, "total": total, "reviews": reviews})

        if path == "/api/survey/questions":
            return self._send_json(200, {"questions": get_visible_questions(), "languages": LANGS})

        if path == "/api/admin/survey/stats":
            if not self._check_auth(url):
                return self._send_json(401, {"error": "Неверный пароль"})
            return self._send_json(200, compute_stats())

        if path == "/api/admin/survey/responses":
            if not self._check_auth(url):
                return self._send_json(401, {"error": "Неверный пароль"})
            resp_out = []
            for r in sorted(responses, key=lambda x: x["created_at"], reverse=True):
                rans = [
                    {"question_id": a["question_id"], "question_key": a["question_key"], "value": a["value"]}
                    for a in answers if a["response_id"] == r["id"]
                ]
                resp_out.append({**r, "answers": rans})
            return self._send_json(200, {"responses": resp_out, "questions": get_all_questions()})

        if path == "/api/admin/survey/questions":
            if not self._check_auth(url):
                return self._send_json(401, {"error": "Неверный пароль"})
            return self._send_json(200, {"questions": get_visible_questions()})

        if path == "/api/admin/survey/export.csv":
            if not self._check_auth(url):
                return self._send_json(401, {"error": "Неверный пароль"})
            return self._send_csv()

        self.send_error(404)

    # =============== POST ===============
    def do_POST(self):
        url = urlparse(self.path)
        path = url.path

        if path == "/api/reviews":
            data = self._read_body()
            if data is None:
                return self._send_json(400, {"error": "Bad JSON"})
            try:
                rating = int(data.get("rating"))
            except (TypeError, ValueError):
                return self._send_json(400, {"error": "Оценка должна быть от 1 до 5"})
            if rating < 1 or rating > 5:
                return self._send_json(400, {"error": "Оценка должна быть от 1 до 5"})
            comment = (data.get("comment") or "").strip()[:2000] or None
            global next_review_id
            reviews.insert(0, {
                "id": next_review_id, "rating": rating, "comment": comment,
                "created_at": datetime.now().isoformat(),
            })
            next_review_id += 1
            return self._send_json(200, {"ok": True})

        if path == "/api/survey/responses":
            data = self._read_body()
            if data is None:
                return self._send_json(400, {"error": "Bad JSON"})
            company = (data.get("company_name") or "").strip()
            contact = (data.get("contact_name") or "").strip()
            position = (data.get("position") or "").strip()
            phone = (data.get("phone") or "").strip()
            lang = data.get("language") or DEFAULT_LANG
            if lang not in LANGS:
                lang = DEFAULT_LANG
            answers_in = data.get("answers") or []
            if not company:
                return self._send_json(400, {"error": "Укажите название компании"})
            if not contact:
                return self._send_json(400, {"error": "Укажите ФИО"})
            if not PHONE_RE.match(phone):
                return self._send_json(400, {"error": "Укажите корректный номер телефона"})
            if not isinstance(answers_in, list):
                return self._send_json(400, {"error": "Некорректный формат ответов"})

            answer_map = {a.get("question_key"): a.get("value") for a in answers_in if isinstance(a, dict)}
            # Merge identity fields so validation for questions with matching keys passes
            if company: answer_map["company_name"] = company
            if contact: answer_map["contact_name"] = contact
            if position: answer_map["position"] = position
            if phone: answer_map["phone"] = phone

            IDENTITY = {"company_name", "contact_name", "position", "phone"}
            for q in get_visible_questions():
                if not q.get("required"):
                    continue
                if q["key"] in IDENTITY:
                    continue
                if not is_visible(q, answer_map):
                    continue
                v = answer_map.get(q["key"])
                empty = v is None or v == "" or (isinstance(v, list) and not v)
                if empty:
                    return self._send_json(400, {"error": f"Ответьте на обязательный вопрос: «{tr(q['title'], lang)}»"})

            global next_response_id, next_answer_id
            resp = {
                "id": next_response_id,
                "company_name": company[:200],
                "contact_name": contact[:200] if contact else None,
                "position": position[:200] if position else None,
                "phone": phone[:50] if phone else None,
                "language": lang,
                "created_at": datetime.now().isoformat(),
            }
            next_response_id += 1
            responses.append(resp)

            by_key = {q["key"]: q for q in questions}
            for a in answers_in:
                if not isinstance(a, dict): continue
                k = a.get("question_key")
                if not k or k not in by_key: continue
                answers.append({
                    "id": next_answer_id, "response_id": resp["id"],
                    "question_id": by_key[k]["id"], "question_key": k,
                    "value": a.get("value"), "created_at": resp["created_at"],
                })
                next_answer_id += 1
            return self._send_json(200, {"ok": True, "id": resp["id"]})

        if path == "/api/admin/survey/questions":
            if not self._check_auth(url):
                return self._send_json(401, {"error": "Неверный пароль"})
            body = self._read_body() or {}
            if not body.get("key") or not body.get("title") or not body.get("type") \
               or not body.get("step_number") or not body.get("step_title"):
                return self._send_json(400, {"error": "Заполните ключ, заголовок, тип, номер и название шага"})
            global next_question_id
            row = {
                "id": next_question_id,
                "key": body["key"].strip(),
                "step_number": int(body["step_number"]),
                "step_title": body["step_title"],
                "step_help": body.get("step_help"),
                "position": int(body.get("position") or 99),
                "title": body["title"],
                "help_text": body.get("help_text"),
                "type": body["type"],
                "required": bool(body.get("required")),
                "config": body.get("config"),
                "show_if": body.get("show_if"),
                "deleted_at": None,
            }
            next_question_id += 1
            questions.append(row)
            return self._send_json(200, {"ok": True, "question": row})

        self.send_error(404)

    # =============== PUT ===============
    def do_PUT(self):
        url = urlparse(self.path)
        m = re.match(r"^/api/admin/survey/questions/(\d+)$", url.path)
        if not m:
            return self.send_error(404)
        if not self._check_auth(url):
            return self._send_json(401, {"error": "Неверный пароль"})
        qid = int(m.group(1))
        body = self._read_body() or {}
        q = next((x for x in questions if x["id"] == qid), None)
        if not q:
            return self._send_json(404, {"error": "Вопрос не найден"})
        for k in ("key", "step_title", "title", "type"):
            if body.get(k) is not None:
                q[k] = body[k]
        for k in ("step_help", "help_text", "config", "show_if"):
            if k in body:
                q[k] = body[k]
        if body.get("step_number") is not None:
            q["step_number"] = int(body["step_number"])
        if body.get("position") is not None:
            q["position"] = int(body["position"])
        if "required" in body:
            q["required"] = bool(body["required"])
        return self._send_json(200, {"ok": True, "question": q})

    # =============== DELETE ===============
    def do_DELETE(self):
        url = urlparse(self.path)
        m = re.match(r"^/api/admin/survey/questions/(\d+)$", url.path)
        if not m:
            return self.send_error(404)
        if not self._check_auth(url):
            return self._send_json(401, {"error": "Неверный пароль"})
        qid = int(m.group(1))
        q = next((x for x in questions if x["id"] == qid), None)
        if q:
            q["deleted_at"] = datetime.now().isoformat()
        return self._send_json(200, {"ok": True})

    # =============== CSV ===============
    def _send_csv(self):
        qs = get_all_questions()
        cols = ["id", "created_at", "language", "company_name", "contact_name", "position", "phone"] \
               + [q["key"] for q in qs]
        buf = io.StringIO()
        buf.write("\ufeff")
        writer = csv.writer(buf)
        writer.writerow(cols)
        for r in sorted(responses, key=lambda x: x["created_at"], reverse=True):
            by_key = {}
            for a in answers:
                if a["response_id"] == r["id"]:
                    by_key[a["question_key"]] = a["value"]
            row = [r["id"], r["created_at"], r.get("language", "ru"),
                   r["company_name"], r.get("contact_name") or "",
                   r.get("position") or "", r.get("phone") or ""]
            for q in qs:
                v = by_key.get(q["key"])
                if isinstance(v, list):
                    v = " | ".join(str(x) for x in v)
                elif v is None:
                    v = ""
                row.append(v)
            writer.writerow(row)
        body = buf.getvalue().encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/csv; charset=utf-8")
        self.send_header("Content-Disposition", 'attachment; filename="verifix_survey.csv"')
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    load_seed()
    print(f"Verifix preview on http://localhost:{PORT}")
    print(f"  /         — короткая форма (5 звёзд)")
    print(f"  /survey   — трёхъязычный опросник")
    print(f"  /admin        — NPS Radar (пароль: {ADMIN_PASSWORD})")
    print(f"  /admin/survey — дашборд опросника")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
