// Floor plan interaction. The plan and the item index are two views of the
// same 18 racks, keyed by data-rack. Racks with a detail layout open it on
// click; the rest just select, until their layout is drawn.

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

// Mark the racks that lead somewhere, in both views.
function markNavigable() {
    document.querySelectorAll("[data-rack]").forEach((el) => {
        if (rackHref(el.dataset.rack)) {
            el.classList.add("is-navigable");
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

markNavigable();
wire(plan);
wire(table);
