// Structural editor for inv.json, opened from the floor plan's Edit button.
//
// It shows the file as a tree — rack > bay > item class > item — where every
// level can be added to or removed. inv.json is written as key/value objects,
// which have no order once you start renaming keys, so the editor works on an
// array mirror instead and serialises back on save:
//
//   [{ number, name, type, bays: [{ key, classes: [{ key, items: [{ key, qty }] }] }] }]
//
// Nothing is written until Save; Cancel throws the working copy away.

const dialog = document.querySelector(".editor");
const body = dialog ? dialog.querySelector(".editor__body") : null;
const errorBox = dialog ? dialog.querySelector(".editor__errors") : null;

let model = [];
let onSaved = null;

// ------------------------------ model ------------------------------

// The live inventory -> the array mirror the editor edits.
function toModel(raw) {
    return Object.entries(raw).map(([rackKey, rack]) => {
        const parsed = parseRackKey(rackKey) || { number: "", name: rackKey };
        return {
            number: String(parsed.number),
            name: parsed.name,
            type: rack.type,
            bays: Object.entries(rack)
                .filter(([key]) => key !== "type")
                .map(([bayKey, bay]) => ({
                    key: bayKey,
                    classes: Object.entries(bay).map(([classKey, itemClass]) => ({
                        key: classKey,
                        items: Object.entries(itemClass).map(([itemKey, item]) => ({
                            key: itemKey,
                            qty: item && item.qty != null ? item.qty : 0,
                        })),
                    })),
                })),
        };
    });
}

// The array mirror -> the shape inv.json stores.
function toInventory() {
    const out = {};
    model.forEach((rack) => {
        const entry = { type: rack.type };
        rack.bays.forEach((bay) => {
            const bins = {};
            bay.classes.forEach((itemClass) => {
                const items = {};
                itemClass.items.forEach((item) => {
                    items[item.key.trim()] = { qty: Number(item.qty) || 0 };
                });
                bins[itemClass.key.trim()] = items;
            });
            entry[bay.key.trim()] = bins;
        });
        out[`${rack.number}${rack.name.trim()}`] = entry;
    });
    return out;
}

// Duplicate keys would silently swallow each other once serialised, so they
// are caught here rather than after the fact.
function findProblems() {
    const problems = [];
    const seenRacks = new Set();

    model.forEach((rack) => {
        const label = rack.name.trim() ? `Rack ${rack.number} ${rack.name.trim()}` : `Rack ${rack.number}`;

        if (!rack.number) {
            problems.push("A rack has no number.");
        } else if (seenRacks.has(rack.number)) {
            problems.push(`Rack ${rack.number} is listed twice.`);
        }
        seenRacks.add(rack.number);

        if (!rack.name.trim()) {
            problems.push(`${label} has no name.`);
        }

        const seenBays = new Set();
        rack.bays.forEach((bay) => {
            const bayName = bay.key.trim();
            if (!bayName) {
                problems.push(`${label} has a section with no name.`);
            } else if (seenBays.has(bayName)) {
                problems.push(`${label} has two sections called "${bayName}".`);
            }
            seenBays.add(bayName);

            const seenClasses = new Set();
            bay.classes.forEach((itemClass) => {
                const className = itemClass.key.trim();
                if (!className) {
                    problems.push(`${label} / ${bayName} has a bin with no name.`);
                } else if (seenClasses.has(className)) {
                    problems.push(`${label} / ${bayName} has two bins called "${className}".`);
                }
                seenClasses.add(className);

                const seenItems = new Set();
                itemClass.items.forEach((item) => {
                    const itemName = item.key.trim();
                    if (!itemName) {
                        problems.push(`${label} / ${bayName} / ${className} has an item with no name.`);
                    } else if (seenItems.has(itemName)) {
                        problems.push(`${label} / ${bayName} / ${className} has two items called "${itemName}".`);
                    }
                    seenItems.add(itemName);
                });
            });
        });
    });

    return problems;
}

