// Single source of truth for the 18 racks in V-101, shared by the floor plan
// and the two rack detail pages.
//
//   type: "std"    -> Top / Middle / Bottom shelves      (std_rack.html)
//   type: "server" -> Front side / Back side panels      (server_rack.html)
//   no type        -> no detail layout drawn yet
//
// ---------------------------------------------------------------------------
// Adding to a rack
// ---------------------------------------------------------------------------
// The shape is  rack -> bay -> item class -> items,  and each level is just a
// list, so growing any of them is an edit in one place:
//
//   * a new item      -> push a string onto a class's `items`
//   * a new class     -> push { name, items: [] } onto a bay's `slots`
//   * a new bay       -> push { name, slots: [] } onto the layout
//   * a whole rack    -> give it `layout: [...]` below to override the default
//
// A slot may also be written as a bare string ("Item class 4") when nothing is
// catalogued in it yet; normalizeSlot() below fills in the empty items list.
// An item is { name, qty } — or a bare string, which normalizeItem() reads as
// a quantity of 1. When items grow more fields (owner, part number), add them
// there and nothing else has to change.
// ---------------------------------------------------------------------------

const RACKS = {
    1:  { items: "Parts",               type: "server" },
    2:  { items: "Hardware" },
    3:  { items: "Hardware" },
    4:  { items: "Tournaments/Meets" },
    5:  { items: "Tournaments/Meets",   type: "std" },
    6:  { items: "Electronics/?",       type: "std" },
    7:  { items: "Engineering Class",   type: "std" },
    8:  { items: "Field Material" },
    9:  { items: "JH Class",            type: "std" },
    10: { items: "JH Class",            type: "std" },
    11: { items: "JH Class",            type: "std" },
    12: { items: "Outreach" },
    13: { items: "???",                 type: "std" },
    14: { items: "????",                type: "std" },
    15: { items: "Extrusions/Angles" },
    16: { items: "Panels Cart Design" },
    17: { items: "Tool Storage",        type: "server" },
    18: { items: "Stationery Supplies" },
};

// Bay layouts from the planning deck. The item names are placeholders so the
// index has something to show — replace them per rack via RACKS[n].layout.
const DEFAULT_LAYOUT = {
    std: [
        {
            name: "Top",
            slots: [
                {
                    name: "Item class 1",
                    items: [
                        { name: "Item 1", qty: 4 },
                        { name: "Item 2", qty: 12 },
                        { name: "Item 3", qty: 2 },
                    ],
                },
                {
                    name: "Item class 2",
                    items: [
                        { name: "Item 1", qty: 6 },
                        { name: "Item 2", qty: 1 },
                    ],
                },
                "…",
            ],
        },
        {
            name: "Middle",
            slots: [
                {
                    name: "Item class 1",
                    items: [
                        { name: "Item 1", qty: 8 },
                        { name: "Item 2", qty: 3 },
                    ],
                },
                {
                    name: "Item class 2",
                    items: [
                        { name: "Item 1", qty: 24 },
                        { name: "Item 2", qty: 5 },
                        { name: "Item 3", qty: 9 },
                    ],
                },
                "…",
            ],
        },
        {
            name: "Bottom",
            slots: [
                {
                    name: "Item class 1",
                    items: [
                        { name: "Item 1", qty: 2 },
                        { name: "Item 2", qty: 7 },
                    ],
                },
                {
                    name: "Item class 2",
                    items: [{ name: "Item 1", qty: 15 }],
                },
                "…",
            ],
        },
    ],
    server: [
        {
            name: "Front side",
            slots: [
                {
                    name: "Item class 1",
                    items: [
                        { name: "Item 1", qty: 10 },
                        { name: "Item 2", qty: 4 },
                        { name: "Item 3", qty: 1 },
                    ],
                },
                {
                    name: "Item class 2",
                    items: [
                        { name: "Item 1", qty: 6 },
                        { name: "Item 2", qty: 18 },
                    ],
                },
                {
                    name: "Item class 3",
                    items: [{ name: "Item 1", qty: 3 }],
                },
                "…",
            ],
        },
        {
            name: "Back side",
            slots: [
                {
                    name: "Item class 1",
                    items: [
                        { name: "Item 1", qty: 5 },
                        { name: "Item 2", qty: 2 },
                    ],
                },
                {
                    name: "Item class 2",
                    items: [
                        { name: "Item 1", qty: 11 },
                        { name: "Item 2", qty: 7 },
                        { name: "Item 3", qty: 20 },
                    ],
                },
                {
                    name: "Item class 3",
                    items: [
                        { name: "Item 1", qty: 1 },
                        { name: "Item 2", qty: 9 },
                    ],
                },
                "…",
            ],
        },
    ],
};

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
    if (!rack || !rack.type) {
        return null;
    }
    return rack.layout || DEFAULT_LAYOUT[rack.type];
}

// Where clicking rack `number` should go, or null if it has no detail page.
function rackHref(number) {
    const rack = RACKS[number];
    const routes = window.RACK_ROUTES || {};
    if (!rack || !rack.type || !routes[rack.type]) {
        return null;
    }
    return `${routes[rack.type]}?rack=${number}`;
}
