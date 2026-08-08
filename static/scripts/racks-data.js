// Single source of truth for the 18 racks in V-101, shared by the floor plan
// and the two rack detail pages.
//
//   type: "std"    -> Top / Middle / Bottom shelves      (std_rack.html)
//   type: "server" -> Front side / Back side panels      (server_rack.html)
//   no type        -> no detail layout drawn yet
//
// The slot contents below are placeholders from the planning deck. Swap
// RACKS[n].layout in from the backend once real item classes exist.

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

// Default bay layouts, straight from the deck. "…" marks an unplanned slot.
const DEFAULT_LAYOUT = {
    std: [
        { name: "Top",    slots: ["Item class 1", "Item class 2", "…"] },
        { name: "Middle", slots: ["Item class 1", "Item class 2", "…"] },
        { name: "Bottom", slots: ["Item class 1", "Item class 2", "…"] },
    ],
    server: [
        { name: "Front side", slots: ["Item class 1", "Item class 2", "Item class 3", "…"] },
        { name: "Back side",  slots: ["Item class 1", "Item class 2", "Item class 3", "…"] },
    ],
};

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
