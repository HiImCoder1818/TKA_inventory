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
//       "width": 0.5,            optional, standard racks: how wide this one
//                                is next to a full-width rack. Absent means 1.
//       "<level>": {             any key other than those two is a level:
//                                "front" / "back" / "top" / "level 4" / ...
//           "<item class>": {
//               "<item>": { "qty": 2 }
//           }
//       }
//   }
//
// A standard rack has as many levels as it has level keys, drawn top to
// bottom in file order; a server rack's are faces, drawn side by side.
// Adding a rack, a level, a class, an item or a quantity is an edit to
// inv.json alone — no code change, and nothing here needs to know the names
// in advance.
// ---------------------------------------------------------------------------

// Rack number -> label shown on the plan. Contents come from inv.json; a rack
// with no entry there simply has nothing to open yet.
const RACKS = {
    1:  { items: "Parts" },
    2:  { items: "Hardware" },
    3:  { items: "Hardware" },
    4:  { items: "Tournaments/Meets" },
    5:  { items: "Tournaments/Meets" },
    6:  { items: "Electronics/Misc" },
    7:  { items: "Engineering Class" },
    8:  { items: "Field Material" },
    9:  { items: "JH Class" },
    10: { items: "JH Class" },
    11: { items: "JH Class" },
    12: { items: "Outreach" },
    13: { items: "Extrusions/Angles" },
    14: { items: "Panels Cart Design" },
    15: { items: "Tool Storage" },
    16: { items: "Stationary Supplies" },
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

// A rack's own settings, as opposed to its contents. Every other key is a
// level, so front/back or top/middle/bottom or six numbered shelves all work
// without being listed anywhere.
const RACK_FIELDS = new Set(["type", "width"]);

// How wide a standard rack is drawn, as a fraction of a full-width one.
// Racks in the room aren't all the same size, and a half-width rack holding
// as much as a full one would be a drawing that lies.
const FULL_WIDTH = 1;

function parseWidth(value) {
    const width = Number(value);
    if (!Number.isFinite(width) || width <= 0) {
        return FULL_WIDTH;
    }
    return Math.min(width, FULL_WIDTH);
}

function parseBays(entry) {
    return Object.entries(entry)
        .filter(([key]) => !RACK_FIELDS.has(key))
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
        delete rack.width;
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
        rack.width = parseWidth(entry.width);
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
        headers: liveHeaders({ "Content-Type": "application/json" }),
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
        headers: liveHeaders({ "Content-Type": "application/json" }),
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