// ------------------------------ rendering ------------------------------

function button(text, className, title, onClick) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = className;
    el.textContent = text;
    el.title = title;
    el.setAttribute("aria-label", title);
    el.addEventListener("click", onClick);
    return el;
}

function textField(value, placeholder, onInput) {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "editor__name";
    input.value = value;
    input.placeholder = placeholder;
    input.addEventListener("input", () => onInput(input.value));
    return input;
}

function rackNumberField(rack) {
    const select = document.createElement("select");
    select.className = "editor__number";
    select.setAttribute("aria-label", "Rack number");

    // Only the racks drawn on the plan, so an entry can't end up orphaned.
    Object.keys(RACKS)
        .sort((a, b) => a - b)
        .forEach((number) => {
            const option = document.createElement("option");
            option.value = number;
            option.textContent = `${number} — ${RACKS[number].items}`;
            option.disabled = model.some((other) => other !== rack && other.number === number);
            select.appendChild(option);
        });

    select.value = rack.number;
    select.addEventListener("change", () => {
        rack.number = select.value;
        render();
    });
    return select;
}

function typeField(rack) {
    const select = document.createElement("select");
    select.className = "editor__type";
    select.setAttribute("aria-label", "Rack type");

    [
        ["std", "Standard rack"],
        ["server", "Server rack"],
    ].forEach(([value, label]) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        select.appendChild(option);
    });

    select.value = rack.type;
    select.addEventListener("change", () => {
        rack.type = select.value;
    });
    return select;
}

// data-path addresses a row by its position in the tree ("0.1.2" = rack 0,
// section 1, bin 2), which keeps every level reachable without guesswork.
function row(depth, path, ...children) {
    const el = document.createElement("div");
    el.className = `editor__row editor__row--${depth}`;
    el.dataset.level = depth;
    el.dataset.path = path;
    el.append(...children);
    return el;
}

function branch(...children) {
    const el = document.createElement("div");
    el.className = "editor__branch";
    el.append(...children);
    return el;
}

function renderItem(itemClass, item, path) {
    const qty = document.createElement("input");
    qty.type = "number";
    qty.className = "editor__qty";
    qty.min = "0";
    qty.step = "1";
    qty.value = String(item.qty);
    qty.setAttribute("aria-label", "Quantity");
    qty.addEventListener("input", () => {
        item.qty = Math.max(0, Number(qty.value) || 0);
    });

    return row(
        "item",
        path,
        textField(item.key, "item name", (value) => { item.key = value; }),
        qty,
        button("−", "editor__btn editor__btn--remove", "Remove this item", () => {
            itemClass.items.splice(itemClass.items.indexOf(item), 1);
            render();
        }),
    );
}

function renderClass(bay, itemClass, path) {
    const header = row(
        "class",
        path,
        textField(itemClass.key, "bin name", (value) => { itemClass.key = value; }),
        button("+", "editor__btn editor__btn--add", "Add an item to this bin", () => {
            itemClass.items.push({ key: "new item", qty: 0 });
            render(`item:${itemClass.items.length - 1}`);
        }),
        button("−", "editor__btn editor__btn--remove", "Remove this bin", () => {
            bay.classes.splice(bay.classes.indexOf(itemClass), 1);
            render();
        }),
    );

    const items = itemClass.items.map((item, index) =>
        renderItem(itemClass, item, `${path}.${index}`));
    if (!items.length) {
        const empty = document.createElement("p");
        empty.className = "editor__empty";
        empty.textContent = "No items yet.";
        items.push(empty);
    }

    return branch(header, branch(...items));
}

