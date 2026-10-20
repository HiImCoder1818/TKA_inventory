// Structural editor for inv.json, opened from the floor plan's Edit button.
//
// It shows the file as a tree — rack > level > item class > item — where every
// level can be added to or removed. inv.json is written as key/value objects,
// which have no order once you start renaming keys, so the editor works on an
// array mirror instead and serialises back on save:
//
//   [{ number, name, type, width, bays: [{ key, classes: [{ key, items: [{ key, qty }] }] }] }]
//
// A standard rack has however many levels it has rows, and a width relative to
// a full-width rack; a server rack has faces instead, and no width — they sit
// side by side and fill what they're given.
//
// Saving happens in two steps, because two people edit this at once.
//
// Save puts the working copy aside on the server as a draft and shows what
// applying it would do. Apply folds it into inv.json — and folds, rather than
// replaces: the server works out what you changed against the document you
// opened, and lays only that over whatever is on disk now. So two people
// tidying different racks both keep their work, and the one who saves second
// no longer undoes the first.
//
// A field you have both changed is the one case that can't be reconciled.
// Those are listed before you apply, and yours is the one that sticks.
//
// The draft outlives the dialog, the tab and the browser, so a reload picks up
// where you left off instead of starting again. Cancel leaves it waiting;
// Discard throws it away.

const dialog = document.querySelector(".editor");
const body = dialog ? dialog.querySelector(".editor__body") : null;
const errorBox = dialog ? dialog.querySelector(".editor__errors") : null;
const review = dialog ? dialog.querySelector("[data-review]") : null;
const draftNote = dialog ? dialog.querySelector("[data-draft-note]") : null;

let model = [];
let onSaved = null;

// The document this editing session started from. The server needs it to tell
// what we changed apart from what everyone else changed.
let baseline = {};

// ------------------------------ model ------------------------------

