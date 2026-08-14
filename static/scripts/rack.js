// Rack detail pages. Both std_rack.html and server_rack.html run this — the
// only difference is which bay layout inv.json hands back, and whether .board
// lays the bays out as stacked shelves or side-by-side faces.
//
// The rack is drawn as:
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
//       .tree__items      what's inside it, each with +/- controls
//
// Both sides key off the same data-slot, so hovering either highlights both.
// Everything drawn here comes from inv.json — to add an item, edit that file.

const board = document.querySelector(".board");
const bays = document.querySelector(".board__bays");
const tree = document.querySelector(".tree");
const hint = document.querySelector(".panel__hint");
const hintText = hint ? hint.textContent : "";
const saveButton = document.querySelector("[data-save]");

const params = new URLSearchParams(window.location.search);
const number = params.get("rack");

// Filled in once inv.json has loaded.
let rack = null;
let layout = null;

// Every item in tree order, so the arrow keys have something to walk.
const entries = [];
let active = -1;

// A grid rack shows a count on the compartment as well as in the index, and
// both have to move together. Keyed by the raw inv.json path, since that is
// what the two sides have in common.
const cellsByPath = new Map();

function pathKey(bayKey, classKey, itemKey) {
    return [bayKey, classKey, itemKey].join(" ");
}

function slotId(bayIndex, slotIndex) {
    return `${bayIndex}-${slotIndex}`;
}

function isPlaceholder(label) {
    return label === "…" || /^\?+$/.test(label);
}

function say(message, isError) {
    if (!hint) {
        return;
    }
    hint.textContent = message || hintText;
    hint.classList.toggle("panel__hint--error", Boolean(isError));
}

// --------------------------------- rack ---------------------------------

function makeSlot(bayName, slot, id) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "slot";
    el.dataset.slot = id;
    el.textContent = slot.name;
    el.setAttribute("aria-label", `${bayName}, ${slot.name}, ${slot.items.length} items`);
    el.setAttribute("aria-expanded", "false");
    if (isPlaceholder(slot.name)) {
        el.classList.add("slot--empty");
    }
    return el;
}

// A block of small-part compartments, drawn as the grid it is: cols across by
// rows down, filled left to right in file order. Empty compartments are drawn
// too — the drawer has them whether or not anything is written on them yet.
//
// The block's caption is the .slot, so clicking it works the dropdown in the
// index the same as a shelf box does. The compartments sit outside it, since
// clicking one means "show me that part", not "collapse this block".
function makeGridSlot(bay, slot, id) {
    const block = document.createElement("section");
    block.className = "grid-slot";
    block.dataset.slot = id;

    const head = document.createElement("button");
    head.type = "button";
    head.className = "slot slot--grid";
    head.dataset.slot = id;
    head.setAttribute("aria-expanded", "false");

    const name = document.createElement("span");
    name.className = "grid-slot__name";
    name.textContent = slot.name;
    head.append(name);

    const cols = slot.cols || Math.max(slot.items.length, 1);
    const rows = slot.rows || Math.ceil(slot.items.length / cols) || 1;

    const shape = document.createElement("span");
    shape.className = "grid-slot__shape";
    shape.textContent = `${cols} × ${rows}`;
    head.append(shape);

    head.setAttribute("aria-label",
        `${bay.name}, ${slot.name}, ${cols} by ${rows}, ${slot.items.length} filled`);

    const cells = document.createElement("div");
    cells.className = "grid-slot__cells";
    cells.style.setProperty("--cols", String(cols));

    // Never hide stock: if more is stored here than the grid was drawn for,
    // the grid grows rather than dropping the overflow off the end.
    const total = Math.max(cols * rows, slot.items.length);

    for (let index = 0; index < total; index += 1) {
        const item = slot.items[index];

        if (!item) {
            const empty = document.createElement("div");
            empty.className = "cell cell--empty";
            cells.append(empty);
            continue;
        }

        const cell = document.createElement("button");
        cell.type = "button";
        cell.className = "cell";
        cell.dataset.bayKey = bay.key;
        cell.dataset.classKey = slot.key;
        cell.dataset.itemKey = item.key;
        cell.setAttribute("aria-label", `${item.name}, ${item.qty} in stock`);

        const label = document.createElement("span");
        label.className = "cell__name";
        label.textContent = item.name;

        const qty = document.createElement("span");
        qty.className = "cell__qty";
        qty.textContent = item.qty;

        cell.append(label, qty);
        cells.append(cell);
        cellsByPath.set(pathKey(bay.key, slot.key, item.key), { cell, qty });
    }

    block.append(head, cells);
    return block;
}