function renderBay(rack, bay, path) {
    const header = row(
        "bay",
        path,
        textField(bay.key, "section name", (value) => { bay.key = value; }),
        button("+", "editor__btn editor__btn--add", "Add a bin to this section", () => {
            bay.classes.push({ key: "new bin", items: [] });
            render();
        }),
        button("−", "editor__btn editor__btn--remove", "Remove this section", () => {
            rack.bays.splice(rack.bays.indexOf(bay), 1);
            render();
        }),
    );

    const classes = bay.classes.map((itemClass, index) =>
        renderClass(bay, itemClass, `${path}.${index}`));
    if (!classes.length) {
        const empty = document.createElement("p");
        empty.className = "editor__empty";
        empty.textContent = "No bins yet.";
        classes.push(empty);
    }

    return branch(header, branch(...classes));
}

function renderRack(rack, path) {
    const header = row(
        "rack",
        path,
        rackNumberField(rack),
        textField(rack.name, "rack name", (value) => { rack.name = value; }),
        typeField(rack),
        button("+", "editor__btn editor__btn--add", "Add a section to this rack", () => {
            rack.bays.push({ key: "new section", classes: [] });
            render();
        }),
        button("−", "editor__btn editor__btn--remove", "Remove this rack", () => {
            model.splice(model.indexOf(rack), 1);
            render();
        }),
    );

    const bays = rack.bays.map((bay, index) =>
        renderBay(rack, bay, `${path}.${index}`));
    if (!bays.length) {
        const empty = document.createElement("p");
        empty.className = "editor__empty";
        empty.textContent = "No sections yet.";
        bays.push(empty);
    }

    const el = branch(header, branch(...bays));
    el.classList.add("editor__rack");
    return el;
}

// Structural edits redraw; typing does not, so fields keep focus.
function render() {
    body.innerHTML = "";

    if (!model.length) {
        const empty = document.createElement("p");
        empty.className = "editor__empty";
        empty.textContent = "No racks yet — add one below.";
        body.appendChild(empty);
        return;
    }

    model.forEach((rack, index) => body.appendChild(renderRack(rack, String(index))));
}

function showProblems(problems) {
    errorBox.hidden = !problems.length;
    errorBox.textContent = problems.join(" ");
}

// ------------------------------ open / save ------------------------------

function firstFreeRackNumber() {
    const used = new Set(model.map((rack) => rack.number));
    const free = Object.keys(RACKS).sort((a, b) => a - b).find((number) => !used.has(number));
    return free || "1";
}

function addRack() {
    const number = firstFreeRackNumber();
    model.push({
        number,
        name: (RACKS[number] || {}).items || "new rack",
        type: "std",
        bays: [],
    });
    render();
    body.lastElementChild.scrollIntoView({ block: "nearest" });
}

function save(saveButton) {
    const problems = findProblems();
    if (problems.length) {
        showProblems(problems);
        return;
    }
    showProblems([]);

    const label = saveButton.textContent;
    saveButton.disabled = true;
    saveButton.textContent = "Saving…";

    replaceInventory(toInventory())
        .then(() => {
            dialog.close();
            if (onSaved) {
                onSaved();
            }
        })
        .catch((error) => {
            console.error("inventory:", error.message);
            showProblems([error.message]);
        })
        .finally(() => {
            saveButton.disabled = false;
            saveButton.textContent = label;
        });
}

function open() {
    // Edit a copy, so Cancel really does discard.
    loadInventory()
        .then((raw) => {
            model = toModel(JSON.parse(JSON.stringify(raw)));
            showProblems([]);
            render();
            dialog.showModal();
        })
        .catch((error) => {
            console.error("inventory:", error.message);
            window.alert(`Inventory unavailable — ${error.message}`);
        });
}

function initEditor(options = {}) {
    if (!dialog) {
        return;
    }
    onSaved = options.onSaved;

    document.querySelectorAll("[data-open-editor]").forEach((el) => {
        el.addEventListener("click", open);
    });
    dialog.querySelectorAll("[data-close-editor]").forEach((el) => {
        el.addEventListener("click", () => dialog.close());
    });
    dialog.querySelectorAll("[data-add-rack]").forEach((el) => {
        el.addEventListener("click", addRack);
    });
    dialog.querySelectorAll("[data-editor-save]").forEach((el) => {
        el.addEventListener("click", () => save(el));
    });
}
