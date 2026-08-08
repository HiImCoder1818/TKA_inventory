// Rack detail pages. Both std_rack.html and server_rack.html run this — the
// only difference is which bay layout the registry hands back, and whether
// .board is laid out as stacked shelves or side-by-side panels.

const board = document.querySelector(".board");
const bays = document.querySelector(".board__bays");
const indexBody = document.querySelector(".index tbody");

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

        bay.slots.forEach((label, slotIndex) => {
            const slot = document.createElement("button");
            slot.type = "button";
            slot.className = "slot";
            slot.dataset.slot = slotId(bayIndex, slotIndex);
            slot.textContent = label;
            slot.setAttribute("aria-label", `${bay.name}, ${label}`);
            if (isPlaceholder(label)) {
                slot.classList.add("slot--empty");
            }
            shelf.appendChild(slot);
        });

        section.append(name, shelf);
        bays.appendChild(section);
    });
}

function renderIndex() {
    indexBody.innerHTML = "";

    layout.forEach((bay, bayIndex) => {
        bay.slots.forEach((label, slotIndex) => {
            const row = document.createElement("tr");
            row.dataset.slot = slotId(bayIndex, slotIndex);

            const where = document.createElement("th");
            where.scope = "row";
            where.textContent = bay.name;

            const what = document.createElement("td");
            what.textContent = label;
            if (isPlaceholder(label)) {
                what.className = "index__todo";
            }

            row.append(where, what);
            indexBody.appendChild(row);
        });
    });
}

// Highlight a slot in the board and the index at the same time.
function link(slot) {
    document.querySelectorAll(".is-linked").forEach((el) => el.classList.remove("is-linked"));
    if (slot) {
        document.querySelectorAll(`[data-slot="${slot}"]`).forEach((el) => {
            el.classList.add("is-linked");
        });
    }
}

function select(slot) {
    document.querySelectorAll(".slot").forEach((el) => {
        el.setAttribute("aria-pressed", String(el.dataset.slot === slot));
    });
    document.querySelectorAll(".index tbody tr").forEach((row) => {
        row.setAttribute("aria-selected", String(row.dataset.slot === slot));
    });
}

function wire(root) {
    if (!root) {
        return;
    }

    root.addEventListener("click", (event) => {
        const target = event.target.closest("[data-slot]");
        if (target) {
            select(target.dataset.slot);
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
    wire(indexBody);
}