// The live inventory -> the array mirror the editor edits.
function toModel(raw) {
    return Object.entries(raw).map(([rackKey, rack]) => {
        const parsed = parseRackKey(rackKey) || { number: "", name: rackKey };
        // Everything starts collapsed: a full inventory is hundreds of rows,
        // and the counts on each row say what's inside without opening it.
        return {
            number: String(parsed.number),
            name: parsed.name,
            type: rack.type,
            width: rack.width == null ? 1 : Number(rack.width),
            open: false,
            bays: Object.entries(rack)
                .filter(([key]) => !RACK_FIELDS.has(key))
                .map(([bayKey, bay]) => ({
                    key: bayKey,
                    open: false,
                    classes: Object.entries(bay).map(([classKey, itemClass]) => ({
                        key: classKey,
                        open: false,
                        cols: itemClass.cols == null ? "" : String(itemClass.cols),
                        rows: itemClass.rows == null ? "" : String(itemClass.rows),
                        items: Object.entries(itemClass)
                            .filter(([itemKey]) => !SLOT_FIELDS.has(itemKey))
                            .map(([itemKey, item]) => ({
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
        // Full width is the default, so it stays out of the file.
        if (rack.type === "std" && Number(rack.width) !== 1) {
            entry.width = Number(rack.width);
        }
        rack.bays.forEach((bay) => {
            const bins = {};
            bay.classes.forEach((itemClass) => {
                const items = {};
                // The compartment grid, on a rack that has one. Written ahead
                // of the items so the shape reads first in the file.
                if (rack.type === "grid") {
                    ["cols", "rows"].forEach((field) => {
                        const size = parseInt(itemClass[field], 10);
                        if (Number.isFinite(size) && size > 0) {
                            items[field] = size;
                        }
                    });
                }
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

// How many compartments across and down a block of small parts is arranged
// in. Blank means "however many it takes to hold what's in it".
function gridField(itemClass, field, label) {
    const input = document.createElement("input");
    input.type = "number";
    input.className = "editor__grid";
    input.min = "1";
    input.value = itemClass[field] || "";
    input.placeholder = label;
    input.title = `Compartments ${label}`;
    input.setAttribute("aria-label", `Compartments ${label}`);
    input.addEventListener("input", () => { itemClass[field] = input.value; });
    return input;
}

function typeField(rack) {
    const select = document.createElement("select");
    select.className = "editor__type";
    select.setAttribute("aria-label", "Rack type");

    [
        ["std", "Standard rack"],
        ["server", "Server rack"],
        ["grid", "Small parts grid"],
    ].forEach(([value, label]) => {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = label;
        select.appendChild(option);
    });

    select.value = rack.type;
    select.addEventListener("change", () => {
        rack.type = select.value;
        // Width only means something for stacked shelves; a server rack's
        // faces sit side by side and fill what they're given.
        render();
    });
    return select;
}

// How wide this rack is next to a full-width one. Named fractions rather than
// a free number, because that is how the racks get described out loud.
const RACK_WIDTHS = [
    [1, "Full width"],
    [0.75, "¾ width"],
    [0.667, "⅔ width"],
    [0.5, "½ width"],
    [0.333, "⅓ width"],
];

function widthField(rack) {
    const select = document.createElement("select");
    select.className = "editor__width";
    select.setAttribute("aria-label", "Rack width");

    RACK_WIDTHS.forEach(([value, label]) => {
        const option = document.createElement("option");
        option.value = String(value);
        option.textContent = label;
        select.appendChild(option);
    });

    // A width set by hand in inv.json that isn't one of the named fractions
    // still has to be selectable, or opening the editor would silently round
    // it to the nearest option on save.
    const current = Number(rack.width) || 1;
    if (!RACK_WIDTHS.some(([value]) => value === current)) {
        const option = document.createElement("option");
        option.value = String(current);
        option.textContent = `${Math.round(current * 100)}% width`;
        select.appendChild(option);
    }

    select.value = String(current);
    select.addEventListener("change", () => {
        rack.width = Number(select.value);
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

// Disclosure triangle. `open` lives on the model entry, so a redraw after an
// add or remove doesn't throw the reader back to the top of the tree.
function caret(entry) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "editor__caret";
    el.textContent = "▸";
    el.setAttribute("aria-expanded", String(Boolean(entry.open)));
    el.setAttribute("aria-label", entry.open ? "Collapse" : "Expand");
    el.addEventListener("click", () => {
        entry.open = !entry.open;
        render();
    });
    return el;
}

// What a collapsed row is hiding.
function tally(total, noun) {
    const el = document.createElement("span");
    el.className = "editor__count";
    el.textContent = `${total} ${noun}${total === 1 ? "" : "s"}`;
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

function renderClass(rack, bay, itemClass, path) {
    const fields = [
        caret(itemClass),
        textField(itemClass.key, "bin name", (value) => { itemClass.key = value; }),
    ];

    // On a grid rack a bin is a block of compartments, so it carries the
    // shape it is arranged in as well as what's in it.
    if (rack.type === "grid") {
        fields.push(
            gridField(itemClass, "cols", "across"),
            gridField(itemClass, "rows", "down"),
        );
    }

    const header = row(
        "class",
        path,
        ...fields,
        tally(itemClass.items.length, rack.type === "grid" ? "filled" : "item"),
        button("+", "editor__btn editor__btn--add",
            rack.type === "grid" ? "Fill the next compartment" : "Add an item to this bin",
            () => {
                itemClass.items.push({ key: "new item", qty: 0 });
                itemClass.open = true;
                render();
            }),
        button("−", "editor__btn editor__btn--remove", "Remove this bin", () => {
            bay.classes.splice(bay.classes.indexOf(itemClass), 1);
            render();
        }),
    );

    if (!itemClass.open) {
        return branch(header);
    }

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
        caret(bay),
        textField(bay.key, "section name", (value) => { bay.key = value; }),
        tally(bay.classes.length, "bin"),
        button("+", "editor__btn editor__btn--add", "Add a bin to this section", () => {
            bay.classes.push({ key: "new bin", items: [], open: true });
            bay.open = true;
            render();
        }),
        button("−", "editor__btn editor__btn--remove", "Remove this section", () => {
            rack.bays.splice(rack.bays.indexOf(bay), 1);
            render();
        }),
    );

    if (!bay.open) {
        return branch(header);
    }

    const classes = bay.classes.map((itemClass, index) =>
        renderClass(rack, bay, itemClass, `${path}.${index}`));
    if (!classes.length) {
        const empty = document.createElement("p");
        empty.className = "editor__empty";
        empty.textContent = "No bins yet.";
        classes.push(empty);
    }

    return branch(header, branch(...classes));
}

function renderRack(rack, path) {
    const fields = [
        caret(rack),
        rackNumberField(rack),
        textField(rack.name, "rack name", (value) => { rack.name = value; }),
        typeField(rack),
    ];
    if (rack.type === "std") {
        fields.push(widthField(rack));
    }

    const header = row(
        "rack",
        path,
        ...fields,
        tally(rack.bays.length, rack.type === "std" ? "level" : "face"),
        button("+", "editor__btn editor__btn--add",
            rack.type === "std" ? "Add a level to this rack" : "Add a face to this rack", () => {
                rack.bays.push({
                    key: rack.type === "std" ? `level ${rack.bays.length + 1}` : "new face",
                    classes: [],
                    open: true,
                });
                rack.open = true;
                render();
            }),
        button("−", "editor__btn editor__btn--remove", "Remove this rack", () => {
            model.splice(model.indexOf(rack), 1);
            render();
        }),
    );

    const el = rack.open
        ? branch(header, branch(...baysOf(rack, path)))
        : branch(header);
    el.classList.add("editor__rack");
    return el;
}

function baysOf(rack, path) {
    const bays = rack.bays.map((bay, index) =>
        renderBay(rack, bay, `${path}.${index}`));

    if (!bays.length) {
        const empty = document.createElement("p");
        empty.className = "editor__empty";
        empty.textContent = "No sections yet.";
        bays.push(empty);
    }
    return bays;
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
        width: 1,
        open: true,
        bays: [],
    });
    render();
    body.lastElementChild.scrollIntoView({ block: "nearest" });
}

function setAllOpen(open) {
    model.forEach((rack) => {
        rack.open = open;
        rack.bays.forEach((bay) => {
            bay.open = open;
            bay.classes.forEach((itemClass) => {
                itemClass.open = open;
            });
        });
    });
    render();
}

// Who the draft belongs to. Signing out mid-edit shouldn't silently write
// somebody else's name on your work.
function editorName() {
    const account = currentAccount();
    return account && account.name ? account.name : "";
}

// -------------------------- the review step --------------------------

function listInto(target, entries, line) {
    target.innerHTML = "";
    entries.forEach((entry) => {
        const li = document.createElement("li");
        li.textContent = line(entry);
        target.append(li);
    });
}

function countOf(n, noun) {
    return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function showReview(summary) {
    const conflicts = summary.conflicts || [];
    const changes = summary.changes || [];

    dialog.querySelector("[data-review-lead]").textContent = changes.length
        ? `${countOf(changes.length, "change")} to apply:`
        : "Nothing has changed since you opened the editor.";
    listInto(dialog.querySelector("[data-change-list]"), changes,
        (c) => `${c.where} — ${c.was} → ${c.now}`);

    const clashBox = dialog.querySelector("[data-review-conflicts]");
    clashBox.hidden = conflicts.length === 0;
    if (conflicts.length) {
        dialog.querySelector("[data-clash-lead]").textContent =
            `Somebody else changed ${countOf(conflicts.length, "thing")} you also `
            + "changed while this was open. Applying will overwrite theirs with yours:";
        listInto(dialog.querySelector("[data-clash-list]"), conflicts,
            (c) => `${c.where} — theirs ${c.theirs}, yours ${c.yours}`);
    }

    setStage("review");
}

// The dialog is either being edited or being reviewed; the footer and body
// follow.
function setStage(stage) {
    const reviewing = stage === "review";
    body.hidden = reviewing;
    review.hidden = !reviewing;

    dialog.querySelector("[data-editor-save]").hidden = reviewing;
    dialog.querySelector("[data-add-rack]").hidden = reviewing;
    dialog.querySelector("[data-apply-draft]").hidden = !reviewing;
    dialog.querySelector("[data-back-to-editing]").hidden = !reviewing;
    dialog.querySelector('[data-close-editor].editor__cancel').hidden = reviewing;
}

// `canDiscard` is for notes about a draft that actually exists — offering to
// throw one away when there isn't one would be a button that does nothing.
function showDraftNote(message, canDiscard) {
    if (!draftNote) {
        return;
    }
    draftNote.hidden = !message;
    dialog.querySelector("[data-draft-text]").textContent = message || "";
    dialog.querySelector("[data-discard-draft]").hidden = !canDiscard;
}

// ----------------------------- save / apply -----------------------------

// Step one: put the working copy somewhere safe and find out what applying it
// would do. inv.json is not touched.
function save(saveButton) {
    const problems = findProblems();
    if (problems.length) {
        showProblems(problems);
        return;
    }
    showProblems([]);

    const name = editorName();
    if (!name) {
        showProblems(["Sign in again before saving — a draft has to belong to somebody."]);
        return;
    }

    const label = saveButton.textContent;
    saveButton.disabled = true;
    saveButton.textContent = "Saving…";

    saveDraft(name, baseline, toInventory())
        .then((summary) => {
            showDraftNote("Saved as a draft. inv.json hasn't changed yet.", true);
            showReview(summary);
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

// Step two: fold it in. The server redoes the merge, so what lands accounts
// for anything saved in the meantime.
function apply(applyButton) {
    const label = applyButton.textContent;
    applyButton.disabled = true;
    applyButton.textContent = "Applying…";

    applyDraft(editorName())
        .then(() => {
            showDraftNote("");
            dialog.close();
            setStage("edit");
            if (onSaved) {
                onSaved();
            }
        })
        .catch((error) => {
            console.error("inventory:", error.message);
            setStage("edit");
            showProblems([error.message]);
        })
        .finally(() => {
            applyButton.disabled = false;
            applyButton.textContent = label;
        });
}

function dropDraft() {
    const name = editorName();
    if (!name) {
        return;
    }
    discardDraft(name)
        .then(() => {
            showDraftNote("");
            openEditor();          // start again from what's on disk
        })
        .catch((error) => showProblems([error.message]));
}

function openEditor() {
    const name = editorName();

    // Edit a copy, so Cancel really does discard. A draft waiting on the
    // server wins over the file: it is this person's own unfinished work, and
    // it already knows which document it was started from.
    Promise.all([
        loadInventory(),
        name ? loadDraft(name).catch(() => ({ draft: null })) : { draft: null },
    ])
        .then(([raw, pending]) => {
            const resuming = Boolean(pending && pending.draft);
            const starting = resuming ? pending.draft : raw;

            baseline = JSON.parse(JSON.stringify(resuming ? pending.base : raw));
            model = toModel(JSON.parse(JSON.stringify(starting)));

            showProblems([]);
            showDraftNote(resuming
                ? `Picking up the draft you left — ${pending.changes.length} unsaved `
                  + "change" + (pending.changes.length === 1 ? "" : "s") + "."
                : "", resuming);

            setStage("edit");
            render();
            if (!dialog.open) {
                dialog.showModal();
            }
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
        el.addEventListener("click", openEditor);
    });
    dialog.querySelectorAll("[data-close-editor]").forEach((el) => {
        el.addEventListener("click", () => dialog.close());
    });
    dialog.querySelectorAll("[data-add-rack]").forEach((el) => {
        el.addEventListener("click", addRack);
    });
    dialog.querySelectorAll("[data-expand-all]").forEach((el) => {
        el.addEventListener("click", () => setAllOpen(true));
    });
    dialog.querySelectorAll("[data-collapse-all]").forEach((el) => {
        el.addEventListener("click", () => setAllOpen(false));
    });
    dialog.querySelectorAll("[data-editor-save]").forEach((el) => {
        el.addEventListener("click", () => save(el));
    });
    dialog.querySelectorAll("[data-apply-draft]").forEach((el) => {
        el.addEventListener("click", () => apply(el));
    });
    dialog.querySelectorAll("[data-back-to-editing]").forEach((el) => {
        el.addEventListener("click", () => setStage("edit"));
    });
    dialog.querySelectorAll("[data-discard-draft]").forEach((el) => {
        el.addEventListener("click", dropDraft);
    });

    // Somebody else saved while this was open. That used to mean the work in
    // here was about to overwrite theirs; now it is merged, so this is a note
    // rather than a warning — and only worth making if both of you touched
    // the same field, which the review step says plainly before anything is
    // written.
    document.addEventListener("inventorychange", () => {
        if (dialog.open && review.hidden) {
            showDraftNote("Somebody else saved while this was open. Your changes will "
                + "be merged with theirs — Save shows anything you both touched.");
        }
    });
}
