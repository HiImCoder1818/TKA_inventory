// Login gate.
//
// There is no server session yet, so this is a gate on the interface rather
// than on the data: /api/inventory and the rest stay open to anyone who calls
// them directly. Signing in only decides what this page shows.
//
// Who is signed in lives in sessionStorage, which keeps you signed in while
// you walk from the floor plan into a rack and back. A reload signs you out
// again, which is what "no sessions" gets you — the two are told apart by the
// Navigation Timing entry, so a link click carries through and F5 does not.
//
// A sign-in also lapses four hours after it was made, whether or not the tab
// has been touched, so a machine left open in the shop doesn't stay signed in
// indefinitely. The clock runs from the sign-in, not from the last page.

const AUTH_KEY = "tka.account";
const SESSION_MS = 4 * 60 * 60 * 1000;

let account = null;
let expiryTimer = null;
let loginPanel = null;
let loginForm = null;
let loginError = null;

function wasReloaded() {
    const [entry] = performance.getEntriesByType("navigation");
    return Boolean(entry) && entry.type === "reload";
}

function readAccount() {
    try {
        const raw = window.sessionStorage.getItem(AUTH_KEY);
        const stored = raw ? JSON.parse(raw) : null;

        if (!stored || !stored.until || Date.now() >= stored.until) {
            return null;
        }
        return stored;
    } catch (error) {
        return null;
    }
}

function storeAccount(value) {
    try {
        if (value) {
            window.sessionStorage.setItem(AUTH_KEY, JSON.stringify(value));
        } else {
            window.sessionStorage.removeItem(AUTH_KEY);
        }
    } catch (error) {
        console.warn("could not persist the signed-in account", error);
    }
}

function currentAccount() {
    return account;
}

// Sign out on the stroke rather than waiting for the next click, so an
// unattended screen doesn't keep showing someone else's session.
function scheduleExpiry() {
    window.clearTimeout(expiryTimer);
    if (!account) {
        return;
    }

    const left = account.until - Date.now();
    expiryTimer = window.setTimeout(() => {
        signOut();
        fail("Your sign-in lapsed after four hours. Sign in again.");
    }, Math.max(0, left));
}

// Whoever cares what the signed-in role can do listens for this.
function announceAccount() {
    document.dispatchEvent(new CustomEvent("accountchange", { detail: account }));
}

// ------------------------------ the gate ------------------------------

function showLogin() {
    document.body.classList.add("is-locked");
    loginPanel.hidden = false;

    document.querySelectorAll(".account").forEach((el) => {
        el.hidden = true;
    });
    announceAccount();
    // Don't leave the last person's name sitting in the markup.
    document.querySelectorAll("[data-account-name], [data-account-role]").forEach((el) => {
        el.textContent = "";
    });

    const first = loginForm.querySelector("#login-name");
    if (first) {
        first.focus();
    }
}

function showApp() {
    document.body.classList.remove("is-locked");
    loginPanel.hidden = true;

    document.querySelectorAll("[data-account-name]").forEach((el) => {
        el.textContent = account.name;
    });
    document.querySelectorAll("[data-account-role]").forEach((el) => {
        el.textContent = account.role;
    });
    document.querySelectorAll(".account").forEach((el) => {
        el.hidden = false;
    });
    scheduleExpiry();
    announceAccount();
}

function fail(message) {
    loginError.hidden = false;
    loginError.textContent = message;
}

function submit(event) {
    event.preventDefault();
    loginError.hidden = true;

    const name = loginForm.elements.name.value.trim();
    const password = loginForm.elements.password.value;

    if (!name || !password) {
        fail("Enter a name and a password.");
        return;
    }

    const button = loginForm.querySelector(".login__submit");
    button.disabled = true;
    button.textContent = "Signing in…";

    fetch(window.LOGIN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, password }),
    })
        .then(async (response) => {
            const body = await response.json();
            if (!response.ok) {
                throw new Error(body.error || `sign in failed (${response.status})`);
            }
            return body;
        })
        .then((who) => {
            account = { ...who, until: Date.now() + SESSION_MS };
            storeAccount(account);
            loginForm.reset();
            showApp();
        })
        .catch((error) => fail(error.message))
        .finally(() => {
            button.disabled = false;
            button.textContent = "Sign in";
        });
}

function signOut() {
    account = null;
    storeAccount(null);
    showLogin();
}

function initAuth() {
    loginPanel = document.querySelector(".login");
    loginForm = loginPanel ? loginPanel.querySelector("[data-login-form]") : null;
    loginError = loginPanel ? loginPanel.querySelector(".login__error") : null;

    if (!loginPanel || !loginForm) {
        return;
    }

    // A reload starts over; following a link inside the app does not.
    if (wasReloaded()) {
        storeAccount(null);
    }

    loginForm.addEventListener("submit", submit);
    document.querySelectorAll("[data-logout]").forEach((el) => {
        el.addEventListener("click", signOut);
    });

    account = readAccount();
    if (account) {
        showApp();
    } else {
        // Clear a lapsed entry rather than leaving it to be re-read.
        storeAccount(null);
        showLogin();
    }
}

initAuth();
