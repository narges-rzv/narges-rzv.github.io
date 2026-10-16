#!/usr/bin/env python3
"""Sync publications from Google Scholar and enrich them for the website.

Pipeline (results are cached in data/publications.json, so each paper is looked up once):
  1. Read the Google Scholar profile.
  2. Every paper: match on OpenAlex (fallback Crossref) for DOI, authors, PDF and arXiv links.
  3. The latest FEATURED_N papers additionally get:
       - a released-code link (GitHub/GitLab/Hugging Face) from the abstract or PDF,
       - a representative figure (arXiv HTML figure, else from the PDF),
       - a short summary (the abstract's opening sentences).
     When a paper drops out of the latest N, its figure and summary are removed.
Manual corrections live in data/overrides.yml and are applied by the page at load time.

Usage:
  python scripts/update_publications.py              # sync + enrich new papers
  python scripts/update_publications.py --refresh    # redo all lookups
  python scripts/update_publications.py --refigure   # retry figure extraction for papers without one
"""
import argparse
import datetime as dt
import difflib
import html
import io
import json
import re
import sys
import time
from pathlib import Path
from urllib.parse import urljoin, urlparse, parse_qs, quote

import requests
import yaml

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
PUB_JSON = DATA / "publications.json"
FIG_DIR = ROOT / "assets" / "pubs"
OVERRIDES = DATA / "overrides.yml"
FEATURED_N = 10  # only the latest N papers get a figure, summary and full code search

SITE = yaml.safe_load((DATA / "site.yml").read_text())
SCHOLAR_ID = SITE["scholar_id"]
OPENALEX_AUTHOR = SITE.get("openalex_author_id")  # optional, improves matching
ENRICH_VERSION = 1

TOPICS = [t["id"] for t in SITE["research"]]

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
S = requests.Session()
S.headers["User-Agent"] = UA


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def norm(t):
    return re.sub(r"[^a-z0-9]+", " ", (t or "").lower()).strip()


def similar(a, b):
    return difflib.SequenceMatcher(None, norm(a), norm(b)).ratio()


def get(url, retry_429=True, **kw):
    kw.setdefault("timeout", 30)
    for attempt in range(3):
        try:
            r = S.get(url, **kw)
            if r.status_code == 429 and retry_429:
                time.sleep(5 * (attempt + 1))
                continue
            return r
        except requests.RequestException as e:
            log("  request failed:", url, e)
            time.sleep(2)
    return None


# --------------------------------------------------------------------------- Scholar

class ScholarBlocked(Exception):
    pass


def scholar_direct():
    out, start = [], 0
    while True:
        url = (f"https://scholar.google.com/citations?user={SCHOLAR_ID}&hl=en"
               f"&cstart={start}&pagesize=100&sortby=pubdate")
        r = get(url)
        if r is None or r.status_code != 200 or "gsc_a_tr" not in r.text and "gsc_a_e" not in r.text:
            raise ScholarBlocked(f"status={getattr(r, 'status_code', None)}")
        t = r.text
        if start == 0:
            stats = re.findall(r'gsc_rsb_std">(\d+)<', t)
            profile = {"citations": int(stats[0]), "h_index": int(stats[2]),
                       "i10_index": int(stats[4])} if len(stats) >= 6 else {}
        rows = re.findall(r'<tr class="gsc_a_tr">(.*?)</tr>', t, re.S)
        for row in rows:
            m = re.search(r'href="([^"]+)" class="gsc_a_at">(.*?)</a>', row, re.S)
            grays = re.findall(r'<div class="gs_gray">(.*?)</div>', row, re.S)
            year = re.search(r'gsc_a_h gsc_a_hc gs_ibl">(\d*)<', row)
            cites = re.search(r'class="gsc_a_ac gs_ibl">(\d*)<', row)
            href = html.unescape(m.group(1))
            sid = parse_qs(urlparse(href).query).get("citation_for_view", [""])[0]
            venue = re.sub(r"<[^>]+>", "", html.unescape(grays[1])) if len(grays) > 1 else ""
            venue = re.sub(r",\s*\d{4}$", "", venue).strip()
            out.append({
                "scholar_id": sid,
                "title": html.unescape(re.sub(r"<[^>]+>", "", m.group(2))).strip(),
                "authors_short": html.unescape(grays[0]) if grays else "",
                "venue": venue,
                "year": int(year.group(1)) if year and year.group(1) else None,
                "citations": int(cites.group(1)) if cites and cites.group(1) else 0,
                "scholar_url": "https://scholar.google.com" + href,
            })
        if len(rows) < 100:
            return out, profile
        start += 100
        time.sleep(4)


