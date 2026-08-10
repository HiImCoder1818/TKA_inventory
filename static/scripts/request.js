// Mode switch and request cart, shared by every page.
//
// Edit mode    — the inventory is editable: the structural editor, the +/-
//                steppers and the Save button are all live.
// Request mode — the inventory is read-only. Items grow an "Add" control
//                instead, and what you pick collects in a cart you send on
//                with a note.
//
// Which controls appear is decided in CSS off body[data-mode], so there is
// one switch rather than a scatter of hide/show calls. The keyboard and the
// stepper handlers check the mode too — CSS alone would only hide them.
//
// Mode and cart both live in localStorage, so walking from the floor plan
// into a rack and back doesn't lose what you were collecting.

const MODE_KEY = "tka.mode";
const CART_KEY = "tka.cart";
const NOTES_KEY = "tka.request-notes";

let mode = "edit";
let cart = [];

let cartPanel = null;
let cartLines = null;
let cartEmpty = null;
let cartNotes = null;
let cartStatus = null;

// --------------------------------- state ---------------------------------

function currentMode() {
    return mode;
}

function isRequestMode() {
    return mode === "request";
}

function lineKey(line) {
    return [line.rack, line.bay, line.bin, line.item].join(" ");
}

function readStore(key, fallback) {
    try {
        const raw = window.localStorage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
        return fallback;
    }
}

function writeStore(key, value) {
    try {
        window.localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
        // A full or blocked store shouldn't take the page down with it.
        console.warn("could not persist", key, error);
    }
}

function saveCart() {
    writeStore(CART_KEY, cart);
    renderCart();
}

// --------------------------------- mode ---------------------------------

function setMode(next) {
    mode = next === "request" ? "request" : "edit";
    document.body.dataset.mode = mode;
    writeStore(MODE_KEY, mode);

    document.querySelectorAll("[data-mode-set]").forEach((el) => {
        const on = el.dataset.modeSet === mode;
        el.classList.toggle("mode-btn--on", on);
        el.setAttribute("aria-pressed", String(on));
    });

    if (!isRequestMode()) {
        closeCart();
    }

    // Rack pages redraw their rows so the right controls are wired up.
    document.dispatchEvent(new CustomEvent("modechange", { detail: { mode } }));
}

// --------------------------------- cart ---------------------------------

// Adding the same item twice tops up the line rather than repeating it.
function cartAdd(line) {
    const key = lineKey(line);
    const existing = cart.find((other) => lineKey(other) === key);

    if (existing) {
        existing.qty += line.qty;
        existing.available = line.available;
    } else {
        cart.push({ ...line });
    }

    saveCart();
    flashCartButton();
}

function cartRemove(key) {
    cart = cart.filter((line) => lineKey(line) !== key);
    saveCart();
}

function cartSetQty(key, qty) {
    const line = cart.find((other) => lineKey(other) === key);
    if (!line) {
        return;
    }
    line.qty = Math.max(1, qty);
    saveCart();
}

function cartTotal() {
    return cart.reduce((total, line) => total + line.qty, 0);
}

function flashCartButton() {
    document.querySelectorAll("[data-open-cart]").forEach((el) => {
        el.classList.remove("cart-btn--bump");
        // Restart the animation rather than letting a second add be silent.
        void el.offsetWidth;
        el.classList.add("cart-btn--bump");
    });
}

// -------------------------------- drawer --------------------------------

function openCart() {
    if (!cartPanel) {
        return;
    }
    cartPanel.hidden = false;
    document.body.classList.add("has-cart-open");
}

function closeCart() {
    if (!cartPanel) {
        return;
    }
    cartPanel.hidden = true;
    document.body.classList.remove("has-cart-open");
}

