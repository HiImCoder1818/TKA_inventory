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

function connectLive() {
    if (!window.EVENTS_URL || liveSource) {
        return;
    }

    liveSource = new EventSource(window.EVENTS_URL);

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
    connectLive();
}

initLive();