def fetch_scholar():
    try:
        rows, profile = scholar_direct()
        log(f"Scholar (direct): {len(rows)} papers")
        return rows, profile
    except ScholarBlocked as e:
        log("Scholar direct fetch blocked:", e)
    return None, None


# --------------------------------------------------------------------------- Enrichment

def clean_abstract(t):
    t = " ".join((t or "").split())
    t = re.sub(r"(\w)- (\w)", r"\1\2", t)  # "de- ployed" -> "deployed"
    t = re.sub(r"^(Abstract|Summary)[:.\s]+", "", t, flags=re.I)
    return t.strip()


def openalex_abstract(inv):
    if not inv:
        return ""
    pos = sorted((i, w) for w, idxs in inv.items() for i in idxs)
    return clean_abstract(" ".join(w for _, w in pos))


class RateLimited(Exception):
    """A lookup service refused us; leave the paper un-enriched so the next run retries it."""


OPENALEX_EXHAUSTED = False  # set once the daily quota is gone; skip OpenAlex for the rest of the run


def openalex_match(title):
    global OPENALEX_EXHAUSTED
    if OPENALEX_EXHAUSTED:
        return "limited"
    params = {"search": title, "per_page": 5}
    tries = []
    if OPENALEX_AUTHOR:
        tries.append(dict(params, filter=f"authorships.author.id:{OPENALEX_AUTHOR}"))
    tries.append(params)
    limited = False
    for p in tries:
        r = get("https://api.openalex.org/works", params=p, retry_429=False)
        if r is not None and r.status_code == 429:
            log("  OpenAlex daily quota exhausted; using Crossref for the rest of this run")
            OPENALEX_EXHAUSTED = True
            return "limited"
        if r is None or r.status_code != 200:
            limited = limited or r is None or r.status_code == 429
            continue
        best = max(r.json().get("results", []), key=lambda w: similar(w.get("title"), title), default=None)
        if best and similar(best.get("title"), title) > 0.88:
            return best
    return "limited" if limited else None


def crossref_match(title):
    """Keyless fallback for DOI, venue, authors and (sometimes) the abstract."""
    r = get("https://api.crossref.org/works", params={"query.bibliographic": title, "rows": 5,
            "select": "DOI,type,title,abstract,author,container-title,published,link"})
    if r is None or r.status_code != 200:
        return None
    hits = [it for it in r.json()["message"]["items"]
            if it.get("title") and similar(it["title"][0], title) > 0.9]
    hits.sort(key=lambda it: it.get("type") == "posted-content")  # journal version before preprint
    return hits[0] if hits else None


def arxiv_match(title):
    q = re.sub(r"[^\w\s-]", " ", title)
    r = get("http://export.arxiv.org/api/query",
            params={"search_query": f'ti:"{q}"', "max_results": 3})
    time.sleep(3)
    if r is None or r.status_code != 200:
        return None
    for entry in re.findall(r"<entry>(.*?)</entry>", r.text, re.S):
        t = re.search(r"<title>(.*?)</title>", entry, re.S).group(1)
        if similar(t, title) > 0.9:
            aid = re.search(r"<id>https?://arxiv.org/abs/([^<]+?)(v\d+)?</id>", entry).group(1)
            summ = re.search(r"<summary>(.*?)</summary>", entry, re.S).group(1)
            comment = re.search(r"<arxiv:comment[^>]*>(.*?)</arxiv:comment>", entry, re.S)
            return {"id": aid, "abstract": clean_abstract(summ),
                    "comment": html.unescape(comment.group(1)) if comment else ""}
    return None


CODE_RE = re.compile(
    r"https?://(?:www\.)?(?:github\.com|gitlab\.com|huggingface\.co|bitbucket\.org)/"
    r"[A-Za-z0-9_.\-]+(?:/[A-Za-z0-9_.\-]+)?", re.I)