function cartLine(line) {
    const key = lineKey(line);

    const li = document.createElement("li");
    li.className = "cart-line";

    const trail = document.createElement("span");
    trail.className = "cart-line__trail";
    [`${line.rack} ${line.rackLabel}`, line.bayName, line.binName].forEach((step, depth) => {
        if (depth) {
            const sep = document.createElement("i");
            sep.className = "cart-line__sep";
            sep.textContent = "›";
            trail.append(sep);
        }
        const part = document.createElement("span");
        part.textContent = step;
        trail.append(part);
    });

    const name = document.createElement("span");
    name.className = "cart-line__name";
    name.textContent = line.itemName;

    const qty = document.createElement("input");
    qty.type = "number";
    qty.className = "cart-line__qty";
    qty.min = "1";
    qty.value = String(line.qty);
    qty.setAttribute("aria-label", `Quantity of ${line.itemName}`);
    qty.addEventListener("input", () => cartSetQty(key, Number(qty.value) || 1));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "cart-line__remove";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Remove ${line.itemName}`);
    remove.addEventListener("click", () => cartRemove(key));

    const head = document.createElement("div");
    head.className = "cart-line__head";
    head.append(name, qty, remove);

    li.append(trail, head);

    // Stock can move after something is added, so say so rather than
    // letting the request quietly ask for more than is there.
    if (line.available != null && line.qty > line.available) {
        const warn = document.createElement("span");
        warn.className = "cart-line__warn";
        warn.textContent = `Only ${line.available} on hand`;
        li.append(warn);
    }

    return li;
}

function renderCart() {
    document.querySelectorAll("[data-cart-count]").forEach((el) => {
        el.textContent = String(cartTotal());
    });
    document.querySelectorAll("[data-open-cart]").forEach((el) => {
        el.classList.toggle("cart-btn--filled", cart.length > 0);
    });

    if (!cartLines) {
        return;
    }

    cartLines.innerHTML = "";
    cart.forEach((line) => cartLines.append(cartLine(line)));

    cartEmpty.hidden = cart.length > 0;
    cartLines.hidden = cart.length === 0;

    document.querySelectorAll("[data-send-request]").forEach((el) => {
        el.disabled = cart.length === 0;
    });
}

// -------------------------------- sending --------------------------------

function sendRequest() {
    if (!cart.length) {
        return;
    }

    const payload = {
        notes: cartNotes ? cartNotes.value.trim() : "",
        lines: cart.map((line) => ({
            rack: line.rack,
            bay: line.bay,
            itemClass: line.bin,
            item: line.item,
            qty: line.qty,
        })),
    };

    // No endpoint yet — say so plainly rather than pretending it went out.
    console.log("request payload:", payload);
    cartStatus.hidden = false;
    cartStatus.textContent =
        `Prepared ${payload.lines.length} line${payload.lines.length === 1 ? "" : "s"} ` +
        `(${cartTotal()} items). Sending isn't wired up yet — the payload is in the console.`;
}

// --------------------------------- boot ---------------------------------

function initRequest() {
    cartPanel = document.querySelector(".cart");
    cartLines = cartPanel ? cartPanel.querySelector(".cart__lines") : null;
    cartEmpty = cartPanel ? cartPanel.querySelector(".cart__empty") : null;
    cartNotes = cartPanel ? cartPanel.querySelector(".cart__notes") : null;
    cartStatus = cartPanel ? cartPanel.querySelector(".cart__status") : null;

    cart = readStore(CART_KEY, []);

    if (cartNotes) {
        cartNotes.value = readStore(NOTES_KEY, "");
        cartNotes.addEventListener("input", () => {
            writeStore(NOTES_KEY, cartNotes.value);
            cartStatus.hidden = true;
        });
    }

    document.querySelectorAll("[data-mode-set]").forEach((el) => {
        el.addEventListener("click", () => setMode(el.dataset.modeSet));
    });
    document.querySelectorAll("[data-open-cart]").forEach((el) => {
        el.addEventListener("click", openCart);
    });
    document.querySelectorAll("[data-close-cart]").forEach((el) => {
        el.addEventListener("click", closeCart);
    });
    document.querySelectorAll("[data-send-request]").forEach((el) => {
        el.addEventListener("click", sendRequest);
    });
    document.querySelectorAll("[data-clear-cart]").forEach((el) => {
        el.addEventListener("click", () => {
            cart = [];
            saveCart();
            cartStatus.hidden = true;
        });
    });

    setMode(readStore(MODE_KEY, "edit"));
    renderCart();
}

initRequest();
