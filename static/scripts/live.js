// The live connection.
//
// Two people work this inventory at once: someone counting a shelf and
// someone filling requests from it. Without this, each of them is looking at
// whatever was true when their page loaded, and finds out otherwise by
// reloading or by being told.
//
// The server holds a stream open per page and says "this changed" whenever a
// file moves. Nothing is pushed down it but names — pages re-read through the
// endpoints they already use, so there is one way to load a thing rather than
// two that can drift apart.
//
// What arrives is a hint to re-read, never an instruction to overwrite. A
// count someone is part-way through typing is theirs until they save it; the
// refresh moves the baseline underneath and leaves the edit staged.

// Who we are, so the server can skip echoing our own writes back to us. It
// lives for the life of the page: a reload is a new listener with nothing
// staged to protect.
const CLIENT_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

let liveSource = null;
let liveChip = null;
// The first connection is the page loading, which has already read
// everything. Every one after it is a reconnection that missed whatever
// happened while it was down.
let hasConnected = false;

// Stamp on any request that changes something, so its own echo can be
// dropped rather than triggering a redundant re-read.
function liveHeaders(headers) {
    return { ...(headers || {}), "X-Client-Id": CLIENT_ID };
}

function setLiveState(state, title) {
    if (!liveChip) {
        return;
    }
    liveChip.dataset.state = state;
    liveChip.title = title;
    liveChip.querySelector(".live__label").textContent =
        state === "on" ? "Live" : "Reconnecting…";
}

// One event for everything that moved, so a fill — which changes the queue,
// the shelf and the log at once — lands as a single refresh rather than
// three overlapping ones.
//
// The shelf is the exception: `inventorychange` promises that the loaded
// inventory is already current, so its listeners read rather than fetch and
// one change costs one request no matter how many parts of the page care.
function announceChange(changed) {
    document.dispatchEvent(new CustomEvent("datachange", { detail: { changed } }));

    if (changed.includes("inventory")) {
        refreshInventory();
    }
}

function refreshInventory() {
    return loadInventory()
        .then(() => {
            document.dispatchEvent(new CustomEvent("inventorychange"));
        })
        .catch((error) => {
            console.error("live: could not re-read the inventory —", error.message);
        });
}

// ------------------------------- notices -------------------------------

// A message addressed to whoever is signed in on this page: their request
// filled, or turned down.
//
// It stays until it is dismissed, and nothing else takes it away — not a
// reload, not a new tab, not closing the browser. The server holds the
// unread ones and hands them over when a page connects, so a message sent
// while somebody was away is waiting when they come back. Dismissing is the
// one thing that removes it, and it removes it everywhere.

function noticeText(notice) {
    if (notice.kind === "declined") {
        return {
            tone: "declined",
            title: "Request declined",
            body: notice.reason
                ? notice.reason
                : "No reason was given. Ask whoever handles the stores.",
        };
    }

    const short = notice.short || [];
    const items = notice.items || 0;
    const counted = `${items} item${items === 1 ? "" : "s"}`;

    if (short.length) {
        const named = short
            .map((item) => `${displayName(item.item)} (${item.taken} of ${item.wanted})`)
            .join(", ");
        return {
            tone: "part",
            title: "Request resolved — partly",
            body: `${counted} ready to collect. Short on ${named}.`,
        };
    }

    return {
        tone: "done",
        title: "Request resolved",
        body: `Your parts are ready to collect — ${counted}.`,
    };
}

function noticeCard(notice) {
    const { tone, title, body } = noticeText(notice);

    const card = document.createElement("article");
    card.className = `notice notice--${tone}`;
    card.dataset.noticeId = notice.id || "";

    const heading = document.createElement("p");
    heading.className = "notice__title";
    heading.textContent = title;

    const text = document.createElement("p");
    text.className = "notice__body";
    text.textContent = body;

    const when = document.createElement("p");
    when.className = "notice__when";
    when.textContent = noticeWhen(notice.at);

    const close = document.createElement("button");
    close.type = "button";
    close.className = "notice__close";
    close.textContent = "×";
    close.setAttribute("aria-label", "Dismiss");
    close.addEventListener("click", () => dismissNotice(notice.id, card));

    card.append(heading, text, when, close);
    return card;
}

// One waiting since yesterday shouldn't read the same as one that just
// landed, now that they keep.
function noticeWhen(iso) {
    if (!iso) {
        return "";
    }
    const at = new Date(iso);
    return Number.isNaN(at.getTime()) ? iso : at.toLocaleString();
}

