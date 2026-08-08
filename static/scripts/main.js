// Floor plan interaction. The plan and the rack index are two views of the
// same 18 racks, keyed by data-rack. For now selection only drives the
// breadcrumb — the hierarchy drill-in (rack -> shelf -> item) hooks in here.

const plan = document.querySelector(".plan");
const table = document.querySelector(".racks tbody");
const breadcrumb = document.querySelector(".breadcrumb__item--current");
const roomLabel = breadcrumb ? breadcrumb.textContent : "";

function zonesFor(rack) {
    return document.querySelectorAll(`[data-rack="${rack}"]`);
}

function rackLabel(rack) {
    const row = document.querySelector(`.racks tbody tr[data-rack="${rack}"] td`);
    return row ? row.textContent.trim() : `Rack ${rack}`;
}

// Highlight a rack in both views at once.
function link(rack) {
    document.querySelectorAll(".is-linked").forEach((el) => {
        el.classList.remove("is-linked");
    });

    if (rack) {
        zonesFor(rack).forEach((el) => el.classList.add("is-linked"));
    }
}

function select(rack) {
    document.querySelectorAll("button.zone[data-rack]").forEach((zone) => {
        zone.setAttribute("aria-pressed", String(zone.dataset.rack === rack));
    });

    document.querySelectorAll(".racks tbody tr").forEach((row) => {
        row.setAttribute("aria-selected", String(row.dataset.rack === rack));
    });

    if (breadcrumb) {
        breadcrumb.textContent = `${roomLabel} › ${rack}. ${rackLabel(rack)}`;
    }

    console.log("selected rack:", rack, rackLabel(rack));
}

function wire(root) {
    if (!root) {
        return;
    }

    root.addEventListener("click", (event) => {
        const target = event.target.closest("[data-rack]");
        if (target) {
            select(target.dataset.rack);
        }
    });

    root.addEventListener("pointerover", (event) => {
        const target = event.target.closest("[data-rack]");
        link(target ? target.dataset.rack : null);
    });

    root.addEventListener("pointerleave", () => link(null));
}

wire(plan);
wire(table);
