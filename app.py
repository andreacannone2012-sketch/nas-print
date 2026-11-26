"""Web-app Flask per stampare su una stampante di rete (Brother MFC-L2710DN) via CUPS/IPP."""
import json
import logging
import os
import re
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path
from urllib.parse import urlparse

from flask import Flask, jsonify, render_template, request, send_file
from PIL import Image, ImageOps

try:  # foto iPhone (HEIC/HEIF): opzionale, se la libreria manca l'app funziona lo stesso
    from pillow_heif import register_heif_opener
    register_heif_opener()
    HEIF_OK = True
except Exception:  # pragma: no cover
    HEIF_OK = False

# ----------------------------------------------------------------------------
# Configurazione (variabili d'ambiente)
# ----------------------------------------------------------------------------
PRINTER_NAME = os.getenv("PRINTER_NAME", "Brother_MFC_L2710DN")
PRINTER_URI = os.getenv("PRINTER_URI", "ipp://192.168.1.141/ipp/print")
PRINTER_MODEL = os.getenv("PRINTER_MODEL", "everywhere")
MAX_UPLOAD_MB = int(os.getenv("MAX_UPLOAD_MB", "50"))
CONVERT_TIMEOUT = int(os.getenv("CONVERT_TIMEOUT", "180"))
WORK_ROOT = Path(os.getenv("WORK_ROOT", "/tmp/printjobs"))
LO_PROFILE = Path("/tmp/lo_profile")
PREVIEW_ROOT = WORK_ROOT / "previews"
PREVIEW_TTL = int(os.getenv("PREVIEW_TTL", "1800"))            # secondi di vita di un'anteprima
PREVIEW_MAX_MB = int(os.getenv("PREVIEW_MAX_MB", "600"))       # spazio massimo per le anteprime

_parsed = urlparse(PRINTER_URI)
PRINTER_HOST = _parsed.hostname or "192.168.1.141"
PRINTER_PORT = _parsed.port or 631

PDF_EXT = {"pdf"}
IMAGE_EXT = {"png", "jpg", "jpeg", "gif", "bmp", "webp", "tif", "tiff"}
if HEIF_OK:
    IMAGE_EXT |= {"heic", "heif"}
OFFICE_EXT = {"doc", "docx", "odt", "rtf", "ppt", "pptx", "odp", "txt", "xls", "xlsx", "ods"}
ALLOWED_EXT = PDF_EXT | IMAGE_EXT | OFFICE_EXT

SIDES = {"one-sided", "two-sided-long-edge", "two-sided-short-edge"}
ORIENTATIONS = {"auto": None, "portrait": "3", "landscape": "4"}
RANGE_RE = re.compile(r"^\d+(-\d+)?(,\d+(-\d+)?)*$")
JOB_ID_RE = re.compile(r"^[A-Za-z0-9_.\-]+-\d+$")
TOKEN_RE = re.compile(r"^[0-9a-f]{32}$")
THUMB_WIDTH = {"s": 360, "l": 1100}   # s = miniatura, l = ingrandimento

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("nas-print")

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024 * 5  # totale richiesta (piu' file)

_lo_lock = threading.Lock()        # LibreOffice: una conversione alla volta
_printer_lock = threading.Lock()   # configurazione coda CUPS
_render_sem = threading.Semaphore(3)  # al massimo 3 rendering di pagina in parallelo
_job_titles = {}                   # id job CUPS -> nome file (per mostrarlo nella coda)
_titles_lock = threading.Lock()


class AppError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.message = message
        self.status = status

    def __str__(self):
        return self.message


def remember_title(job_id, title):
    with _titles_lock:
        _job_titles[job_id] = title[:120]
        while len(_job_titles) > 200:
            _job_titles.pop(next(iter(_job_titles)))


