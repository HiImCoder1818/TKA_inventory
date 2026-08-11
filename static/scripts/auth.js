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

const AUTH_KEY = "tka.account";

let account = null;
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
        return raw ? JSON.parse(raw) : null;
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

// ------------------------------ the gate ------------------------------

function showLogin() {
    document.body.classList.add("is-locked");
    loginPanel.hidden = false;

    document.querySelectorAll(".account").forEach((el) => {
        el.hidden = true;
    });
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
            account = who;
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
        showLogin();
    }
}

initAuth();
