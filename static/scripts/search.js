// Search box in the top bar. Matches loosely — the query's characters only
// have to appear in order, so "itm1" still finds "item 1" — and lists hits as
// the path you'd walk to reach them: 1 Parts › front › item class 1 › item 1.
//
// Everything indexed comes from RACKS after inv.json has loaded, so the index
// covers every rack from any page.

const MAX_HITS = 8;

let searchInput = null;
let resultsBox = null;
let index = [];
let hits = [];
let cursor = -1;

// --------------------------------- index ---------------------------------

function buildIndex() {
    const entries = [];

    Object.keys(RACKS).forEach((number) => {
        const rack = RACKS[number];
        if (!rack.layout || !rack.layout.length) {
            return;
        }

        const rackLabel = `${number} ${rack.items}`;
        entries.push({ number, trail: [rackLabel], target: rack.items, path: {} });

        rack.layout.forEach((bay) => {
            entries.push({
                number,
                trail: [rackLabel, bay.name],
                target: bay.name,
                path: { bay: bay.key },
            });

            bay.slots.forEach((slot) => {
                entries.push({
                    number,
                    trail: [rackLabel, bay.name, slot.name],
                    target: slot.name,
                    path: { bay: bay.key, bin: slot.key },
                });

                slot.items.forEach((item) => {
                    entries.push({
                        number,
                        trail: [rackLabel, bay.name, slot.name, item.name],
                        target: item.name,
                        qty: item.qty,
                        path: { bay: bay.key, bin: slot.key, item: item.key },
                    });
                });
            });
        });
    });

    return entries;
}

// -------------------------------- matching --------------------------------

// Score a loose match: every query character must appear in order. Runs of
// adjacent characters and matches at the start of a word score higher, so
// "item 1" beats "i-t-e-m scattered 1" for the query "item1".
function fuzzy(query, text) {
    const needle = query.toLowerCase();
    const hay = text.toLowerCase();

    const marks = [];
    let at = 0;
    let score = 0;
    let run = 0;

    for (let i = 0; i < hay.length && at < needle.length; i += 1) {
        if (hay[i] !== needle[at]) {
            run = 0;
            continue;
        }

        run += 1;
        score += 10 + run * 5;
        if (i === 0 || /[\s\-_/.]/.test(hay[i - 1])) {
            score += 15;
        }
        marks.push(i);
        at += 1;
    }

    if (at < needle.length) {
        return null;
    }

    // All else equal, a shorter name is the better match.
    return { score: score - hay.length * 0.2, marks };
}

function search(query) {
    const trimmed = query.trim();
    if (!trimmed) {
        return [];
    }

    const scored = [];
    index.forEach((entry) => {
        // Prefer a hit on the name itself; fall back to the whole path so
        // "parts item 1" finds its way there too.
        const direct = fuzzy(trimmed, entry.target);
        if (direct) {
            scored.push({ entry, score: direct.score + 40, marks: direct.marks });
            return;
        }

        const whole = fuzzy(trimmed, entry.trail.join(" "));
        if (whole) {
            scored.push({ entry, score: whole.score, marks: null });
        }
    });

    scored.sort((a, b) => b.score - a.score || a.entry.trail.length - b.entry.trail.length);
    return scored.slice(0, MAX_HITS);
}

// -------------------------------- rendering --------------------------------

// The matched characters, picked out of the name.
function markUp(text, marks) {
    const fragment = document.createDocumentFragment();
    if (!marks) {
        fragment.append(text);
        return fragment;
    }

    const wanted = new Set(marks);
    let run = "";
    let marked = false;

    const flush = () => {
        if (!run) {
            return;
        }
        if (marked) {
            const mark = document.createElement("mark");
            mark.textContent = run;
            fragment.append(mark);
        } else {
            fragment.append(run);
        }
        run = "";
    };

    for (let i = 0; i < text.length; i += 1) {
        const isMark = wanted.has(i);
        if (isMark !== marked) {
            flush();
            marked = isMark;
        }
        run += text[i];
    }
    flush();

    return fragment;
}

function renderHits() {
    resultsBox.innerHTML = "";

    if (!hits.length) {
        resultsBox.hidden = true;
        return;
    }

    hits.forEach((hit, position) => {
        const { entry } = hit;

        const row = document.createElement("button");
        row.type = "button";
        row.className = "search-hit";
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", String(position === cursor));
        row.dataset.position = String(position);

        const trail = document.createElement("span");
        trail.className = "search-hit__trail";

        entry.trail.forEach((step, depth) => {
            if (depth) {
                const sep = document.createElement("i");
                sep.className = "search-hit__sep";
                sep.textContent = "›";
                trail.append(sep);
            }

            const last = depth === entry.trail.length - 1;
            const part = document.createElement("span");
            part.className = last ? "search-hit__leaf" : "search-hit__step";
            part.append(last ? markUp(step, hit.marks) : step);
            trail.append(part);
        });

        row.append(trail);

        if (entry.qty != null) {
            const qty = document.createElement("span");
            qty.className = "search-hit__qty";
            qty.textContent = `×${entry.qty}`;
            row.append(qty);
        }

        row.addEventListener("click", () => openHit(position));
        resultsBox.append(row);
    });

    resultsBox.hidden = false;
}

// -------------------------------- behaviour --------------------------------

// Deep-link the rack page straight to what was picked.
function hrefFor(entry) {
    const base = rackHref(entry.number);
    if (!base) {
        return null;
    }

    const params = new URLSearchParams();
    Object.entries(entry.path).forEach(([key, value]) => params.set(key, value));

    const query = params.toString();
    return query ? `${base}&${query}` : base;
}

function openHit(position) {
    const hit = hits[position];
    if (!hit) {
        return;
    }
    const href = hrefFor(hit.entry);
    if (href) {
        window.location.href = href;
    }
}

function closeResults() {
    hits = [];
    cursor = -1;
    resultsBox.hidden = true;
    resultsBox.innerHTML = "";
}

function moveCursor(step) {
    if (!hits.length) {
        return;
    }
    cursor = (cursor + step + hits.length) % hits.length;
    resultsBox.querySelectorAll(".search-hit").forEach((row, position) => {
        row.setAttribute("aria-selected", String(position === cursor));
        if (position === cursor) {
            row.scrollIntoView({ block: "nearest" });
        }
    });
}

function initSearch() {
    searchInput = document.querySelector(".search");
    resultsBox = document.querySelector(".search-results");
    if (!searchInput || !resultsBox) {
        return;
    }

    index = buildIndex();

    searchInput.addEventListener("input", () => {
        hits = search(searchInput.value);
        cursor = hits.length ? 0 : -1;
        renderHits();
    });

    searchInput.addEventListener("keydown", (event) => {
        switch (event.key) {
            case "ArrowDown":
                event.preventDefault();
                moveCursor(1);
                break;
            case "ArrowUp":
                event.preventDefault();
                moveCursor(-1);
                break;
            case "Enter":
                if (cursor >= 0) {
                    event.preventDefault();
                    openHit(cursor);
                }
                break;
            case "Escape":
                closeResults();
                break;
            default:
                break;
        }
    });

    searchInput.addEventListener("focus", () => {
        if (searchInput.value.trim()) {
            hits = search(searchInput.value);
            cursor = hits.length ? 0 : -1;
            renderHits();
        }
    });

    document.addEventListener("click", (event) => {
        if (!event.target.closest(".topbar__actions")) {
            closeResults();
        }
    });
}