# ----------------------------------------------------------------------------
# Utilita' CUPS
# ----------------------------------------------------------------------------
def run(cmd, timeout=30, env=None):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)
    except subprocess.TimeoutExpired:
        raise AppError(f"Timeout durante l'esecuzione di '{cmd[0]}'.", 504)
    except FileNotFoundError:
        raise AppError(f"Comando non trovato: {cmd[0]}", 500)


def cups_up():
    r = run(["lpstat", "-r"], 10)
    return r.returncode == 0 and "is running" in r.stdout


def printer_exists():
    return run(["lpstat", "-p", PRINTER_NAME], 10).returncode == 0


def tcp_reachable():
    try:
        with socket.create_connection((PRINTER_HOST, PRINTER_PORT), timeout=2):
            return True
    except OSError:
        return False


def ensure_printer():
    """Crea (se manca) la coda CUPS verso la stampante IPP e la abilita."""
    with _printer_lock:
        if not cups_up():
            raise AppError("Il servizio CUPS non e' attivo nel container.", 503)
        if printer_exists():
            return
        log.info("Creo la coda %s -> %s (driver: %s)", PRINTER_NAME, PRINTER_URI, PRINTER_MODEL)
        r = run(
            [
                "lpadmin", "-p", PRINTER_NAME, "-E",
                "-v", PRINTER_URI, "-m", PRINTER_MODEL,
                "-D", "Brother MFC-L2710DN", "-L", "Rete locale",
                "-o", "printer-is-shared=false",
                "-o", "printer-error-policy=retry-job",
            ],
            90,
        )
        if r.returncode != 0:
            detail = (r.stderr or r.stdout).strip()
            hint = "" if tcp_reachable() else f" La stampante {PRINTER_HOST}:{PRINTER_PORT} non risponde in rete."
            raise AppError(f"Impossibile configurare la stampante: {detail}.{hint}", 503)
        run(["lpadmin", "-d", PRINTER_NAME], 10)
        log.info("Coda %s creata.", PRINTER_NAME)


_toner_cache = (0.0, None)


def toner_level():
    """Livello toner in % se la stampante lo espone via IPP (cache 60 s)."""
    global _toner_cache
    ts, val = _toner_cache
    if time.time() - ts < 60:
        return val
    val = None
    try:
        r = run(["ipptool", "-tv", PRINTER_URI, "get-printer-attributes.test"], 8)
        lv = re.search(r"marker-levels \([^)]*\) = ([\d,\s-]+)", r.stdout)
        nm = re.search(r"marker-names \([^)]*\) = (.+)", r.stdout)
        if lv:
            levels = [int(x) for x in lv.group(1).replace(" ", "").split(",") if x.lstrip("-").isdigit()]
            names = [n.strip().lower() for n in nm.group(1).split(",")] if nm else []
            idx = next((i for i, n in enumerate(names) if "toner" in n or "black" in n), 0)
            i = idx if idx < len(levels) else 0
            if levels and 0 <= levels[i] <= 100:
                val = levels[i]
    except (AppError, ValueError):
        pass
    _toner_cache = (time.time(), val)
    return val


def printer_status():
    reachable = tcp_reachable()
    info = {"name": PRINTER_NAME, "uri": PRINTER_URI, "reachable": reachable, "alerts": None, "toner": None}
    try:
        if not cups_up():
            info.update(state="cups-down", label="Servizio CUPS non attivo")
            return info
        r = run(["lpstat", "-l", "-p", PRINTER_NAME], 10)
    except AppError as e:
        info.update(state="cups-down", label=e.message)
        return info

    if r.returncode != 0:
        label = "Stampante non configurata" + ("" if reachable else " e non raggiungibile")
        info.update(state="unconfigured", label=label)
        return info

    text = r.stdout
    first = text.splitlines()[0] if text else ""
    m = re.search(r"Alerts:\s*(.+)", text)
    alerts = m.group(1).strip() if m else None
    if alerts in (None, "", "none"):
        alerts = None

    if "disabled" in first:
        state, label = "disabled", "Ferma o in pausa"
    elif "now printing" in first:
        state, label = "printing", "In stampa"
    else:
        state, label = "idle", "Pronta"
    if not reachable:
        state, label = "offline", "Non raggiungibile in rete"
    info.update(state=state, label=label, alerts=alerts, toner=toner_level() if reachable else None)
    return info


