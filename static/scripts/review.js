// The open-requests queue, for whoever is in edit mode.
//
// Requesters fill a cart in request.js and send it; this is the other side of
// that — reading requests.json, showing what was asked for and by whom, and
// resolving one when it has been dealt with.
//
// Resolving only takes the request off the queue. Moving the stock that went
// with it is a separate step and isn't wired up, so the counts on the shelves
// are still whatever someone last saved.

let reviewDialog = null;
let reviewBody = null;
let reviewError = null;
let openRequests = [];

// -------------------------------- loading --------------------------------

async function fetchRequests() {
    const response = await fetch(window.REQUESTS_URL, { cache: "no-store" });
    const body = await response.json();

    if (!response.ok) {
        throw new Error(body.error || `could not read requests (${response.status})`);
    }
    return Array.isArray(body) ? body : [];
}

function showReviewError(message) {
    reviewError.hidden = !message;
    reviewError.textContent = message || "";
}

function refreshRequests() {
    return fetchRequests()
        .then((entries) => {
            openRequests = entries;
            showReviewError("");
            renderReview();
        })
        .catch((error) => {
            console.error("requests:", error.message);
            showReviewError(error.message);
        });
}

// ------------------------------- rendering -------------------------------

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
    const rackLabel = parsed
        ? `${parsed.number} ${displayName(parsed.name)}`
        : rackKey;

    const trail = document.createElement("span");
    trail.className = "review-part__trail";

    [rackLabel, ...rest.map(displayName)].forEach((step, depth) => {
        if (depth) {
            const sep = document.createElement("i");
            sep.className = "review-part__sep";
            sep.textContent = "›";
            trail.append(sep);
        }
        const part = document.createElement("span");
        part.className = depth === rest.length ? "review-part__leaf" : "review-part__step";
        part.textContent = step;
        trail.append(part);
    });

    return trail;
}

function reviewCard(entry) {
    const card = document.createElement("article");
    card.className = "review-card";

    const head = document.createElement("header");
    head.className = "review-card__head";

    const who = document.createElement("span");
    who.className = "review-card__who";
    who.textContent = entry.name;

    const when = document.createElement("span");
    when.className = "review-card__when";
    when.textContent = whenText(entry.at);

    const resolve = document.createElement("button");
    resolve.type = "button";
    resolve.className = "review-card__resolve";
    resolve.textContent = "Resolve";
    resolve.addEventListener("click", () => resolveRequest(entry.id, resolve));

    head.append(who, when, resolve);
    card.append(head);

    const parts = document.createElement("ul");
    parts.className = "review-card__parts";

    (entry.parts || []).forEach((part) => {
        const li = document.createElement("li");
        li.className = "review-part";

        const qty = document.createElement("span");
        qty.className = "review-part__qty";
        qty.textContent = `×${part.qty}`;

        li.append(pathTrail(part.path || []), qty);
        parts.append(li);
    });

    card.append(parts);

    if (entry.note) {
        const note = document.createElement("p");
        note.className = "review-card__note";
        note.textContent = entry.note;
        card.append(note);
    }

    return card;
}

function renderReview() {
    document.querySelectorAll("[data-requests-count]").forEach((el) => {
        el.textContent = String(openRequests.length);
    });
    document.querySelectorAll("[data-open-requests]").forEach((el) => {
        el.classList.toggle("requests-btn--filled", openRequests.length > 0);
    });

    if (!reviewBody) {
        return;
    }

    reviewBody.innerHTML = "";

    if (!openRequests.length) {
        const empty = document.createElement("p");
        empty.className = "review__empty";
        empty.textContent = "No open requests.";
        reviewBody.append(empty);
        return;
    }

    openRequests.forEach((entry) => reviewBody.append(reviewCard(entry)));
}

// ------------------------------- resolving -------------------------------

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
            showReviewError(error.message);
            button.disabled = false;
            button.textContent = label;
        });
}

// --------------------------------- boot ---------------------------------

function initReview() {
    reviewDialog = document.querySelector(".review");
    reviewBody = reviewDialog ? reviewDialog.querySelector(".review__body") : null;
    reviewError = reviewDialog ? reviewDialog.querySelector(".review__error") : null;

    if (!reviewDialog) {
        return;
    }

    document.querySelectorAll("[data-open-requests]").forEach((el) => {
        el.addEventListener("click", () => {
            refreshRequests();
            reviewDialog.showModal();
        });
    });
    document.querySelectorAll("[data-close-requests]").forEach((el) => {
        el.addEventListener("click", () => reviewDialog.close());
    });

    // Only the reviewing side needs the count, and only once signed in.
    const maybeRefresh = () => {
        if (currentAccount() && document.body.dataset.mode === "edit") {
            refreshRequests();
        }
    };

    document.addEventListener("accountchange", maybeRefresh);
    document.addEventListener("modechange", maybeRefresh);
    maybeRefresh();
}

initReview();
