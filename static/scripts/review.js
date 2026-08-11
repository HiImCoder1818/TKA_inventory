// The two read-only views onto requests:
//
//   Requests — what's still open, for whoever is in edit mode. Resolving one
//              takes it off the queue and stamps it in the history.
//   History  — everything ever asked for, resolved or not. Admin only, and
//              only in the interface: with no session the server can't tell
//              who is asking.
//
// Both are the same drawer as the cart, since they are the two sides of the
// same exchange.
//
// Resolving does not move stock. The counts on the shelves are still whatever
// someone last saved.

let reviewPanel = null;
let reviewList = null;
let historyPanel = null;
let historyList = null;

let openRequests = [];
let historyEntries = [];

// -------------------------------- helpers --------------------------------

function drawerError(panel, message) {
    const box = panel.querySelector(".drawer__error");
    box.hidden = !message;
    box.textContent = message || "";
}

async function getJson(url) {
    const response = await fetch(url, { cache: "no-store" });
    const body = await response.json();

    if (!response.ok) {
        throw new Error(body.error || `request failed (${response.status})`);
    }
    return Array.isArray(body) ? body : [];
}

function whenText(iso) {
    if (!iso) {
        return "";
    }
    const at = new Date(iso);
    return Number.isNaN(at.getTime()) ? iso : at.toLocaleString();
}

// A stored path is the raw inv.json keys; show them the way the rest of the
// app does rather than as they happen to be spelled in the file.
function pathTrail(path) {
    const [rackKey, ...rest] = path;
    const parsed = parseRackKey(rackKey);
    const rackLabel = parsed ? `${parsed.number} ${displayName(parsed.name)}` : rackKey;

    const trail = document.createElement("span");
    trail.className = "req-part__trail";

    [rackLabel, ...rest.map(displayName)].forEach((step, depth) => {
        if (depth) {
            const sep = document.createElement("i");
            sep.className = "req-part__sep";
            sep.textContent = "›";
            trail.append(sep);
        }
        const part = document.createElement("span");
        part.className = depth === rest.length ? "req-part__leaf" : "req-part__step";
        part.textContent = step;
        trail.append(part);
    });

    return trail;
}

// Shared card: who asked, what for, and their note.
function requestCard(entry) {
    const card = document.createElement("article");
    card.className = "req-card";

    const head = document.createElement("header");
    head.className = "req-card__head";

    const who = document.createElement("span");
    who.className = "req-card__who";
    who.textContent = entry.name;

    const when = document.createElement("span");
    when.className = "req-card__when";
    when.textContent = whenText(entry.at);

    head.append(who, when);
    card.append(head);

    const parts = document.createElement("ul");
    parts.className = "req-card__parts";

    (entry.parts || []).forEach((part) => {
        const li = document.createElement("li");
        li.className = "req-part";

        const qty = document.createElement("span");
        qty.className = "req-part__qty";
        qty.textContent = `×${part.qty}`;

        li.append(pathTrail(part.path || []), qty);
        parts.append(li);
    });

    card.append(parts);

    if (entry.note) {
        const note = document.createElement("p");
        note.className = "req-card__note";
        note.textContent = entry.note;
        card.append(note);
    }

    return card;
}

// ------------------------------- requests -------------------------------

function renderRequests() {
    document.querySelectorAll("[data-requests-count]").forEach((el) => {
        el.textContent = String(openRequests.length);
    });
    document.querySelectorAll("[data-open-requests]").forEach((el) => {
        el.classList.toggle("requests-btn--filled", openRequests.length > 0);
    });

    if (!reviewList) {
        return;
    }

    reviewList.innerHTML = "";
    reviewPanel.querySelector("[data-requests-empty]").hidden = openRequests.length > 0;

    openRequests.forEach((entry) => {
        const card = requestCard(entry);

        const resolve = document.createElement("button");
        resolve.type = "button";
        resolve.className = "req-card__resolve";
        resolve.textContent = "Resolve";
        resolve.addEventListener("click", () => resolveRequest(entry.id, resolve));
        card.querySelector(".req-card__head").append(resolve);

        reviewList.append(card);
    });
}