function renderBays() {
    bays.innerHTML = "";
    cellsByPath.clear();

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

        bay.slots.forEach((slot, slotIndex) => {
            const id = slotId(bayIndex, slotIndex);
            track.appendChild(rack.type === "grid"
                ? makeGridSlot(bay, slot, id)
                : makeSlot(bay.name, slot, id));
        });

        shelf.appendChild(track);
        section.append(name, shelf);
        bays.appendChild(section);
    });
}

// --------------------------------- index ---------------------------------

function makeStepper(entry, delta, label) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `qty-btn qty-btn--${delta > 0 ? "plus" : "minus"}`;
    button.textContent = delta > 0 ? "+" : "−";
    button.setAttribute("aria-label", `${label} one ${entry.item.name}`);
    button.addEventListener("click", (event) => {
        event.stopPropagation();
        setActive(entries.indexOf(entry), { focus: false });
        changeQty(entry, delta);
    });
    return button;
}

function makeItem(bay, slot, item, position) {
    const li = document.createElement("li");
    li.className = "tree__item";
    li.dataset.slot = slotId(position.bay, position.slot);
    li.tabIndex = -1;

    const name = document.createElement("span");
    name.className = "tree__item-name";
    name.textContent = item.name;

    // How many of this item we hold.
    const qty = document.createElement("span");
    qty.className = "tree__qty";
    qty.textContent = `×${item.qty}`;

    const controls = document.createElement("span");
    controls.className = "tree__controls";

    // Request mode's counterpart to the steppers: how many to put on the
    // request, rather than how many are on the shelf. CSS shows one or the
    // other off body[data-mode].
    const request = document.createElement("span");
    request.className = "tree__request";

    const entry = {
        el: li,
        qtyEl: qty,
        item,
        // The exact inv.json keys this row stands for.
        path: {
            rack: rack.key,
            bay: bay.key,
            itemClass: slot.key,
            item: item.key,
        },
        // What's on disk, versus what the staged edits show.
        saved: item.qty,
        qty: item.qty,
        minus: null,
        want: null,
        add: null,
    };

    const minus = makeStepper(entry, -1, "Remove");
    const plus = makeStepper(entry, 1, "Add");
    entry.minus = minus;
    controls.append(minus, plus);

    // You can't ask for what isn't there, so the box caps at the shelf count
    // and empty shelves have nothing to add.
    const want = document.createElement("input");
    want.type = "number";
    want.className = "tree__want";
    want.min = "1";
    want.value = "1";
    want.setAttribute("aria-label", `How many ${item.name} to request`);
    want.addEventListener("input", () => {
        const capped = Math.min(Math.max(1, Number(want.value) || 1), Math.max(entry.qty, 1));
        if (want.value !== "" && Number(want.value) !== capped) {
            want.value = String(capped);
        }
    });

    const addToCart = document.createElement("button");
    addToCart.type = "button";
    addToCart.className = "req-btn";
    addToCart.textContent = "Add";
    addToCart.setAttribute("aria-label", `Add ${item.name} to the request`);
    addToCart.addEventListener("click", (event) => {
        event.stopPropagation();
        if (entry.qty <= 0) {
            return;
        }
        cartAdd({
            rack: number,
            rackLabel: rack.items,
            bay: bay.key,
            bayName: bay.name,
            bin: slot.key,
            binName: slot.name,
            item: item.key,
            itemName: item.name,
            qty: Math.min(Math.max(1, Number(want.value) || 1), entry.qty),
            available: entry.qty,
        });
        want.value = "1";
    });

    entry.want = want;
    entry.add = addToCart;
    request.append(want, addToCart);

    li.append(name, qty, controls, request);
    li.addEventListener("click", () => setActive(entries.indexOf(entry), { focus: false }));

    entries.push(entry);
    syncEntry(entry);
    return li;
}

