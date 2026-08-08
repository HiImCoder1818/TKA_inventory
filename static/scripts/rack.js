// Rack detail pages. Both std_rack.html and server_rack.html run this — the
// only difference is which bay layout the registry hands back, and whether
// .board lays the bays out as stacked shelves or side-by-side faces.
//
// Slot markup is deliberately uniform for both:
//
//   .bay          section, one shelf or one face
//     .bay__name  its caption
//     .bay__shelf the carcass; owns the scrollbar
//       .bay__track the run of slots; grows right (std) or down (server)
//         .slot     one item class
//
// The index mirrors that as a file tree, bay > item class > items:
//
//   .tree__group          one bay
//     .tree__node         one item class, a <details> dropdown
//       .tree__items      what's inside it
//
// Both sides key off the same data-slot, so hovering either highlights both.
// To add an item, edit racks-data.js — nothing here needs to change.

const board = document.querySelector(".board");
const bays = document.querySelector(".board__bays");
const tree = document.querySelector(".tree");

const params = new URLSearchParams(window.location.search);
const number = params.get("rack");
const rack = RACKS[number];
const layout = rackLayout(number);

function slotId(bayIndex, slotIndex) {
    return `${bayIndex}-${slotIndex}`;
}

function isPlaceholder(label) {
    return label === "…" || /^\?+$/.test(label);
}

function makeSlot(bayName, slot, id) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "slot";
    el.dataset.slot = id;
    el.textContent = slot.name;
    el.setAttribute("aria-label", `${bayName}, ${slot.name}, ${slot.items.length} items`);
    if (isPlaceholder(slot.name)) {
        el.classList.add("slot--empty");
    }
    return el;
}

function renderBays() {
    bays.innerHTML = "";

    layout.forEach((bay, bayIndex) => {
        const section = document.createElement("section");
        section.className = "bay";

        const name = document.createElement("span");
        name.className = "bay__name";
        name.textContent = bay.name;

        const shelf = document.createElement("div");
        shelf.className = "bay__shelf";

        const track = document.createElement("div");
        track.className = "bay__track";
        track.dataset.bay = String(bayIndex);

        bay.slots.forEach((raw, slotIndex) => {
            track.appendChild(makeSlot(bay.name, normalizeSlot(raw), slotId(bayIndex, slotIndex)));
        });

        shelf.appendChild(track);
        section.append(name, shelf);
        bays.appendChild(section);
    });
}

function makeNode(bayName, slot, id) {
    const node = document.createElement("details");
    node.className = "tree__node";
    node.dataset.slot = id;

    const summary = document.createElement("summary");
    summary.className = "tree__class";

    const label = document.createElement("span");
    label.className = "tree__class-name";
    label.textContent = slot.name;
    if (isPlaceholder(slot.name)) {
        label.classList.add("index__todo");
    }

    const count = document.createElement("span");
    count.className = "tree__count";
    count.textContent = String(slot.items.length);

    summary.append(label, count);

    const list = document.createElement("ul");
    list.className = "tree__items";

    if (slot.items.length) {
        slot.items.forEach((item) => {
            const li = document.createElement("li");
            li.className = "tree__item";
            li.textContent = itemLabel(item);
            list.appendChild(li);
        });
    } else {
        const li = document.createElement("li");
        li.className = "tree__item tree__item--empty";
        li.textContent = "Nothing catalogued yet";
        list.appendChild(li);
    }

    node.append(summary, list);
    return node;
}

function renderIndex() {
    tree.innerHTML = "";

    layout.forEach((bay, bayIndex) => {
        const group = document.createElement("section");
        group.className = "tree__group";

        const heading = document.createElement("h3");
        heading.className = "tree__group-name";
        heading.textContent = bay.name;
        group.appendChild(heading);

        bay.slots.forEach((raw, slotIndex) => {
            group.appendChild(makeNode(bay.name, normalizeSlot(raw), slotId(bayIndex, slotIndex)));
        });

        tree.appendChild(group);
    });
}

// Highlight an item class in the rack and the index at the same time. This is
// the only state a slot carries — clicking one is reserved for the level
// below, so it deliberately leaves no lingering highlight behind.
function link(slot) {
    document.querySelectorAll(".is-linked").forEach((el) => el.classList.remove("is-linked"));
    if (slot) {
        document.querySelectorAll(`[data-slot="${slot}"]`).forEach((el) => {
            el.classList.add("is-linked");
        });
    }
}

// Where the next level down hangs off. Left inert until those views exist.
function openSlot(/* slot */) {}

function wire(root) {
    if (!root) {
        return;
    }

    root.addEventListener("click", (event) => {
        // Let <summary> handle its own toggle; only rack slots reach openSlot.
        if (event.target.closest(".tree__class")) {
            return;
        }
        const target = event.target.closest("[data-slot]");
        if (target) {
            openSlot(target.dataset.slot);
        }
    });

    root.addEventListener("pointerover", (event) => {
        const target = event.target.closest("[data-slot]");
        link(target ? target.dataset.slot : null);
    });

    root.addEventListener("pointerleave", () => link(null));
}

if (!rack || !layout) {
    // Reached without a valid ?rack=N — say so instead of rendering an
    // empty frame the user can't interpret.
    board.classList.add("board--missing");
    board.innerHTML =
        '<p class="board__missing">No rack layout for this address. ' +
        '<a class="backlink" href="/">Back to the floor plan</a></p>';
} else {
    document.title = `Rack ${number} · ${rack.items} — TKA Inventory`;

    document.querySelectorAll("[data-fill='number']").forEach((el) => {
        el.textContent = number;
    });
    document.querySelectorAll("[data-fill='items']").forEach((el) => {
        el.textContent = rack.items;
    });

    renderBays();
    renderIndex();
    wire(board);
    wire(tree);
}