def list_jobs():
    try:
        r = run(["lpstat", "-W", "not-completed", "-o", PRINTER_NAME], 10)
    except AppError:
        return []
    jobs = []
    for line in r.stdout.splitlines():
        m = re.match(r"^(\S+-\d+)\s+(\S+)\s+(\d+)\s+(.*)$", line.strip())
        if m:
            with _titles_lock:
                title = _job_titles.get(m.group(1))
            jobs.append({"id": m.group(1), "user": m.group(2), "size": int(m.group(3)), "when": m.group(4), "title": title})
    return jobs


# ----------------------------------------------------------------------------
# Conversione
# ----------------------------------------------------------------------------
def convert_with_libreoffice(src: Path, outdir: Path) -> Path:
    cmd = [
        "soffice", f"-env:UserInstallation=file://{LO_PROFILE}",
        "--headless", "--norestore", "--nolockcheck", "--nodefault", "--nofirststartwizard",
        "--convert-to", "pdf", "--outdir", str(outdir), str(src),
    ]
    env = {**os.environ, "HOME": "/tmp"}
    with _lo_lock:
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=CONVERT_TIMEOUT, env=env)
        except subprocess.TimeoutExpired:
            subprocess.run(["pkill", "-f", "soffice"], check=False)
            raise AppError(f"Conversione in PDF scaduta dopo {CONVERT_TIMEOUT} secondi.", 504)
        except FileNotFoundError:
            raise AppError("LibreOffice non e' installato nel container.", 500)
    pdf = outdir / (src.stem + ".pdf")
    if r.returncode != 0 or not pdf.exists() or pdf.stat().st_size == 0:
        detail = (r.stderr or r.stdout or "").strip()[-300:]
        raise AppError("Conversione in PDF non riuscita: il file potrebbe essere danneggiato o protetto." +
                       (f" Dettaglio: {detail}" if detail else ""), 422)
    return pdf


