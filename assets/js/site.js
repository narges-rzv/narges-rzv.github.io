/* Renders the lab site from data/*.yml and data/publications.json. No build step. */
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const PAGE = 40; // compact rows shown before "Show all"
  const TOPIC_COLORS = ["#6d3fc0", "#c2410c", "#0e7490", "#be185d", "#15803d", "#a16207", "#4338ca", "#0f766e"];
  const ICONS = {
    scholar: '<path d="M12 3 1 9l11 6 9-4.91V17h2V9L12 3zm-7 9.18v4L12 20l7-3.82v-4L12 16l-7-3.82z"/>',
    github: '<path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.7c-2.78.6-3.37-1.34-3.37-1.34-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.08 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.64 0 0 .84-.27 2.75 1.02a9.58 9.58 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.37.2 2.39.1 2.64.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.68-4.57 4.93.36.31.68.92.68 1.85v2.74c0 .27.18.58.69.48A10 10 0 0 0 12 2z"/>',
    linkedin: '<path d="M4.98 3.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM3 9.75h4V21H3V9.75zm7 0h3.8v1.6h.05c.53-1 1.84-2.05 3.78-2.05 4.04 0 4.79 2.66 4.79 6.12V21h-4v-5.05c0-1.2-.02-2.75-1.68-2.75-1.68 0-1.94 1.31-1.94 2.66V21h-4V9.75z"/>',
    mail: '<path d="M3 5h18a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm9 7.2L4 7.3V17h16V7.3l-8 4.9z"/>',
    link: '<path d="M10.6 13.4a1 1 0 0 1 0-1.4l3.6-3.6a3 3 0 1 1 4.2 4.2l-2 2-1.4-1.4 2-2a1 1 0 1 0-1.4-1.4l-3.6 3.6a1 1 0 0 1-1.4 0zm2.8-2.8a1 1 0 0 1 0 1.4l-3.6 3.6a3 3 0 1 1-4.2-4.2l2-2 1.4 1.4-2 2a1 1 0 1 0 1.4 1.4l3.6-3.6a1 1 0 0 1 1.4 0z"/>',
    pdf: '<path d="M6 2h8l6 6v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zm7 1.5V9h5.5L13 3.5z"/>',
    quote: '<path d="M7 7h4v4H8.5c0 1.7.8 2.8 2.5 3.2V17C8.3 16.6 7 14.6 7 11.5V7zm7 0h4v4h-2.5c0 1.7.8 2.8 2.5 3.2V17c-2.7-.4-4-2.4-4-5.5V7z"/>',
  };
  const icon = (n) => `<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">${(ICONS[n] || ICONS.link).replace(/<path /g, '<path fill="currentColor" ')}</svg>`;

  // ---------- theme toggle
  const root = document.documentElement;
  try { const t = localStorage.getItem("theme"); if (t) root.dataset.theme = t; } catch (e) {}
  $(".theme-toggle").addEventListener("click", () => {
    const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("theme", root.dataset.theme); } catch (e) {}
  });
  // Paint and city modes live in their own modules and load only when asked for. One at a time.
  const modes = {};
  document.querySelectorAll("[data-mode]").forEach((b) => b.addEventListener("click", async () => {
    const name = b.dataset.mode;
    for (const [n, m] of Object.entries(modes)) if (n !== name && m.isActive()) m.exit();
    modes[name] ||= await import(`./${name}.js`);
    modes[name].toggle();
  }));
  $("#yr").textContent = new Date().getFullYear();

  const loadYaml = (u) => fetch(u, { cache: "no-cache" }).then((r) => (r.ok ? r.text() : "")).then((t) => (t ? jsyaml.load(t) : null));
  const loadJson = (u) => fetch(u, { cache: "no-cache" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);

  Promise.all([
    loadYaml("data/site.yml"), loadJson("data/publications.json"), loadYaml("data/overrides.yml"),
  ]).then(([site, pubs, overrides]) => {
    const papers = preparePapers((pubs && pubs.papers) || [], overrides || []);
    const names = nameMatcher(site);
    renderHero(site, pubs, papers);
    const filters = renderPublications(site, pubs, papers, names);
    renderThemes(site, papers, filters);
    renderTeaching(site);
  });

  // ---------- data prep
  function preparePapers(list, overrides) {
    return list.map((p) => {
      const o = overrides.find((o) => o.match && p.title.toLowerCase().includes(String(o.match).toLowerCase()));
      return o ? { ...p, ...o } : p;
    }).filter((p) => !p.hide);
  }

  const lastName = (s) => s.trim().split(/\s+/).pop().toLowerCase();
  // "Sheng Liu" / "S Liu" / "Liu S" style names → { first, last }
  const parseName = (s) => {
    const parts = s.replace(/\(.*?\)/g, " ").replace(/[.,]/g, " ").trim().split(/\s+/);
    return { first: (parts.length > 1 ? parts[0] : "").toLowerCase(), last: parts[parts.length - 1].toLowerCase() };
  };
  // Initials ("s", "sl") match any first name with that initial; full first names must match exactly.
  const sameFirst = (a, b) => {
    if (!a || !b) return false;
    const ia = a.length <= 2 && a === a.replace(/[^a-z]/g, ""), ib = b.length <= 2;
    return ia || ib ? a[0] === b[0] : a === b;
  };
  function nameMatcher(site) {
    const byLast = new Map(); // last name -> [{ first, person }]
    const add = (n, person) => {
      if (!n) return;
      const { first, last } = parseName(n);
      byLast.set(last, [...(byLast.get(last) || []), { first, person }]);
    };
    add(site.pi.name, { pi: true });
    add("Narges Sharif Razavian", { pi: true });
    return (author) => {
      const { first, last } = parseName(author);
      const hit = (byLast.get(last) || []).find((c) => sameFirst(first, c.first));
      return hit && hit.person;
    };
  }
  const authorList = (p) => (p.authors && p.authors.length ? p.authors : (p.authors_short || "").split(/,\s*/).filter(Boolean));
  const paperUrl = (p) => p.doi ? `https://doi.org/${p.doi}` : p.arxiv ? `https://arxiv.org/abs/${p.arxiv}` : p.scholar_url;

  // ---------- hero
  function renderHero(site, pubs, papers) {
    document.querySelectorAll('[data-bind="lab_name"]').forEach((el) => (el.textContent = site.lab_name));
    $('[data-bind="tagline"]').textContent = site.tagline;
    const pi = site.pi;
    $("#pi-photo").src = pi.photo;
    $("#pi-name").textContent = pi.name;
    $("#pi-title").textContent = `${pi.title}, ${pi.affiliation}`;
    $("#pi-bio").textContent = pi.bio;
    $("#pi-links").innerHTML = pi.links.map((l) => `<a href="${esc(l.url)}" ${l.url.startsWith("http") ? 'target="_blank" rel="noopener"' : ""}>${icon(l.icon)}${esc(l.label)}</a>`).join("");
    const prof = (pubs && pubs.profile) || {};
    const stats = [
      ["Publications", papers.filter((p) => !p.kind || p.kind === "paper").length],
      ["Citations", prof.citations && prof.citations.toLocaleString()],
      ["h-index", prof.h_index],
      ["Code releases", papers.filter((p) => p.code).length],
    ].filter(([, v]) => v);
    $("#stats").innerHTML = stats.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("");
    const pics = [...papers.filter((p) => p.featured && p.image), ...papers.filter((p) => !p.featured && p.image)].slice(0, 4);
    $("#collage").innerHTML = pics.map((p) => `<a href="#pub-${esc(p.scholar_id)}" title="${esc(p.title)}"><img src="${esc(p.image)}" alt="" loading="lazy"></a>`).join("");
    $("#collage").querySelectorAll("a").forEach((a) => a.addEventListener("click", (e) => {
      const id = a.getAttribute("href").slice(1);
      if (!document.getElementById(id)) { e.preventDefault(); showAll(); document.getElementById(id)?.scrollIntoView(); }
    }));
  }

  // ---------- publications
  let showAll = () => {};
  function renderPublications(site, pubs, papers, names) {
    const topics = Object.fromEntries(site.research.map((t, i) => [t.id, { ...t, color: TOPIC_COLORS[i % TOPIC_COLORS.length] }]));
    const state = { q: "", topic: "", year: "", code: false, other: false, all: false };
    if (pubs) {
      const txt = `Synced automatically from Google Scholar · updated ${pubs.updated}`;
      $("#pub-updated").textContent = txt;
      $("#footer-updated").textContent = `Publications updated ${pubs.updated}`;
    }
    const years = [...new Set(papers.map((p) => p.year).filter(Boolean))].sort((a, b) => b - a);
    $("#year").innerHTML += years.map((y) => `<option>${y}</option>`).join("");

    const chips = $("#topic-chips");
    chips.innerHTML = [`<button class="chip" data-topic="" aria-pressed="true">All topics</button>`]
      .concat(site.research.map((t) => `<button class="chip" data-topic="${t.id}" aria-pressed="false"><span class="dot" style="background:${topics[t.id].color}"></span>${esc(t.title)}</button>`)).join("");
    chips.addEventListener("click", (e) => { const b = e.target.closest(".chip"); if (b) setTopic(b.dataset.topic); });
    $("#q").addEventListener("input", (e) => { state.q = e.target.value.trim().toLowerCase(); draw(); });
    $("#year").addEventListener("change", (e) => { state.year = e.target.value; draw(); });
    $("#has-code").addEventListener("change", (e) => { state.code = e.target.checked; draw(); });
    $("#show-other").addEventListener("change", (e) => { state.other = e.target.checked; draw(); });
    $("#more").addEventListener("click", () => { state.all = true; draw(); });
    showAll = () => { state.all = true; draw(); };

    function setTopic(t) {
      state.topic = t;
      chips.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.topic === t)));
      draw();
    }

    function matches(p) {
      if (!state.other && p.kind && p.kind !== "paper") return false;
      if (state.topic && !(p.topics || []).includes(state.topic)) return false;
      if (state.year && String(p.year) !== state.year) return false;
      if (state.code && !p.code) return false;
      if (state.q) {
        const hay = [p.title, p.venue, p.venue_full, p.summary, authorList(p).join(" ")].join(" ").toLowerCase();
        return state.q.split(/\s+/).every((w) => hay.includes(w));
      }
      return true;
    }

    function draw() {
      const list = papers.filter(matches);
      const filtered = state.q || state.topic || state.year || state.code;
      const total = papers.filter((p) => state.other || !p.kind || p.kind === "paper").length;
      $("#count").textContent = filtered ? `${list.length} of ${total} papers` : "";
      let html = "", rest = list;
      if (!filtered) { // latest papers as visual cards, everything else as a compact list
        const latest = list.filter((p) => p.recent);
        rest = list.filter((p) => !p.recent);
        html += `<h3 class="year-head">Latest</h3>` + latest.map(card).join("");
        if (rest.length) html += `<h3 class="list-head">All publications</h3>`;
      }
      const shown = state.all || filtered ? rest : rest.slice(0, PAGE);
      let year = null;
      for (const p of shown) {
        if (p.year !== year) { year = p.year; html += `<h4 class="year-sub">${year || "Undated"}</h4>`; }
        html += p.recent ? card(p) : row(p);
      }
      $("#pubs").innerHTML = html || `<p class="empty">No papers match these filters.</p>`;
      $("#more").hidden = shown.length >= rest.length;
      $("#more").textContent = `Show all ${rest.length} publications`;
    }

    function linkChips(p) {
      const url = paperUrl(p);
      const links = [`<a href="${esc(url)}" target="_blank" rel="noopener">${icon("link")}Paper</a>`];
      if (p.pdf_url) links.push(`<a href="${esc(p.pdf_url)}" target="_blank" rel="noopener">${icon("pdf")}PDF</a>`);
      if (p.arxiv && !url.includes("arxiv.org")) links.push(`<a href="https://arxiv.org/abs/${esc(p.arxiv)}" target="_blank" rel="noopener">${icon("pdf")}arXiv</a>`);
      if (p.code) links.push(`<a class="code" href="${esc(p.code)}" target="_blank" rel="noopener">${icon("github")}Code</a>`);
      for (const l of p.links || []) links.push(`<a href="${esc(l.url)}" target="_blank" rel="noopener">${icon("link")}${esc(l.label)}</a>`);
      links.push(`<a class="cites" href="${esc(p.scholar_url)}" target="_blank" rel="noopener">${icon("quote")}${p.citations ? `Cited by ${p.citations}` : "Scholar"}</a>`);
      return links.join("");
    }

    function row(p) {
      return `<article class="pub-row" id="pub-${esc(p.scholar_id)}">
        <h3><a href="${esc(paperUrl(p))}" target="_blank" rel="noopener">${esc(p.title)}</a></h3>
        <p class="authors">${authorsHtml(p)}</p>
        <div class="row-foot"><span class="venue">${esc(shortVenue(p))}</span>${p.kind && p.kind !== "paper" ? `<span class="tag">${esc(p.kind)}</span>` : ""}
          <div class="links">${linkChips(p)}</div></div>
      </article>`;
    }

    function authorsHtml(p) {
      let a = authorList(p);
      const fmt = (n) => (names(n) ? `<b>${esc(n)}</b>` : esc(n));
      if (a.length > 12) {
        const mine = a.findIndex((n) => names(n) && names(n).pi);
        const keep = new Set([0, 1, 2, 3, 4, 5, a.length - 2, a.length - 1, mine]);
        let out = [], gap = false;
        a.forEach((n, i) => { if (keep.has(i)) { out.push(fmt(n)); gap = false; } else if (!gap) { out.push("…"); gap = true; } });
        return out.join(", ");
      }
      return a.map(fmt).join(", ");
    }

    function card(p) {
      const url = paperUrl(p);
      const tags = (p.topics || []).filter((t) => topics[t]).map((t) => `<span class="tag">${esc(topics[t].title)}</span>`).join("");
      const fig = p.image
        ? `<img src="${esc(p.image)}" alt="Figure from: ${esc(p.title)}" loading="lazy">`
        : placeholder(p, topics);
      return `<article class="pub${p.featured ? " featured" : ""}" id="pub-${esc(p.scholar_id)}">
        <a class="pub-fig" href="${esc(url)}" target="_blank" rel="noopener" tabindex="-1">${fig}</a>
        <div>
          <div class="pub-meta"><span class="venue">${esc(shortVenue(p))}</span>${p.kind && p.kind !== "paper" ? `<span class="tag">${esc(p.kind)}</span>` : ""}${p.year ? `<span>${p.year}</span>` : ""}${tags}</div>
          <h3><a href="${esc(url)}" target="_blank" rel="noopener">${esc(p.title)}</a></h3>
          <p class="authors">${authorsHtml(p)}</p>
          ${p.summary ? `<p class="summary">${esc(p.summary)}</p>` : ""}
          <div class="links">${linkChips(p)}</div>
        </div>
      </article>`;
    }

    draw();
    return { setTopic, topics };
  }

  function shortVenue(p) {
    const v = p.venue_full || p.venue || "";
    if (/arxiv/i.test(v) || /arxiv/i.test(p.venue || "")) return "arXiv preprint";
    if (/biorxiv/i.test(v)) return "bioRxiv";
    if (/medrxiv/i.test(v)) return "medRxiv";
    return v.replace(/\s*\d+\s*\(.*$/, "").replace(/,\s*\d.*$/, "").slice(0, 80);
  }

  // Generated cover for papers without an extractable figure.
  function placeholder(p, topics) {
    const t = topics[(p.topics || [])[0]];
    const c = t ? t.color : "#6d3fc0";
    let h = 0;
    for (const ch of p.title) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const rnd = () => ((h = (h * 1664525 + 1013904223) >>> 0) / 4294967296);
    let dots = "";
    for (let y = 0; y < 6; y++) for (let x = 0; x < 10; x++) {
      const r = 2 + rnd() * 9 * (1 - Math.abs(x - 4.5) / 9);
      dots += `<circle cx="${16 + x * 30}" cy="${18 + y * 30}" r="${r.toFixed(1)}" fill="${c}" opacity="${(0.15 + rnd() * 0.55).toFixed(2)}"/>`;
    }
    return `<svg viewBox="0 0 320 200" preserveAspectRatio="xMidYMid slice" role="img" aria-label="${esc(t ? t.title : "Publication")}">
      <rect width="320" height="200" fill="${c}" opacity=".08"/>${dots}
      <text x="16" y="186" font-family="Inter, sans-serif" font-size="13" font-weight="600" fill="${c}">${esc(t ? t.title : shortVenue(p))}</text></svg>`;
  }

  // ---------- research themes
  function renderThemes(site, papers, filters) {
    $("#themes").innerHTML = site.research.map((t) => {
      const ps = papers.filter((p) => (!p.kind || p.kind === "paper") && (p.topics || []).includes(t.id));
      const thumbs = ps.filter((p) => p.image).slice(0, 3).map((p) => `<img src="${esc(p.image)}" alt="" loading="lazy">`).join("");
      return `<button class="theme" data-topic="${t.id}" type="button">
        <span class="count"><span class="dot" style="background:${filters.topics[t.id].color}"></span> ${ps.length} papers</span>
        <h3>${esc(t.title)}</h3><p>${esc(t.blurb)}</p>
        ${thumbs ? `<div class="theme-thumbs">${thumbs}</div>` : ""}</button>`;
    }).join("");
    $("#themes").addEventListener("click", (e) => {
      const b = e.target.closest(".theme");
      if (!b) return;
      filters.setTopic(b.dataset.topic);
      $("#publications").scrollIntoView();
    });
  }

  // ---------- teaching & contact
  function renderTeaching(site) {
    $("#teach").innerHTML = (site.teaching || []).map((c) => `<div class="course"><h3>${esc(c.title)}</h3>
      <div class="terms">${esc(c.terms)}</div>
      <div class="links">${(c.links || []).map((l) => `<a href="${esc(l.url)}">${icon("link")}${esc(l.label)}</a>`).join("")}</div></div>`).join("");
    const c = site.contact;
    $("#contact-text").innerHTML = `${esc(c.text)} <a href="mailto:${esc(c.email)}">${esc(c.email)}</a>.`;
  }
})();
