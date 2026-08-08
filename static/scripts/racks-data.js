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

// { "item 1": { qty: 2 } } -> [{ name, qty }]
function parseItems(entry) {
    return Object.entries(entry || {}).map(([name, meta]) => ({
        name: displayName(name),
        qty: meta && meta.qty != null ? meta.qty : 1,
    }));
}

// { "item class 1": {...} } -> [{ name, items }]
function parseSlots(entry) {
    return Object.entries(entry || {}).map(([name, items]) => ({
        name: displayName(name),
        items: parseItems(items),
    }));
}

// Every key except "type" is a bay, so front/back or top/middle/bottom or
// anything added later all work without being listed here.
function parseBays(entry) {
    return Object.entries(entry)
        .filter(([key]) => key !== "type")
        .map(([name, slots]) => ({
            name: displayName(name),
            slots: parseSlots(slots),
        }));
}

// Fold inv.json into RACKS. Racks it doesn't mention keep their label and
// stay unopenable.
function applyInventory(raw) {
    Object.entries(raw).forEach(([key, entry]) => {
        const parsed = parseRackKey(key);
        if (!parsed || !entry) {
            return;
        }

        const rack = RACKS[parsed.number] || (RACKS[parsed.number] = {});
        if (parsed.name) {
            rack.items = displayName(parsed.name);
        }
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

// Accept either "Item class 4" or { name, items } so a class can be added
// before its contents are known.
function normalizeSlot(slot) {
    if (typeof slot === "string") {
        return { name: slot, items: [] };
    }
    return { name: slot.name, items: slot.items || [] };
}

// Accept either "Item 1" or { name, qty }. A bare string counts as one.
function normalizeItem(item) {
    if (typeof item === "string") {
        return { name: item, qty: 1 };
    }
    return { name: item.name, qty: item.qty == null ? 1 : item.qty };
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
