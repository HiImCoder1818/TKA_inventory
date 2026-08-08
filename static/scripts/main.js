// Floor plan interaction. For now this only tracks which zone is selected —
// the hierarchy drill-in (zone -> shelf -> item) hooks in here later.

const plan = document.querySelector(".plan");
const breadcrumb = document.querySelector(".breadcrumb__item--current");
const roomLabel = breadcrumb ? breadcrumb.textContent : "";

function zoneName(zone) {
    const label = zone.querySelector(".zone__label");
    if (label) {
        return label.textContent.trim();
    }
    return zone.getAttribute("aria-label") || zone.dataset.zone || "Zone";
}

if (plan) {
    plan.addEventListener("click", (event) => {
        const zone = event.target.closest(".zone");
        if (!zone) {
            return;
        }

        plan.querySelectorAll(".zone[aria-pressed='true']").forEach((other) => {
            other.setAttribute("aria-pressed", "false");
        });
        zone.setAttribute("aria-pressed", "true");

        if (breadcrumb) {
            breadcrumb.textContent = `${roomLabel} › ${zoneName(zone)}`;
        }

        console.log("selected zone:", zone.dataset.zone);
    });
}