CODE_HINT = re.compile(r"code|implementation|available|release|repositor|open[- ]source|github", re.I)


def clean_code_url(u):
    u = u.rstrip(".,;)")
    parts = urlparse(u).path.strip("/").split("/")
    if "huggingface.co" not in u and len(parts) < 2:
        return None  # org/user page, not a repo
    return u


def find_code(texts):
    """First repo link in the abstract/comments, else one mentioned near 'code' in the PDF."""
    for t in texts[:2]:
        for m in CODE_RE.finditer(t or ""):
            if (u := clean_code_url(m.group(0))):
                return u
    for t in texts[2:]:
        t = re.sub(r"-\s*\n\s*", "", t or "")      # undo PDF line-break hyphenation
        t = re.sub(r"\s*\n\s*", " ", t)
        for m in CODE_RE.finditer(t):
            ctx = t[max(0, m.start() - 160): m.start()]
            if CODE_HINT.search(ctx) and (u := clean_code_url(m.group(0))):
                return u
    return None


def download_pdf(urls):
    for u in urls:
        if not u:
            continue
        data = fetch_bytes(u)
        if data and data[:4] == b"%PDF":
            return data
    return None


def fetch_bytes(url, deadline=90, max_bytes=60_000_000):
    """Download with a total time limit (requests' timeout only bounds each read)."""
    start = time.time()
    try:
        with S.get(url, timeout=30, stream=True) as r:
            if r.status_code != 200:
                return None
            buf = bytearray()
            for chunk in r.iter_content(65536):
                buf += chunk
                if time.time() - start > deadline or len(buf) > max_bytes:
                    log("  download abandoned (too slow/large):", url)
                    return None
            return bytes(buf)
    except requests.RequestException as e:
        log("  download failed:", url, e)
        return None


def save_image(img, slug):
    from PIL import Image
    if img.mode in ("RGBA", "LA", "P"):  # flatten transparency onto white, not black
        img = img.convert("RGBA")
        bg = Image.new("RGBA", img.size, "white")
        img = Image.alpha_composite(bg, img)
    img = img.convert("RGB")
    if img.width > 960:
        img = img.resize((960, round(img.height * 960 / img.width)), Image.LANCZOS)
    FIG_DIR.mkdir(parents=True, exist_ok=True)
    path = FIG_DIR / f"{slug}.webp"
    img.save(path, "WEBP", quality=80, method=6)
    return path.relative_to(ROOT).as_posix()


def usable(img):
    w, h = img.size
    return w >= 280 and h >= 90 and 0.35 <= w / h <= 5.5


def figure_from_arxiv_html(aid, slug):
    from PIL import Image
    r = get(f"https://arxiv.org/html/{aid}")
    if r is None or r.status_code != 200:
        return None
    bm = re.search(r'<base\s+href="([^"]+)"', r.text)
    base = urljoin(r.url, bm.group(1)) if bm else r.url
    for fig in re.findall(r"<figure[^>]*class=\"[^\"]*ltx_figure[^\"]*\"[^>]*>(.*?)</figure>", r.text, re.S):
        for src in re.findall(r'<img[^>]+src="([^"]+)"', fig):
            ir = get(urljoin(base, src))
            if ir is None or ir.status_code != 200:
                continue
            try:
                img = Image.open(io.BytesIO(ir.content))
                img.load()
            except Exception:
                continue
            if usable(img):
                return save_image(img, slug)
    return None