// Dismissing is a real write: the notice is gone for good, on every screen.
// The card goes straight away — putting a message away shouldn't wait on the
// network — and comes back if the server disagrees.
function dismissNotice(id, card) {
    card.classList.add("notice--going");
    window.setTimeout(() => card.remove(), 200);

    if (!id || !window.NOTICES_URL) {
        return;
    }

    fetch(`${window.NOTICES_URL}/${encodeURIComponent(id)}/dismiss`,
        { method: "POST", headers: liveHeaders() })
        .then((response) => {
            // A 404 means it was already dismissed elsewhere, which is the
            // outcome we wanted anyway.
            if (!response.ok && response.status !== 404) {
                throw new Error(`dismiss failed (${response.status})`);
            }
        })
        .catch((error) => {
            console.error("notices:", error.message);
            card.classList.remove("notice--going");
            const tray = document.querySelector(".notices");
            if (tray && !card.isConnected) {
                tray.append(card);
            }
        });
}

// One new message. Ignore one we're already showing — a reconnection re-sends
// everything still unread.
function showNotice(notice) {
    const tray = document.querySelector(".notices");
    if (!tray || (notice.id && tray.querySelector(`[data-notice-id="${notice.id}"]`))) {
        return;
    }
    tray.append(noticeCard(notice));
}

// The full set of what's unread, which is what a page gets on connecting.
// Replacing rather than merging is what makes a dismissal on one screen show
// up on another.
function showNotices(notices) {
    const tray = document.querySelector(".notices");
    if (!tray) {
        return;
    }

    tray.innerHTML = "";
    notices.forEach((notice) => tray.append(noticeCard(notice)));
}

// -------------------------------- stream --------------------------------

// The stream is opened per signed-in name, so a message meant for one person
// reaches their screen. Signing in or out reopens it under the new name.
function streamUrl() {
    const account = currentAccount();
    if (!account || !account.name) {
        return window.EVENTS_URL;
    }
    return `${window.EVENTS_URL}?who=${encodeURIComponent(account.name)}`;
}

function reconnectLive() {
    if (liveSource) {
        liveSource.close();
        liveSource = null;
    }

    // Whose messages these are is about to change. Clear them now rather
    // than leaving the last person's on screen if the reconnect is slow —
    // they are on the server, so nothing is lost by dropping the cards.
    showNotices([]);

    // A reopened stream is a fresh connection, not a recovery: the page
    // already has what it needs, so don't make it re-read everything.
    hasConnected = false;
    connectLive();
}

function connectLive() {
    if (!window.EVENTS_URL || liveSource) {
        return;
    }

    liveSource = new EventSource(streamUrl());

    liveSource.addEventListener("notice", (event) => {
        try {
            showNotice(JSON.parse(event.data));
        } catch (error) {
            console.warn("live: could not read a notice", error);
        }
    });

    // Everything still unread, sent on connecting.
    liveSource.addEventListener("notices", (event) => {
        try {
            showNotices(JSON.parse(event.data) || []);
        } catch (error) {
            console.warn("live: could not read the waiting notices", error);
        }
    });

    liveSource.addEventListener("ready", () => {
        setLiveState("on", "Updating as others make changes");

        // Catch up on whatever happened while the connection was down. The
        // stream carries no backlog, so the only safe assumption is that
        // everything moved.
        if (hasConnected) {
            announceChange(["inventory", "requests", "history"]);
        }
        hasConnected = true;
    });

    liveSource.addEventListener("message", (event) => {
        let payload;
        try {
            payload = JSON.parse(event.data);
        } catch (error) {
            console.warn("live: could not read an update", error);
            return;
        }

        // We already applied our own change when its reply came back.
        if (payload.origin && payload.origin === CLIENT_ID) {
            return;
        }
        announceChange(payload.changed || []);
    });

    // EventSource reconnects on its own; this only reflects that in the top
    // bar, so a stale page looks stale rather than merely quiet.
    liveSource.addEventListener("error", () => {
        setLiveState("off", "Lost the connection — trying again");
    });
}

function initLive() {
    liveChip = document.querySelector(".live");
    setLiveState("off", "Connecting…");

    // Who this page is signed in as decides which messages are for it, so a
    // sign-in or sign-out reopens the stream under the new name.
    document.addEventListener("accountchange", reconnectLive);

    connectLive();
}

initLive();
