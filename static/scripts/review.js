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
// Quantities on an open request can be trimmed before it is filled; those
// edits are staged and written by Save, the same way stock edits are.
//
// Resolving removes the parts from stock. The history keeps what was asked
// for and, separately, what actually came off the shelf.

let reviewPanel = null;
let reviewList = null;
let reviewSave = null;
let historyPanel = null;
let historyList = null;

let openRequests = [];
let historyEntries = [];

// Staged quantity edits, keyed by request id + part path.
const staged = new Map();

function partKey(id, path) {
    return [id, ...path].join(" ");
}

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
function partTrail(path) {
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

// One part of a request. `editable` adds the steppers, which only the open
// queue wants — the history is a record and doesn't change.
function partRow(entry, part, editable) {
    const li = document.createElement("li");
    li.className = "req-part";

    const key = partKey(entry.id, part.path);
    const current = () => (staged.has(key) ? staged.get(key) : part.qty);

    const qty = document.createElement("span");
    qty.className = "req-part__qty";

    const sync = () => {
        const now = current();
        const stock = editable ? stockAt(part.path) : null;

        qty.textContent = `×${now}`;
        qty.classList.toggle("is-dirty", now !== part.qty);
        qty.title = now === part.qty ? "" : `Unsaved — was ×${part.qty}`;

        if (editable) {
            li.querySelector(".qty-btn--minus").disabled = now <= 1;
            li.querySelector(".qty-btn--plus").disabled = stock != null && now >= stock;
            // Say so when the queue is asking for more than the shelf holds.
            li.classList.toggle("req-part--short", stock != null && now > stock);
            li.dataset.stock = stock == null ? "" : `${stock} on hand`;
        }
    };

    // The count and its steppers travel as one block, so a long trail wraps
    // them together rather than stranding the buttons on their own line.
    const end = document.createElement("span");
    end.className = "req-part__end";
    end.append(qty);

    li.append(partTrail(part.path || []), end);

    if (editable) {
        const controls = document.createElement("span");
        controls.className = "req-part__controls";

        [-1, 1].forEach((delta) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = `qty-btn qty-btn--${delta > 0 ? "plus" : "minus"}`;
            button.textContent = delta > 0 ? "+" : "−";
            button.setAttribute("aria-label",
                `${delta > 0 ? "Add" : "Remove"} one ${part.path[3]}`);
            button.addEventListener("click", () => {
                // Never past the shelf: a request you can't fill isn't worth
                // staging. The server checks the same bound on save.
                const stock = stockAt(part.path);
                const ceiling = stock == null ? Infinity : Math.max(stock, 1);
                const next = Math.min(Math.max(1, current() + delta), ceiling);

                if (next === part.qty) {
                    staged.delete(key);
                } else {
                    staged.set(key, next);
                }
                sync();
                syncRequestSave();
            });
            controls.append(button);
        });

        end.append(controls);
    }

    // A resolved request records what came off the shelf as well as what was
    // asked for. They usually match; when they don't, the difference is the
    // interesting part of the record.
    const taken = (entry.fulfilled || [])
        .find((item) => String(item.path) === String(part.path));

    if (taken && taken.qty !== part.qty) {
        const note = document.createElement("span");
        note.className = "req-part__taken";
        note.textContent = `${taken.qty} filled`;
        end.prepend(note);
    }

    sync();
    return li;
}

// Shared card: who asked, what for, and their note.
function requestCard(entry, editable) {
    const card = document.createElement("article");
    card.className = "req-card";
    if (entry.id) {
        card.dataset.requestId = entry.id;
    }

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
        parts.append(partRow(entry, part, editable));
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
        const card = requestCard(entry, true);

        const resolve = document.createElement("button");
        resolve.type = "button";
        resolve.className = "req-card__resolve";
        resolve.textContent = "Resolve";
        resolve.addEventListener("click", () => resolveRequest(entry.id, resolve));
        card.querySelector(".req-card__head").append(resolve);

        reviewList.append(card);
    });

    syncRequestSave();
}