def figure_from_pdf(pdf, slug):
    """Use the 'Figure 1' region (vector or raster), else the largest embedded image."""
    import pymupdf
    from PIL import Image
    doc = pymupdf.open(stream=pdf, filetype="pdf")
    pages = range(min(6, len(doc)))
    for pno in pages:
        page = doc[pno]
        for b in page.get_text("blocks"):
            if not re.match(r"\s*(Figure|Fig\.?)\s*1\b", b[4]):
                continue
            cap = pymupdf.Rect(b[:4])
            col = pymupdf.Rect(0, 0, page.rect.width, cap.y0)
            if cap.width < page.rect.width * 0.55:  # two-column layout: stay in this column
                mid = page.rect.width / 2
                col = pymupdf.Rect(0 if cap.x0 < mid else mid, 0, mid if cap.x1 <= mid + 20 else page.rect.width, cap.y0)
            rects = [d["rect"] for d in page.get_drawings() if d["rect"].intersects(col) and d["rect"].y1 <= cap.y0 + 2]
            rects += [pymupdf.Rect(i["bbox"]) for i in page.get_image_info() if pymupdf.Rect(i["bbox"]).y1 <= cap.y0 + 2]
            rects = [r & col for r in rects if (r & col).height > 0 and cap.y0 - r.y1 < 420]
            if not rects:
                continue
            region = rects[0]
            for r in rects[1:]:
                region |= r
            if region.width < 150 or region.height < 80:
                continue
            pix = page.get_pixmap(clip=region + (-4, -4, 4, 4), dpi=170)
            img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
            if usable(img):
                return save_image(img, slug)
    best = None
    for pno in pages:
        for info in doc[pno].get_image_info(xrefs=True):
            area = pymupdf.Rect(info["bbox"]).get_area()
            if info["xref"] and (best is None or area > best[0]):
                best = (area, info["xref"])
    if best and best[0] > 20000:
        try:
            pix = pymupdf.Pixmap(doc, best[1])
            if pix.n - pix.alpha > 3:
                pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
            img = Image.open(io.BytesIO(pix.tobytes("png")))
            if usable(img):
                return save_image(img, slug)
        except Exception as e:
            log("  image extraction failed:", e)
    return None


def find_figure(p, pdf=None):
    slug = slugify(p)
    img = figure_from_arxiv_html(p["arxiv"], slug) if p.get("arxiv") else None
    if not img:
        pdf = pdf or download_pdf([p.get("arxiv") and f"https://arxiv.org/pdf/{p['arxiv']}", p.get("pdf_url")])
        if pdf:
            try:
                img = figure_from_pdf(pdf, slug)
            except Exception as e:
                log("  figure extraction failed:", e)
    return img


def pdf_text(pdf, max_pages=4):
    import pymupdf
    doc = pymupdf.open(stream=pdf, filetype="pdf")
    return "\n".join(doc[i].get_text() for i in range(min(max_pages, len(doc))))


def first_sentences(text, n=2, limit=330):
    # Structured abstracts: prefer the findings/conclusion over "Importance:"/"Background:"
    m = re.search(r"\b(Conclusions?(?: and Relevance)?|Interpretation|Findings)[:.]\s+(.*)", text)
    if m and len(m.group(2)) > 80:
        text = m.group(2)
    text = re.sub(r"^(Importance|Background|Objectives?|Purpose|Introduction)[:.]\s+", "", text.strip())
    sents = re.split(r"(?<=[.!?])\s+(?=[A-Z])", text.strip())
    out = ""
    for s in sents:
        if len(out) + len(s) > limit and out:
            break
        out = (out + " " + s).strip()
        if out.count(". ") + 1 >= n and len(out) > 140:
            break
    return out


KEYWORDS = {
    "foundation": r"foundation model|large language|LLM|GPT|pretrain|self-supervised|generative",
    "ehr": r"electronic health record|EHR|claims|clinical data|risk|lab tests?|prognos|onset|cohort",
    "neuro": r"brain|MRI|alzheimer|dementia|neuro|stroke|hemorrhage|cognitive",
    "imaging": r"radiograph|x-ray|CT\b|computed tomography|imaging|mammogra|ultrasound|chest",
    "pathology": r"histopatholog|whole[- ]slide|patholog|microscop|tumou?r|cancer subtype",
    "nlp": r"clinical notes|natural language|NLP|text|ICD|BERT|tweets",
    "trustworthy": r"bias|fairness|robust|uncertaint|noisy label|continual|shift|calibrat",
}


def guess_topics(text):
    hits = [t for t, pat in KEYWORDS.items() if t in TOPICS and re.search(pat, text, re.I)]
    return hits[:2]


def slugify(p):
    words = norm(p["title"]).split()[:7]
    return f"{p.get('year') or 'x'}-{'-'.join(words)}"[:70]


