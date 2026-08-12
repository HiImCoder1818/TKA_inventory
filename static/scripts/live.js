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
// filled, or turned down. It arrives while they are looking at something
// else, so it announces itself and then gets out of the way.
const NOTICE_MS = 12000;

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

function showNotice(notice) {
    const tray = document.querySelector(".notices");
    if (!tray) {
        return;
    }

    const { tone, title, body } = noticeText(notice);

    const card = document.createElement("article");
    card.className = `notice notice--${tone}`;

    const heading = document.createElement("p");
    heading.className = "notice__title";
    heading.textContent = title;

    const text = document.createElement("p");
    text.className = "notice__body";
    text.textContent = body;

    const close = document.createElement("button");
    close.type = "button";
    close.className = "notice__close";
    close.textContent = "×";
    close.setAttribute("aria-label", "Dismiss");

    const dismiss = () => {
        card.classList.add("notice--going");
        // Let it fade rather than vanish, but don't depend on the animation
        // firing to actually remove it.
        window.setTimeout(() => card.remove(), 200);
    };

    close.addEventListener("click", dismiss);
    card.append(heading, text, close);
    tray.append(card);

    window.setTimeout(dismiss, NOTICE_MS);
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
