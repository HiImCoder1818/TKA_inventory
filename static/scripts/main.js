// Floor plan interaction. The plan and the rack index are two views of the
// same 18 racks, keyed by data-rack. Which racks are stocked comes from
// inv.json, so a rack only opens once it has contents there.

const plan = document.querySelector(".plan");
const table = document.querySelector(".index tbody");
const breadcrumb = document.querySelector(".breadcrumb__item--current");
const roomLabel = breadcrumb ? breadcrumb.textContent : "";

function rackLabel(rack) {
    return (RACKS[rack] || {}).items || `Rack ${rack}`;
}

// Highlight a rack in both views at once, along with any scenery tagged as
// part of it (rack 4's tents and dollies, say) via data-rack-group.
function link(rack) {
    document.querySelectorAll(".is-linked").forEach((el) => {
        el.classList.remove("is-linked");
    });

    if (rack) {
        const selector = `[data-rack="${rack}"], [data-rack-group="${rack}"]`;
        document.querySelectorAll(selector).forEach((el) => {
            el.classList.add("is-linked");
        });
    }
}

function select(rack) {
    document.querySelectorAll("button.zone[data-rack]").forEach((zone) => {
        zone.setAttribute("aria-pressed", String(zone.dataset.rack === rack));
    });

    document.querySelectorAll(".index tbody tr").forEach((row) => {
        row.setAttribute("aria-selected", String(row.dataset.rack === rack));
    });

    if (breadcrumb) {
        breadcrumb.textContent = `${roomLabel} › ${rack}. ${rackLabel(rack)}`;
    }
}

// Reflect what inv.json actually carries: label the stocked racks, and let
// its names win over the ones written into the table.
function applyToPlan() {
    document.querySelectorAll("[data-rack]").forEach((el) => {
        el.classList.toggle("is-navigable", Boolean(rackHref(el.dataset.rack)));
    });

    document.querySelectorAll(".index tbody tr[data-rack]").forEach((row) => {
        const rack = RACKS[row.dataset.rack];
        const cell = row.querySelector("td");
        if (rack && rack.layout && cell) {
            cell.textContent = rack.items;
            cell.classList.remove("index__todo");
        }
    });
}

function wire(root) {
    if (!root) {
        return;
    }

    root.addEventListener("click", (event) => {
        const target = event.target.closest("[data-rack]");
        if (!target) {
            return;
        }

        const href = rackHref(target.dataset.rack);
        if (href) {
            window.location.href = href;
            return;
        }

        select(target.dataset.rack);
    });

    root.addEventListener("pointerover", (event) => {
        const target = event.target.closest("[data-rack]");
        link(target ? target.dataset.rack : null);
    });

    root.addEventListener("pointerleave", () => link(null));
}

// The plan is drawn from the template, so it stands on its own if inv.json is
// unreachable — only the openable racks depend on the fetch.
wire(plan);
wire(table);

// Saving the editor rewrites the whole document, so the plan re-reads it
// rather than guessing at what changed.
initEditor({
    onSaved: () => loadInventory().then(applyToPlan),
});

loadInventory()
    .then(() => {
        applyToPlan();
        initSearch();
    })
    .catch((error) => {
        console.error("inventory:", error.message);
        const hint = document.querySelector(".panel__hint");
        if (hint) {
            hint.textContent = `Inventory unavailable — ${error.message}`;
            hint.classList.add("panel__hint--error");
        }
    });