def image_to_pdf(src: Path, dst: Path):
    """Immagine -> PDF A4 (300 dpi), centrata e adattata alla pagina."""
    try:
        with Image.open(src) as im:
            im = ImageOps.exif_transpose(im)
            if im.mode in ("RGBA", "LA") or (im.mode == "P" and "transparency" in im.info):
                im = im.convert("RGBA")
                bg = Image.new("RGB", im.size, "white")
                bg.paste(im, mask=im.split()[-1])
                im = bg
            else:
                im = im.convert("RGB")
            page_w, page_h = 2480, 3508
            if im.width > im.height:
                page_w, page_h = page_h, page_w
            margin = int(0.04 * min(page_w, page_h))
            fitted = ImageOps.contain(im, (page_w - 2 * margin, page_h - 2 * margin), Image.LANCZOS)
            canvas = Image.new("RGB", (page_w, page_h), "white")
            canvas.paste(fitted, ((page_w - fitted.width) // 2, (page_h - fitted.height) // 2))
            canvas.save(dst, "PDF", resolution=300.0)
    except AppError:
        raise
    except Exception as e:
        raise AppError(f"Immagine non valida o non leggibile ({e.__class__.__name__}).", 422)


def pdf_info(path: Path):
    """Ritorna (numero pagine, [[larghezza, altezza] in punti, una per pagina])."""
    r = run(["pdfinfo", str(path)], 30)
    if r.returncode != 0:
        raise AppError("PDF non valido, danneggiato o protetto da password.", 422)
    m = re.search(r"^Pages:\s+(\d+)", r.stdout, re.M)
    pages = int(m.group(1)) if m else 0
    sizes = []
    if pages:
        r = run(["pdfinfo", "-f", "1", "-l", str(pages), str(path)], 60)
        dims = {int(n): (float(w), float(h)) for n, w, h in re.findall(r"^Page\s+(\d+)\s+size:\s+([\d.]+)\s+x\s+([\d.]+)", r.stdout, re.M)}
        rots = {int(n): int(v) for n, v in re.findall(r"^Page\s+(\d+)\s+rot:\s+(\d+)", r.stdout, re.M)}
        for i in range(1, pages + 1):
            w, h = dims.get(i, (595.0, 842.0))
            if rots.get(i, 0) in (90, 270):
                w, h = h, w
            sizes.append([round(w, 1), round(h, 1)])
    return pages, sizes


def normalize_ranges(raw, total_pages):
    if not raw:
        return None
    value = re.sub(r"\s+", "", raw)
    if not RANGE_RE.match(value):
        raise AppError("Intervallo pagine non valido. Esempio corretto: 1-3, 5")
    for part in value.split(","):
        a, _, b = part.partition("-")
        start = int(a)
        end = int(b) if b else start
        if start < 1 or end < start:
            raise AppError(f"Intervallo pagine non valido: '{part}'.")
        if total_pages and end > total_pages:
            raise AppError(f"L'intervallo richiede la pagina {end}, ma il documento ha {total_pages} pagine.")
    return value


# ----------------------------------------------------------------------------
# Stampa
# ----------------------------------------------------------------------------
def count_selected(ranges, total):
    if not ranges:
        return total
    pages = set()
    for part in ranges.split(","):
        a, _, b = part.partition("-")
        pages.update(range(int(a), int(b or a) + 1))
    return len(pages)


def parse_options(form):
    try:
        copies = int(form.get("copies", "1"))
    except ValueError:
        raise AppError("Numero di copie non valido.")
    if not 1 <= copies <= 99:
        raise AppError("Il numero di copie deve essere tra 1 e 99.")
    sides = form.get("sides", "one-sided")
    if sides not in SIDES:
        raise AppError("Opzione fronte/retro non valida.")
    orientation = form.get("orientation", "auto")
    if orientation not in ORIENTATIONS:
        raise AppError("Orientamento non valido.")
    number_up = form.get("number_up", "1")
    if number_up not in ("1", "2", "4"):
        raise AppError("Valore 'pagine per foglio' non valido.")
    return {
        "copies": copies,
        "number_up": int(number_up),
        "sides": sides,
        "orientation": orientation,
        "page_ranges": (form.get("page_ranges") or "").strip(),
        "collate": (form.get("collate") or "").lower() in ("1", "true", "on", "yes"),
    }


def submit_print(pdf: Path, title: str, opts, ranges):
    # Riattiva eventuale coda fermata da un errore precedente
    run(["cupsenable", PRINTER_NAME], 10)
    run(["cupsaccept", PRINTER_NAME], 10)

    cmd = [
        "lp", "-d", PRINTER_NAME, "-n", str(opts["copies"]), "-t", title[:120],
        "-o", f"sides={opts['sides']}",
        "-o", f"collate={'true' if opts['collate'] else 'false'}",
        "-o", "media=A4",
        "-o", "fit-to-page",
    ]
    if opts["number_up"] > 1:
        cmd += ["-o", f"number-up={opts['number_up']}"]
    orient = ORIENTATIONS[opts["orientation"]]
    if orient:
        cmd += ["-o", f"orientation-requested={orient}"]
    if ranges:
        cmd += ["-o", f"page-ranges={ranges}"]
    cmd.append(str(pdf))

    r = run(cmd, 60)
    if r.returncode != 0:
        raise AppError(f"Errore della coda di stampa: {(r.stderr or r.stdout).strip()}", 502)
    m = re.search(r"request id is (\S+)", r.stdout)
    return m.group(1) if m else "?"


def ingest(fs, workdir: Path):
    """Salva l'upload e lo porta a PDF. Ritorna (pdf, pagine, dimensioni pagine, nome originale)."""
    original = fs.filename or "documento"
    ext = Path(original).suffix.lower().lstrip(".")
    if ext not in ALLOWED_EXT:
        raise AppError(f"Formato '.{ext or '?'}' non supportato.", 415)
    src = workdir / f"input.{ext}"
    fs.save(src)
    size = src.stat().st_size
    if size == 0:
        raise AppError("Il file e' vuoto.", 422)
    if size > MAX_UPLOAD_MB * 1024 * 1024:
        raise AppError(f"Il file supera il limite di {MAX_UPLOAD_MB} MB.", 413)

    if ext in PDF_EXT:
        pdf = src
    elif ext in IMAGE_EXT:
        pdf = workdir / "converted.pdf"
        image_to_pdf(src, pdf)
    else:
        pdf = convert_with_libreoffice(src, workdir)

    pages, sizes = pdf_info(pdf)
    if pages == 0:
        raise AppError("Il documento non contiene pagine.", 422)
    return pdf, pages, sizes, original


def print_item(item, opts):
    """Stampa un documento: o da un'anteprima gia' pronta (token) o da un upload diretto."""
    original = item["name"]
    result = {"key": item.get("key"), "filename": original, "ok": False}
    workdir = None
    preview = None
    try:
        if item.get("token"):
            preview = preview_dir(item["token"])
            pdf = preview / "doc.pdf"
            pages = pdf_info(pdf)[0]
        else:
            workdir = Path(tempfile.mkdtemp(prefix="job_", dir=WORK_ROOT))
            pdf, pages, _sizes, original = ingest(item["fs"], workdir)
            result["filename"] = original
        ranges = normalize_ranges(item.get("range"), pages)
        job_id = submit_print(pdf, original, opts, ranges)
        remember_title(job_id, original)

        warning = None
        time.sleep(1.5)
        st = printer_status()
        if not st["reachable"]:
            warning = "La stampante non risponde in rete: il job resta in coda e verra' ritentato."
        elif st["state"] == "disabled":
            warning = "La coda risulta ferma: controlla la stampante."
        elif st["alerts"]:
            warning = f"Avviso dalla stampante: {st['alerts']}"

        selected = count_selected(ranges, pages)
        per_sheet = opts["number_up"] * (1 if opts["sides"] == "one-sided" else 2)
        sheets = -(-selected // per_sheet) * opts["copies"]
        result.update(
            ok=True, job_id=job_id, pages=pages, sheets=sheets, warning=warning,
            message=f"Inviato in stampa (job {job_id}): {selected} pag. x {opts['copies']} copie, circa {sheets} fogli.",
        )
        log.info("Stampa %s -> %s (%d pag, %d copie)", original, job_id, pages, opts["copies"])
        if preview:
            shutil.rmtree(preview, ignore_errors=True)  # stampato: l'anteprima non serve piu'
    except AppError as e:
        log.warning("Errore su '%s': %s", original, e.message)
        result["error"] = e.message
        if e.status == 410:
            result["expired"] = True
    except Exception:
        log.exception("Errore imprevisto su '%s'", original)
        result["error"] = "Errore interno imprevisto. Controlla i log del container."
    finally:
        if workdir:
            shutil.rmtree(workdir, ignore_errors=True)  # pulizia automatica dei temporanei
    return result


# ----------------------------------------------------------------------------
# Anteprime (PDF convertito conservato per un po' + miniature generate a richiesta)
# ----------------------------------------------------------------------------
def preview_dir(token) -> Path:
    if not TOKEN_RE.match(token or ""):
        raise AppError("Anteprima non valida.", 400)
    d = PREVIEW_ROOT / token
    if not (d / "doc.pdf").is_file():
        raise AppError("Anteprima scaduta: il file va ricaricato.", 410)
    try:
        os.utime(d, None)  # accesso recente = non scade
    except OSError:
        pass
    return d


def _dir_size(d: Path) -> int:
    total = 0
    for f in d.rglob("*"):
        try:
            if f.is_file():
                total += f.stat().st_size
        except OSError:
            pass
    return total


def gc_previews():
    """Elimina anteprime scadute e, se serve, le piu' vecchie per restare nel limite di spazio."""
    now = time.time()
    entries = []
    for d in PREVIEW_ROOT.iterdir():
        try:
            if d.is_dir():
                entries.append([d.stat().st_mtime, d, _dir_size(d)])
        except OSError:
            continue
    keep = []
    for e in entries:
        if now - e[0] > PREVIEW_TTL:
            shutil.rmtree(e[1], ignore_errors=True)
        else:
            keep.append(e)
    keep.sort(key=lambda e: e[0])
    total = sum(e[2] for e in keep)
    while keep and total > PREVIEW_MAX_MB * 1024 * 1024:
        _m, d, s = keep.pop(0)
        shutil.rmtree(d, ignore_errors=True)
        total -= s


def _gc_loop():
    while True:
        time.sleep(60)
        try:
            gc_previews()
        except Exception:
            log.exception("Pulizia anteprime non riuscita")


def render_page(d: Path, n: int, size: str):
    """JPEG della pagina n (1-based) alla risoluzione 's' o 'l'; in cache nella cartella dell'anteprima."""
    out = d / f"p{n}-{size}.jpg"
    if out.exists():
        return out
    with _render_sem:
        if out.exists():
            return out
        tmp = d / f"t{n}{size}{uuid.uuid4().hex[:8]}"
        r = run(
            ["pdftoppm", "-jpeg", "-jpegopt", "quality=82", "-singlefile", "-f", str(n), "-l", str(n),
             "-scale-to-x", str(THUMB_WIDTH[size]), "-scale-to-y", "-1", str(d / "doc.pdf"), str(tmp)],
            60,
        )
        produced = tmp.with_name(tmp.name + ".jpg")
        if r.returncode != 0 or not produced.exists():
            return None
        produced.replace(out)
    return out


# ----------------------------------------------------------------------------
# Rotte
# ----------------------------------------------------------------------------
@app.get("/")
def index():
    return render_template(
        "index.html",
        max_mb=MAX_UPLOAD_MB,
        exts=",".join(sorted(ALLOWED_EXT)),
        accept=",".join("." + e for e in sorted(ALLOWED_EXT)),
        printer_name=PRINTER_NAME,
        printer_host=PRINTER_HOST,
    )


@app.get("/healthz")
def healthz():
    return "ok", 200


@app.get("/api/status")
def api_status():
    return jsonify(printer=printer_status(), jobs=list_jobs())


@app.post("/api/preview")
def api_preview():
    """Converte il file in PDF (una sola volta) e ne restituisce pagine e dimensioni."""
    fs = request.files.get("file")
    if not fs or not fs.filename:
        return jsonify(error="Nessun file ricevuto."), 400
    token = uuid.uuid4().hex
    d = PREVIEW_ROOT / token
    d.mkdir(parents=True)
    try:
        pdf, pages, sizes, original = ingest(fs, d)
        final = d / "doc.pdf"
        if pdf != final:
            pdf.replace(final)
        for f in d.iterdir():  # via originale e intermedi: servono solo doc.pdf e le miniature
            if f != final and f.is_file():
                f.unlink()
    except AppError as e:
        shutil.rmtree(d, ignore_errors=True)
        log.warning("Anteprima fallita per '%s': %s", fs.filename, e.message)
        return jsonify(error=e.message), e.status
    except Exception:
        shutil.rmtree(d, ignore_errors=True)
        log.exception("Errore imprevisto nell'anteprima di '%s'", fs.filename)
        return jsonify(error="Errore interno imprevisto. Controlla i log del container."), 500
    gc_previews()
    return jsonify(token=token, filename=original, pages=pages, sizes=sizes)


@app.get("/api/preview/<token>/page/<int:n>.jpg")
def api_preview_page(token, n):
    d = preview_dir(token)
    size = request.args.get("s", "s")
    if size not in THUMB_WIDTH:
        size = "s"
    if n < 1:
        return jsonify(error="Pagina non valida."), 400
    out = render_page(d, n, size)
    if out is None:
        return jsonify(error="Pagina non disponibile."), 404
    resp = send_file(out, mimetype="image/jpeg")
    resp.headers["Cache-Control"] = "private, max-age=600"
    return resp


@app.delete("/api/preview/<token>")
def api_preview_delete(token):
    if not TOKEN_RE.match(token):
        return jsonify(error="Anteprima non valida."), 400
    shutil.rmtree(PREVIEW_ROOT / token, ignore_errors=True)
    return jsonify(ok=True)


@app.post("/api/print")
def api_print():
    """Stampa. Due modi: 'jobs' (JSON con token delle anteprime, intervallo per file) oppure 'files' diretti."""
    try:
        opts = parse_options(request.form)
        items = []
        raw = request.form.get("jobs")
        if raw:
            try:
                jobs = json.loads(raw)
            except ValueError:
                raise AppError("Elenco dei lavori non valido.")
            if not isinstance(jobs, list) or not jobs or len(jobs) > 50:
                raise AppError("Elenco dei lavori non valido.")
            for j in jobs:
                if not isinstance(j, dict):
                    raise AppError("Elenco dei lavori non valido.")
                items.append({
                    "key": j.get("key"),
                    "name": str(j.get("name") or "documento")[:200],
                    "token": str(j.get("token") or ""),
                    "range": str(j.get("range") or "").strip(),
                })
        else:
            files = [f for f in request.files.getlist("files") if f and f.filename]
            if not files:
                raise AppError("Nessun file selezionato.")
            items = [{"key": i, "fs": f, "name": f.filename, "range": opts["page_ranges"]} for i, f in enumerate(files)]
        ensure_printer()
    except AppError as e:
        return jsonify(error=e.message), e.status
    results = [print_item(it, opts) for it in items]
    return jsonify(ok=all(r["ok"] for r in results), results=results)


@app.delete("/api/jobs/<job_id>")
def api_cancel_job(job_id):
    if not JOB_ID_RE.match(job_id) or not job_id.startswith(PRINTER_NAME + "-"):
        return jsonify(error="ID job non valido."), 400
    r = run(["cancel", job_id], 15)
    if r.returncode != 0:
        return jsonify(error=(r.stderr or r.stdout).strip() or "Annullamento non riuscito."), 502
    return jsonify(ok=True)


@app.delete("/api/jobs")
def api_cancel_all():
    r = run(["cancel", "-a", PRINTER_NAME], 15)
    if r.returncode != 0:
        return jsonify(error=(r.stderr or r.stdout).strip() or "Annullamento non riuscito."), 502
    return jsonify(ok=True)


@app.errorhandler(AppError)
def app_error(e):
    return jsonify(error=e.message), e.status


@app.errorhandler(413)
def too_large(_e):
    return jsonify(error=f"Caricamento troppo grande (limite {MAX_UPLOAD_MB} MB per file)."), 413


@app.errorhandler(404)
def not_found(_e):
    return jsonify(error="Risorsa non trovata."), 404


# ----------------------------------------------------------------------------
# Avvio: pulizia temporanei e configurazione coda in background
# ----------------------------------------------------------------------------
def _bootstrap():
    for _ in range(40):
        try:
            if cups_up():
                ensure_printer()
                return
        except AppError as e:
            log.warning("Configurazione stampante in attesa: %s", e.message)
        time.sleep(15)
    log.error("Configurazione automatica della stampante non riuscita; verra' ritentata alla prima stampa.")


shutil.rmtree(WORK_ROOT, ignore_errors=True)
PREVIEW_ROOT.mkdir(parents=True, exist_ok=True)
threading.Thread(target=_bootstrap, daemon=True, name="bootstrap").start()
threading.Thread(target=_gc_loop, daemon=True, name="preview-gc").start()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