function makeNode(bay, slot, bayIndex, slotIndex) {
    const node = document.createElement("details");
    node.className = "tree__node";
    node.dataset.slot = slotId(bayIndex, slotIndex);

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
        slot.items.forEach((item, itemIndex) => {
            list.appendChild(makeItem(bay, slot, item, {
                bay: bayIndex,
                slot: slotIndex,
                item: itemIndex,
            }));
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
    entries.length = 0;

    layout.forEach((bay, bayIndex) => {
        const group = document.createElement("section");
        group.className = "tree__group";

        const heading = document.createElement("h3");
        heading.className = "tree__group-name";
        heading.textContent = bay.name;
        group.appendChild(heading);

        bay.slots.forEach((slot, slotIndex) => {
            group.appendChild(makeNode(bay, slot, bayIndex, slotIndex));
        });

        tree.appendChild(group);
    });
}

// ------------------------------ quantities ------------------------------

function syncEntry(entry) {
    const dirty = entry.qty !== entry.saved;

    entry.qtyEl.textContent = `×${entry.qty}`;
    entry.qtyEl.classList.toggle("is-dirty", dirty);
    entry.qtyEl.title = dirty ? `Unsaved — was ×${entry.saved}` : "";
    entry.el.classList.toggle("is-dirty", dirty);
    entry.minus.disabled = entry.qty <= 0;

    // Requests are bounded by the shelf, and the shelf moves.
    if (entry.want) {
        entry.want.max = String(Math.max(entry.qty, 1));
        if (Number(entry.want.value) > entry.qty) {
            entry.want.value = String(Math.max(entry.qty, 1));
        }
    }
    if (entry.add) {
        entry.add.disabled = entry.qty <= 0;
        entry.add.title = entry.qty <= 0 ? "None on hand" : "";
    }

    // On a grid rack the compartment carries the count too.
    const cell = cellsByPath.get(
        pathKey(entry.path.bay, entry.path.itemClass, entry.path.item));
    if (cell) {
        cell.qty.textContent = entry.qty;
        cell.cell.classList.toggle("is-dirty", dirty);
        cell.cell.classList.toggle("cell--out", entry.qty <= 0);
    }
}

function pendingChanges() {
    return entries
        .filter((entry) => entry.qty !== entry.saved)
        .map((entry) => ({ ...entry.path, delta: entry.qty - entry.saved }));
}

function syncSaveButton(state) {
    if (!saveButton) {
        return;
    }
    const count = pendingChanges().length;

    saveButton.disabled = state === "saving" || count === 0;
    saveButton.classList.toggle("save-btn--dirty", count > 0 && state !== "saving");
    saveButton.textContent =
        state === "saving" ? "Saving…" :
        count === 0 ? "No changes to save" :
        `Save ${count} change${count === 1 ? "" : "s"}`;
}

// Edits are staged, not written — nothing reaches inv.json until Save.
// Request mode is read-only, so the stock count never moves there.
function changeQty(entry, delta) {
    if (isRequestMode() || (entry.qty <= 0 && delta < 0)) {
        return;
    }
    entry.qty = Math.max(0, entry.qty + delta);
    syncEntry(entry);
    syncSaveButton();
}

function save() {
    const changes = pendingChanges();
    if (!changes.length) {
        return;
    }

    syncSaveButton("saving");

    saveQuantities(changes)
        .then((results) => {
            // Trust the stored counts over the staged ones.
            const stored = new Map(results.map((result) => [itemKey(result), result.qty]));
            entries.forEach((entry) => {
                const qty = stored.get(itemKey(entry.path));
                if (qty != null) {
                    entry.saved = qty;
                    entry.qty = qty;
                    entry.item.qty = qty;
                    syncEntry(entry);
                }
            });
            syncSaveButton();
            say(`Saved ${results.length} change${results.length === 1 ? "" : "s"}.`, false);

            // Our own write doesn't come back over the live connection, so
            // re-read for everything else on the page that reads stock —
            // the request caps and the cart.
            refreshInventory();
        })
        .catch((error) => {
            // The staged edits survive, so the count can be retried.
            console.error("inventory:", error.message);
            syncSaveButton();
            say(`Could not save — ${error.message}`, true);
        });
}

// ------------------------------ highlighting ------------------------------

// Hover highlight: an item class in the rack and the index at once.
function link(slot) {
    document.querySelectorAll(".is-linked").forEach((el) => el.classList.remove("is-linked"));
    if (slot) {
        document.querySelectorAll(`[data-slot="${slot}"]`).forEach((el) => {
            el.classList.add("is-linked");
        });
    }
}

// Keyboard cursor: the current item, plus the class and bay it sits in.
function setActive(next, options = {}) {
    document.querySelectorAll(".is-active").forEach((el) => el.classList.remove("is-active"));
    document.querySelectorAll(".is-section").forEach((el) => el.classList.remove("is-section"));

    active = next;
    if (active < 0 || active >= entries.length) {
        return;
    }

    const entry = entries[active];
    const node = entry.el.closest(".tree__node");
    const group = entry.el.closest(".tree__group");

    entry.el.classList.add("is-active");
    if (node) {
        node.open = true;
        node.classList.add("is-section");
    }
    if (group) {
        group.classList.add("is-section");
    }
    document.querySelectorAll(`.slot[data-slot="${entry.el.dataset.slot}"]`).forEach((el) => {
        el.classList.add("is-section");
    });

    if (options.focus !== false) {
        entry.el.focus({ preventScroll: true });
    }
    entry.el.scrollIntoView({ block: "nearest" });
}

function move(step) {
    if (!entries.length) {
        return;
    }
    if (active < 0) {
        setActive(step > 0 ? 0 : entries.length - 1);
        return;
    }
    setActive(Math.min(entries.length - 1, Math.max(0, active + step)));
}

function wire(root) {
    if (!root) {
        return;
    }

    root.addEventListener("click", (event) => {
        // A compartment on a grid rack means "show me that part": it opens
        // its block and puts the cursor on the row, where the count and the
        // controls are.
        const cell = event.target.closest(".cell");
        if (cell && cell.dataset.itemKey) {
            const found = entries.findIndex((entry) =>
                entry.path.bay === cell.dataset.bayKey
                && entry.path.itemClass === cell.dataset.classKey
                && entry.path.item === cell.dataset.itemKey);
            if (found >= 0) {
                setActive(found, { focus: false });
            }
            return;
        }

        // Only the box on the rack toggles a class. In the index the class
        // header is a <summary> that toggles itself, and item rows carry the
        // same data-slot for hover-linking — matching those too would
        // collapse the whole class from under whatever you just clicked.
        const box = event.target.closest(".slot");
        if (box) {
            toggleSlot(box.dataset.slot);
        }
    });

    root.addEventListener("pointerover", (event) => {
        const target = event.target.closest("[data-slot]");
        link(target ? target.dataset.slot : null);
    });

    root.addEventListener("pointerleave", () => link(null));
}

// Clicking an item class on the rack works the dropdown in the index, so the
// big box and the tree row are two handles on the same thing.
function toggleSlot(slot) {
    const node = document.querySelector(`.tree__node[data-slot="${slot}"]`);
    if (!node) {
        return;
    }
    node.open = !node.open;

    document.querySelectorAll(`.slot[data-slot="${slot}"]`).forEach((el) => {
        el.setAttribute("aria-expanded", String(node.open));
    });

    if (node.open) {
        node.scrollIntoView({ block: "nearest" });
    }
}

// Keep the rack box in step when the dropdown is worked from the index side.
function syncSlotState(node) {
    document.querySelectorAll(`.slot[data-slot="${node.dataset.slot}"]`).forEach((el) => {
        el.setAttribute("aria-expanded", String(node.open));
    });
}

// ↑/↓ walk every item in tree order, opening classes as they are reached;
// +/− adjust whichever item the cursor is on.
function wireKeyboard() {
    document.addEventListener("keydown", (event) => {
        if (event.metaKey || event.ctrlKey || event.altKey) {
            return;
        }
        // Never steal keys from the search box.
        if (event.target.closest("input, textarea, [contenteditable]")) {
            return;
        }

        switch (event.key) {
            case "ArrowDown":
                event.preventDefault();
                move(1);
                break;
            case "ArrowUp":
                event.preventDefault();
                move(-1);
                break;
            // Stock keys are edit-mode only; CSS hides the steppers there but
            // the keyboard needs telling as well.
            case "+":
            case "=":
                if (active >= 0 && !isRequestMode()) {
                    event.preventDefault();
                    changeQty(entries[active], 1);
                }
                break;
            case "-":
            case "_":
                if (active >= 0 && !isRequestMode()) {
                    event.preventDefault();
                    changeQty(entries[active], -1);
                }
                break;
            case "Escape":
                setActive(-1);
                break;
            default:
                break;
        }
    });
}

// Staged counts live only in the page, so leaving would lose them.
function wireSave() {
    if (saveButton) {
        saveButton.addEventListener("click", save);
    }

    window.addEventListener("beforeunload", (event) => {
        if (pendingChanges().length) {
            event.preventDefault();
            event.returnValue = "";
        }
    });
}

// --------------------------------- boot ---------------------------------

// Say what went wrong rather than leaving an empty frame the reader can't
// interpret — a bad ?rack=N and an unreachable inv.json look the same
// otherwise.
function showMessage(text) {
    board.classList.add("board--missing");
    board.innerHTML =
        `<p class="board__missing">${text} ` +
        '<a class="backlink" href="/">Back to the floor plan</a></p>';
}

function render() {
    document.title = `Rack ${number} · ${rack.items} — TKA Inventory`;

    document.querySelectorAll("[data-fill='number']").forEach((el) => {
        el.textContent = number;
    });
    document.querySelectorAll("[data-fill='items']").forEach((el) => {
        el.textContent = rack.items;
    });
    // Name the bays inv.json actually gave us rather than assuming a shape.
    document.querySelectorAll("[data-fill='bays']").forEach((el) => {
        el.textContent = layout.map((bay) => bay.name).join(" / ");
    });

    // How wide this rack stands next to a full-width one. The shelves are
    // drawn to it, so a half-width rack looks half as wide and scrolls twice
    // as soon rather than pretending to hold as much as its neighbour.
    board.style.setProperty("--rack-w", String(rack.width ?? 1));

    renderBays();
    renderIndex();
    wire(board);
    wire(tree);
    wireKeyboard();
    wireSave();
    syncSaveButton();

    tree.querySelectorAll(".tree__node").forEach((node) => {
        node.addEventListener("toggle", () => syncSlotState(node));
    });
}

// Arriving from a search hit: open the class it named, and put the cursor on
// the item if it named one.
function focusFromQuery() {
    const bay = params.get("bay");
    const bin = params.get("bin");
    const item = params.get("item");

    if (!bay) {
        return;
    }

    if (item) {
        const found = entries.findIndex((entry) =>
            entry.path.bay === bay && entry.path.itemClass === bin && entry.path.item === item);
        if (found >= 0) {
            setActive(found);
            return;
        }
    }

    const bayIndex = layout.findIndex((entry) => entry.key === bay);
    if (bayIndex < 0) {
        return;
    }
    const binIndex = bin ? layout[bayIndex].slots.findIndex((slot) => slot.key === bin) : -1;

    const target = binIndex >= 0
        ? document.querySelector(`.tree__node[data-slot="${slotId(bayIndex, binIndex)}"]`)
        : document.querySelector(`.tree__group:nth-of-type(${bayIndex + 1})`);

    if (target) {
        if (target.tagName === "DETAILS") {
            target.open = true;
        }
        target.scrollIntoView({ block: "nearest" });
    }
}

// The shelf moved: a request was filled, or someone counted the same bin on
// another machine. Update the counts in place rather than redrawing — a
// redraw would throw away whatever is expanded and wherever the cursor is.
function syncEntriesFromStock() {
    entries.forEach((entry) => {
        const stored = stockAt([
            entry.path.rack, entry.path.bay, entry.path.itemClass, entry.path.item,
        ]);
        if (stored == null) {
            return;
        }
        // Read dirtiness before moving the baseline under it: an edit in
        // progress is someone's count of the shelf, and it stays staged
        // rather than being overwritten by what arrived.
        const wasStaged = entry.qty !== entry.saved;

        entry.item.qty = stored;
        entry.saved = stored;
        if (!wasStaged) {
            entry.qty = stored;
        }
        syncEntry(entry);
    });

    syncSaveButton();
}

document.addEventListener("inventorychange", syncEntriesFromStock);

loadInventory()
    .then(() => {
        rack = RACKS[number];
        layout = rackLayout(number);

        if (!rack) {
            showMessage(`No rack ${number} in V-101.`);
        } else if (!layout) {
            showMessage(`Rack ${number} has nothing stocked in inv.json yet.`);
        } else {
            render();
            initSearch();
            focusFromQuery();
        }
    })
    .catch((error) => {
        console.error("inventory:", error.message);
        showMessage(`Inventory unavailable — ${error.message}.`);
    });