// The queue is read against stock, so both have to be current before it can
// be drawn. A failed stock read isn't fatal — the caps just go away and the
// server has the last word.
function refreshRequests() {
    staged.clear();

    return Promise.all([
        getJson(window.REQUESTS_URL),
        loadInventory().catch((error) => {
            console.warn("stock unavailable:", error.message);
        }),
    ])
        .then(([entries]) => {
            openRequests = entries;
            drawerError(reviewPanel, "");
            renderRequests();
        })
        .catch((error) => {
            console.error("requests:", error.message);
            drawerError(reviewPanel, error.message);
        });
}

// ------------------------------ staged edits ------------------------------

function isDirty(entry) {
    return (entry.parts || []).some((part) => staged.has(partKey(entry.id, part.path)));
}

function syncRequestSave() {
    if (!reviewSave) {
        return;
    }
    const count = staged.size;
    reviewSave.disabled = count === 0;
    reviewSave.classList.toggle("save-btn--dirty", count > 0);
    reviewSave.textContent = count === 0
        ? "No changes to save"
        : `Save ${count} change${count === 1 ? "" : "s"}`;

    // Resolving fills the saved numbers, so a card with unsaved edits can't
    // be resolved until they are written or dropped.
    openRequests.forEach((entry) => {
        const card = reviewList && reviewList.querySelector(`[data-request-id="${entry.id}"]`);
        const resolve = card && card.querySelector(".req-card__resolve");
        if (!resolve) {
            return;
        }
        const dirty = isDirty(entry);
        resolve.disabled = dirty;
        resolve.title = dirty ? "Save the quantity changes first" : "";
    });
}

function saveRequestQtys() {
    if (!staged.size) {
        return;
    }

    // Rebuild each change from the queue rather than from the key, so the
    // path we send is the one the server stored.
    const changes = [];
    openRequests.forEach((entry) => {
        (entry.parts || []).forEach((part) => {
            const key = partKey(entry.id, part.path);
            if (staged.has(key)) {
                changes.push({ id: entry.id, path: part.path, qty: staged.get(key) });
            }
        });
    });

    if (!changes.length) {
        staged.clear();
        syncRequestSave();
        return;
    }

    const label = reviewSave.textContent;
    reviewSave.disabled = true;
    reviewSave.textContent = "Saving…";

    fetch(window.REQUESTS_QTY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changes }),
    })
        .then(async (response) => {
            const body = await response.json();
            if (!response.ok) {
                throw new Error(body.error || `save failed (${response.status})`);
            }
            return body;
        })
        // Re-read rather than patching in place: the reply is the file, and
        // someone else may have resolved something while this was open.
        .then(refreshRequests)
        .then(syncRequestSave)
        .catch((error) => {
            console.error("requests:", error.message);
            drawerError(reviewPanel, error.message);
            reviewSave.disabled = false;
            reviewSave.textContent = label;
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
        .then(async (body) => {
            // Stock just moved, so whatever is on screen behind the drawer
            // is now out of date.
            document.dispatchEvent(new CustomEvent("inventorychange"));
            await refreshRequests();

            // The shelf can come up short between asking and filling; say
            // what actually came off it rather than pretending it matched.
            // After the refresh, or it clears the message it just set.
            const short = (body && body.short) || [];
            if (short.length) {
                const named = short
                    .map((item) => `${displayName(item.item)} (${item.taken} of ${item.wanted})`)
                    .join(", ");
                drawerError(reviewPanel, `Filled short on ${named} — that's all there was.`);
            }
        })
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
        const card = requestCard(entry, false);

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
    reviewSave = reviewPanel ? reviewPanel.querySelector("[data-save-requests]") : null;
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
    if (reviewSave) {
        reviewSave.addEventListener("click", saveRequestQtys);
    }
    document.querySelectorAll("[data-open-history]").forEach((el) => {
        el.addEventListener("click", () => show(historyPanel, refreshHistory));
    });
    document.querySelectorAll("[data-close-history]").forEach((el) => {
        el.addEventListener("click", () => { historyPanel.hidden = true; });
    });

    // Only the reviewing side needs the badge, and only once signed in.
    const maybeRefresh = () => {
        if (!currentAccount() || document.body.dataset.mode !== "edit") {
            // The queue belongs to the filling side; don't leave it open
            // behind a switch back to requesting, staged edits and all.
            staged.clear();
            closeDrawers();
            return;
        }
        refreshRequests();
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
