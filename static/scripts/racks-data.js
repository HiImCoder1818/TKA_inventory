// Shared rack registry for the floor plan and the two rack detail pages.
//
// RACKS below is only the map of what sits where in V-101 — the numbers on the
// drawing and their labels. Everything else (which racks are stocked, their
// bays, item classes, items and quantities) comes from inv.json at runtime,
// via loadInventory().
//
// ---------------------------------------------------------------------------
// inv.json shape
// ---------------------------------------------------------------------------
//   "<number><name>": {          e.g. "1parts", "5Tournaments/Meets"
//       "type": "server" | "std",
//       "<bay>": {               any key other than "type" is a bay:
//                                "bins" / "top" / "middle" / "bottom" / ...
//           "<item class>": {
//               "<item>": { "qty": 2 }
//           }
//       }
//   }
//
// Bays render in the order they appear in the file. Adding a rack, a bay, a
// class, an item or a quantity is an edit to inv.json alone — no code change,
// and nothing here needs to know the names in advance.
// ---------------------------------------------------------------------------

// Rack number -> label shown on the plan. Contents come from inv.json; a rack
// with no entry there simply has nothing to open yet.
const RACKS = {
    1:  { items: "Parts" },
    2:  { items: "Hardware" },
    3:  { items: "Hardware" },
    4:  { items: "Tournaments/Meets" },
    5:  { items: "Tournaments/Meets" },
    6:  { items: "Electronics/?" },
    7:  { items: "Engineering Class" },
    8:  { items: "Field Material" },
    9:  { items: "JH Class" },
    10: { items: "JH Class" },
    11: { items: "JH Class" },
    12: { items: "Outreach" },
    13: { items: "???" },
    14: { items: "????" },
    15: { items: "Extrusions/Angles" },
    16: { items: "Panels Cart Design" },
    17: { items: "Tool Storage" },
    18: { items: "Stationery Supplies" },
};

// inv.json is written in lower case; the UI reads better with a leading cap.
// Anything already capitalised ("Tournaments/Meets") is left alone.
function displayName(text) {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

// "1parts" -> { number: 1, name: "parts" }; null if the key has no number.
function parseRackKey(key) {
    const match = /^(\d+)\s*(.*)$/.exec(key);
    if (!match) {
        return null;
    }
    return { number: Number(match[1]), name: match[2].trim() };
}

// Every level keeps its raw `key` next to the display `name`, because an edit
// has to address inv.json by the exact keys it was written with.

// { "item 1": { qty: 2 } } -> [{ key, name, qty }]
function parseItems(entry) {
    return Object.entries(entry || {}).map(([key, meta]) => ({
        key,
        name: displayName(key),
        qty: meta && meta.qty != null ? meta.qty : 1,
    }));
}

// { "item class 1": {...} } -> [{ key, name, items }]
function parseSlots(entry) {
    return Object.entries(entry || {}).map(([key, items]) => ({
        key,
        name: displayName(key),
        items: parseItems(items),
    }));
}

// Every key except "type" is a bay, so front/back or top/middle/bottom or
// anything added later all work without being listed here.
function parseBays(entry) {
    return Object.entries(entry)
        .filter(([key]) => key !== "type")
        .map(([key, slots]) => ({
            key,
            name: displayName(key),
            slots: parseSlots(slots),
        }));
}

// The last document we loaded, kept as it came off disk. The parsed RACKS
// tree is what the pages draw from, but anything that already speaks in raw
// inv.json keys — a stored request path, say — wants the document itself.
let rawInventory = {};

// How many of a raw ["1 parts", bay, class, item] path are on the shelf, or
// null when the path no longer points at anything.
function stockAt(path) {
    if (!Array.isArray(path) || path.length !== 4) {
        return null;
    }
    const [rack, bay, itemClass, item] = path;
    const found = rawInventory?.[rack]?.[bay]?.[itemClass]?.[item];
    return found && typeof found.qty === "number" ? found.qty : null;
}

// Fold inv.json into RACKS. Racks it doesn't mention keep their label and
// stay unopenable.
function applyInventory(raw) {
    rawInventory = raw || {};

    // Clear first, so a rack removed from inv.json stops being openable
    // without needing a page reload.
    Object.values(RACKS).forEach((rack) => {
        delete rack.key;
        delete rack.type;
        delete rack.layout;
    });

    Object.entries(raw).forEach(([key, entry]) => {
        const parsed = parseRackKey(key);
        if (!parsed || !entry) {
            return;
        }

        const rack = RACKS[parsed.number] || (RACKS[parsed.number] = {});
        if (parsed.name) {
            rack.items = displayName(parsed.name);
        }
        rack.key = key;
        rack.type = entry.type;
        rack.layout = parseBays(entry);
    });
}

async function loadInventory() {
    const response = await fetch(window.INVENTORY_URL, { cache: "no-store" });
    const body = await response.json();

    if (!response.ok) {
        throw new Error(body.error || `inventory request failed (${response.status})`);
    }

    applyInventory(body);
    return body;
}

// Commit staged quantity changes in one write. Each carries a delta rather
// than a total, so two people counting the same shelf add up instead of
// overwriting each other. Returns the stored counts.
async function saveQuantities(changes) {
    const response = await fetch(window.INVENTORY_QTY_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changes }),
    });
    const body = await response.json();

    if (!response.ok) {
        throw new Error(body.error || `save failed (${response.status})`);
    }
    return body.changes;
}

// One string that identifies an item across the staged list and the reply.
function itemKey(path) {
    return [path.rack, path.bay, path.itemClass, path.item].join(" ");
}

// Replace the whole document — the structural editor's save. The server
// validates the shape before writing, so a rejected edit changes nothing.
async function replaceInventory(data) {
    const response = await fetch(window.INVENTORY_URL, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
    });
    const body = await response.json();

    if (!response.ok) {
        throw new Error(body.error || `save failed (${response.status})`);
    }
    return body;
}

function rackLayout(number) {
    const rack = RACKS[number];
    if (!rack || !rack.type || !rack.layout || !rack.layout.length) {
        return null;
    }
    return rack.layout;
}

// Where clicking rack `number` should go, or null if inv.json has nothing
// stocked for it yet.
function rackHref(number) {
    const rack = RACKS[number];
    const routes = window.RACK_ROUTES || {};
    if (!rackLayout(number) || !routes[rack.type]) {
        return null;
    }
    return `${routes[rack.type]}?rack=${number}`;
}