def enrich_metadata(p):
    """Cheap lookups for every paper: DOI, venue, authors, abstract, PDF/arXiv links."""
    log(f"→ {p['title'][:90]}")
    oa = openalex_match(p["title"])
    limited = oa == "limited"
    oa = None if limited else oa
    cr = None if oa else crossref_match(p["title"])
    if limited and not cr:
        raise RateLimited("OpenAlex")
    if cr:
        p["doi"] = cr.get("DOI")
        p["abstract"] = clean_abstract(re.sub(r"<[^>]+>", " ", cr.get("abstract", "")))
        p["authors"] = [f"{a.get('given', '')} {a.get('family', '')}".strip() for a in cr.get("author", [])]
        if cr.get("container-title"):
            p["venue_full"] = cr["container-title"][0]
        pdf = next((l["URL"] for l in cr.get("link", []) if "pdf" in l.get("content-type", "")), None)
        p["pdf_url"] = p.get("pdf_url") or pdf
    if oa:
        p["openalex_id"] = oa["id"].rsplit("/", 1)[-1]
        p["doi"] = (oa.get("doi") or "").replace("https://doi.org/", "") or None
        p["abstract"] = openalex_abstract(oa.get("abstract_inverted_index"))
        p["authors"] = [a["author"]["display_name"] for a in oa.get("authorships", [])]
        p["date"] = oa.get("publication_date")
        src = ((oa.get("primary_location") or {}).get("source") or {}).get("display_name")
        if src:
            p["venue_full"] = src
        best = oa.get("best_oa_location") or {}
        p["pdf_url"] = best.get("pdf_url")
        for loc in oa.get("locations", []):
            lp = loc.get("landing_page_url") or ""
            m = re.search(r"arxiv\.org/abs/([\w.\-/]+?)(v\d+)?$", lp)
            if m:
                p["arxiv"] = m.group(1)
            if not p.get("pdf_url") and loc.get("pdf_url"):
                p["pdf_url"] = loc["pdf_url"]
    m = re.search(r"arXiv[:\s]*(\d{4}\.\d{4,5})", p.get("venue", ""))
    if m:
        p["arxiv"] = m.group(1)
    if p.get("arxiv") and not p.get("pdf_url"):
        p["pdf_url"] = f"https://arxiv.org/pdf/{p['arxiv']}"
    p["code"] = find_code([p.get("abstract", "")])
    p["topics"] = guess_topics(f"{p['title']} {p.get('abstract', '')}")
    p["enriched_v"] = ENRICH_VERSION
    p["enriched_at"] = dt.date.today().isoformat()


def enrich_rich(p):
    """Latest papers only: arXiv lookup, PDF scan for code, figure, and a 2-3 sentence summary."""
    log(f"★ {p['title'][:90]}")
    arx = None
    if not p.get("arxiv") or not p.get("abstract"):
        arx = arxiv_match(p["title"])
        if arx:
            p["arxiv"] = arx["id"]
            p["abstract"] = p.get("abstract") or arx["abstract"]
            p["pdf_url"] = p.get("pdf_url") or f"https://arxiv.org/pdf/{arx['id']}"
    pdf = download_pdf([p.get("arxiv") and f"https://arxiv.org/pdf/{p['arxiv']}", p.get("pdf_url")])
    p["code"] = find_code([p.get("abstract", ""), arx["comment"] if arx else "",
                           pdf_text(pdf) if pdf else ""])
    p["image"] = find_figure(p, pdf)
    p["summary"] = first_sentences(p.get("abstract") or "")
    p["summary_source"] = "abstract" if p["summary"] else None
    p["rich_v"] = ENRICH_VERSION


def drop_rich(p):
    """A paper that has left the latest-N set goes back to a compact entry."""
    for k in ("image", "summary", "summary_source", "rich_v"):
        p.pop(k, None)


# --------------------------------------------------------------------------- Main