function refreshRequests() {
    return getJson(window.REQUESTS_URL)
        .then((entries) => {
            openRequests = entries;
            drawerError(reviewPanel, "");
            renderRequests();
        })
        .catch((error) => {
            console.error("requests:", error.message);
            drawerError(reviewPanel, error.message);
        });
}

function resolveRequest(id, button) {
    const label = button.textContent;
    button.disabled = true;
    button.textContent = "Resolving…";

    fetch(`${window.REQUESTS_URL}/${encodeURIComponent(id)}/resolve`, { method: "POST" })
        .then(async (response) => {
            const body = await response.json();
            if (!response.ok) {
                throw new Error(body.error || `could not resolve (${response.status})`);
            }
            return body;
        })
        .then(refreshRequests)
        .catch((error) => {
            console.error("requests:", error.message);
            drawerError(reviewPanel, error.message);
            button.disabled = false;
            button.textContent = label;
        });
}

// -------------------------------- history --------------------------------

function renderHistory() {
    document.querySelectorAll("[data-history-count]").forEach((el) => {
        el.textContent = String(historyEntries.length);
    });

    if (!historyList) {
        return;
    }

    historyList.innerHTML = "";
    historyPanel.querySelector("[data-history-empty]").hidden = historyEntries.length > 0;

    // Newest first — the log is appended to, but the recent end is the
    // interesting one.
    [...historyEntries].reverse().forEach((entry) => {
        const card = requestCard(entry);

        const state = document.createElement("span");
        if (entry.resolvedAt) {
            state.className = "req-card__state req-card__state--done";
            state.textContent = `Resolved ${whenText(entry.resolvedAt)}`;
        } else {
            state.className = "req-card__state req-card__state--open";
            state.textContent = "Open";
        }
        card.querySelector(".req-card__head").append(state);

        historyList.append(card);
    });
}

function refreshHistory() {
    return getJson(window.HISTORY_URL)
        .then((entries) => {
            historyEntries = entries;
            drawerError(historyPanel, "");
            renderHistory();
        })
        .catch((error) => {
            console.error("history:", error.message);
            drawerError(historyPanel, error.message);
        });
}

// --------------------------------- boot ---------------------------------

function initReview() {
    reviewPanel = document.querySelector(".review");
    reviewList = reviewPanel ? reviewPanel.querySelector(".review__list") : null;
    historyPanel = document.querySelector(".history");
    historyList = historyPanel ? historyPanel.querySelector(".history__list") : null;

    if (!reviewPanel || !historyPanel) {
        return;
    }

    // One drawer at a time, so they don't stack on top of each other.
    const show = (panel, refresh) => {
        closeDrawers();
        refresh();
        panel.hidden = false;
    };

    document.querySelectorAll("[data-open-requests]").forEach((el) => {
        el.addEventListener("click", () => show(reviewPanel, refreshRequests));
    });
    document.querySelectorAll("[data-close-requests]").forEach((el) => {
        el.addEventListener("click", () => { reviewPanel.hidden = true; });
    });
    document.querySelectorAll("[data-open-history]").forEach((el) => {
        el.addEventListener("click", () => show(historyPanel, refreshHistory));
    });
    document.querySelectorAll("[data-close-history]").forEach((el) => {
        el.addEventListener("click", () => { historyPanel.hidden = true; });
    });

    // Only the reviewing side needs the badge, and only once signed in.
    const maybeRefresh = () => {
        if (!currentAccount()) {
            closeDrawers();
            return;
        }
        if (document.body.dataset.mode === "edit") {
            refreshRequests();
        }
    };

    document.addEventListener("accountchange", maybeRefresh);
    document.addEventListener("modechange", maybeRefresh);
    maybeRefresh();
}

// Every drawer shares the slot on the right, so opening one closes the rest.
function closeDrawers() {
    document.querySelectorAll(".drawer").forEach((el) => {
        el.hidden = true;
    });
    document.body.classList.remove("has-cart-open");
}

initReview();
