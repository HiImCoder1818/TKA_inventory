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

        bay.slots.forEach((slot, slotIndex) => {
            track.appendChild(makeSlot(bay.name, slot, slotId(bayIndex, slotIndex)));
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
    };

    const minus = makeStepper(entry, -1, "Remove");
    const plus = makeStepper(entry, 1, "Add");
    entry.minus = minus;
    controls.append(minus, plus);

    li.append(name, qty, controls);
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
function changeQty(entry, delta) {
    if (entry.qty <= 0 && delta < 0) {
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
        // Let <summary> and the steppers handle their own clicks.
        if (event.target.closest(".tree__class, .qty-btn")) {
            return;
        }
        const target = event.target.closest("[data-slot]");
        if (target) {
            toggleSlot(target.dataset.slot);
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
            case "+":
            case "=":
                if (active >= 0) {
                    event.preventDefault();
                    changeQty(entries[active], 1);
                }
                break;
            case "-":
            case "_":
                if (active >= 0) {
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
        }
    })
    .catch((error) => {
        console.error("inventory:", error.message);
        showMessage(`Inventory unavailable — ${error.message}.`);
    });