def kind(r):
    """paper (incl. preprints) | abstract | patent | report | erratum. Only papers are shown by default."""
    v, t = r.get("venue", ""), r["title"]
    if re.search(r"\bpatent\b", v, re.I):
        return "patent"
    if re.match(r"(correction|erratum|retraction)\b", t, re.I):
        return "erratum"
    if re.search(r"tech(nical)? rep|CMU-CS|carnegie mellon|thesis|dissertation", f"{v} {t}", re.I):
        return "report"
    if (re.search(r"_?Supplement_?|\b([AS])\d+-\1\d+\b|abstract \d+", f"{v} {t}", re.I)
            or re.match(r"(P\d+[.\s]|S\d+ |\d+: )", t)
            or re.search(r"Alzheimer's & Dementia \d+, e\d+|Value in Health|LABORATORY INVESTIGATION|"
                         r"^DIABETES\b|Investigative Ophthalmology|Innovation in Aging", v)):
        return "abstract"
    return "paper"


def dedupe_key(title):
    t = norm(title)
    t = re.sub(r"^(abstract \d+|p\d+ \d+ \d+) ", "", t)
    t = re.sub(r" (arxiv e prints|corr abs|vol \d+|cmu cs|epub).*$", "", t)
    return t[:60]


def dedupe(rows):
    """Scholar lists preprints, published versions, errata and abstracts separately; keep the best one."""
    rank = lambda x: (x["kind"] == "paper",
                      not re.search(r"arxiv|biorxiv|medrxiv|preprint", x.get("venue", ""), re.I),
                      x["citations"])
    kept = {}
    for r in rows:
        r["kind"] = kind(r)
        k = dedupe_key(r["title"])
        if k in kept:
            a = kept[k]
            best, other = (r, a) if rank(r) > rank(a) else (a, r)
            best["citations"] = max(r["citations"], a["citations"])
            kept[k] = best
        else:
            kept[k] = r
    return list(kept.values())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true", help="redo all lookups")
    ap.add_argument("--refigure", action="store_true", help="retry figures for papers without one")
    ap.add_argument("--limit", type=int, default=0, help="enrich at most N papers this run")
    args = ap.parse_args()

    old = json.loads(PUB_JSON.read_text()) if PUB_JSON.exists() else {"papers": []}
    cache = {p["scholar_id"]: p for p in old["papers"]}

    rows, profile = fetch_scholar()
    if rows is None:
        log("Could not reach Google Scholar. Keeping existing data; "
            "re-enriching cached papers only.")
        rows, profile = [dict(p) for p in old["papers"]], old.get("profile", {})

    rows = dedupe(rows)
    recent = {r["scholar_id"] for r in [r for r in rows if r["kind"] == "paper"][:FEATURED_N]}
    papers, done = [], 0
    for r in rows:
        p = {**cache.get(r["scholar_id"], {}), **r}
        p["recent"] = p["scholar_id"] in recent
        budget = not args.limit or done < args.limit
        try:
            if budget and (args.refresh or p.get("enriched_v") != ENRICH_VERSION):
                enrich_metadata(p)
                done += 1
            if not p["recent"]:
                drop_rich(p)
            elif p.get("enriched_v") and budget:
                if args.refresh or p.get("rich_v") != ENRICH_VERSION:
                    enrich_rich(p)
                elif args.refigure and not p.get("image"):
                    p["image"] = find_figure(p)
        except RateLimited as e:
            log(f"  {e} rate limit reached; this paper will be retried next run")
        except Exception as e:  # one bad paper must not break the sync
            log("  enrichment error:", repr(e))
        papers.append(p)

    papers.sort(key=lambda p: (p.get("year") or 0, p.get("date") or ""), reverse=True)
    write(papers, profile)
    prune_figures(papers)
    log(f"Done: {len(papers)} papers, {done} looked up this run.")


def prune_figures(papers):
    """Delete auto-extracted figures that no paper uses any more (manual ones in overrides are kept)."""
    used = {p.get("image") for p in papers}
    used |= set(re.findall(r"assets/pubs/[^\s\"']+", OVERRIDES.read_text() if OVERRIDES.exists() else ""))
    for f in FIG_DIR.glob("*.webp"):
        if f.relative_to(ROOT).as_posix() not in used:
            f.unlink()


def write(papers, profile):
    out = {
        "updated": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d"),
        "scholar_id": SCHOLAR_ID,
        "profile": profile or {},
        "papers": papers,
    }
    DATA.mkdir(exist_ok=True)
    PUB_JSON.write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")


if __name__ == "__main__":
    main()
