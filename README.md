# razavian.net — Razavian Lab website

A static site (GitHub Pages, no build step) that renders from data files:

| File | What it holds | Updated by |
|---|---|---|
| `data/publications.json` + `assets/pubs/` | Papers, figures, summaries, code links | **Automatically**, weekly GitHub Action |
| `data/overrides.yml` | Manual fixes to any paper (summary, code link, figure, hide, featured) | You |
| `data/site.yml` | Bio, research themes, teaching, contact email | You |

Edit any `.yml` file directly on GitHub (open it → pencil icon → *Commit changes*). The site updates in about a minute.

## How publications stay up to date

`.github/workflows/update-publications.yml` runs every Monday (and on demand from the
**Actions** tab → *Update publications* → *Run workflow*). It runs
`scripts/update_publications.py`, which:

1. Reads the Google Scholar profile (`scholar_id` in `data/site.yml`).
2. Looks up every **new** paper on OpenAlex (falling back to Crossref) for its DOI, authors, PDF and arXiv links.
   Patents, conference abstracts, errata and tech reports are detected and hidden behind an
   "Abstracts & patents" toggle. Duplicate Scholar entries (preprint plus journal version) are merged.
3. The **latest 10 papers** (`FEATURED_N` in the script) are shown as visual cards and also get:
   - a released-code link (GitHub/GitLab/Hugging Face) found in the abstract or PDF,
   - a representative figure (arXiv HTML figure → "Figure 1" region of the PDF → largest image).
     Paywalled papers get a generated cover in their topic color, and you can add a figure via overrides,
   - a short summary: the opening sentences of the abstract.

   Older papers appear in a compact list (title, authors, venue, links). When a paper drops out of the
   latest 10, its auto-extracted figure and summary are removed.

Papers that were already processed are not touched again, so a weekly run takes a minute or two.

No API keys or secrets are needed. Google Scholar sometimes blocks GitHub's servers, and OpenAlex
has a small shared daily quota. A blocked run keeps the existing data unchanged, papers that hit the
quota are retried on the next run, and you can always run the script from your laptop:

```bash
pip install -r scripts/requirements.txt
python scripts/update_publications.py          # new papers only
python scripts/update_publications.py --refresh  # re-process everything
git add data assets/pubs && git commit -m "Update publications" && git push
```

### Fixing a paper

Automation gets most things right, but not all. Add an entry to `data/overrides.yml`:

```yaml
- match: "3D foundation model for generalizable disease detection"   # part of the title
  featured: true
  code: https://github.com/NYUMedML/...
  summary: "Our own better 2-3 line description."
  image: assets/pubs/my-teaser.png      # upload the image into assets/pubs/
  links: [{ label: Model weights, url: "https://huggingface.co/..." }]
- match: "Abstract 1378"
  hide: true
```

## Local preview

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```
