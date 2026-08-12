import hmac
import json
import os
import queue
import re
import tempfile
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, Response, jsonify, render_template, request

app = Flask(__name__)

# Bay order is physical (top before middle before bottom), so keys have to
# reach the browser in the order inv.json writes them, not alphabetised.
app.json.sort_keys = False

INVENTORY_PATH = Path(__file__).parent / "inv.json"
ACCOUNTS_PATH = Path(__file__).parent / "accounts.json"
REQUESTS_PATH = Path(__file__).parent / "requests.json"
HISTORY_PATH = Path(__file__).parent / "history.json"

# Items are single-key objects; keeping them on one line means a quantity
# change stays a one-line diff in git.
_QTY_INLINE = re.compile(r'\{\s*"qty":\s*(-?\d+)\s*\}')


# ------------------------------ live updates ------------------------------
#
# Two people work this inventory at once: someone counting a shelf and
# someone filling requests from it. Whenever one of them changes a file, the
# other's screen is wrong until they reload. So every write announces itself,
# and each open page holds a stream it listens on.
#
# Server-sent events rather than websockets: the traffic only ever goes one
# way — the server saying "this changed, re-read it" — and EventSource
# reconnects on its own when the server restarts, which during development it
# does constantly.
#
# The announcement carries no data, only the names of what moved. Pages
# re-read through the same endpoints they already use, so there is one way to
# load a thing rather than two that can disagree.

_listeners = []
_listeners_lock = threading.Lock()

# How long a stream waits before sending a comment frame to prove it is still
# there. Proxies and browsers drop a connection that goes quiet — and it is
# also how a listener that vanished without saying so gets noticed, since the
# failed write is what ends its thread. A closed tab costs a thread until the
# next beat, and no longer.
HEARTBEAT_SECONDS = 20


def send_to(listeners, frame):
    for listener in listeners:
        try:
            listener["outbox"].put_nowait(frame)
        except queue.Full:
            # A page too far behind to keep up will re-read everything when
            # it reconnects, so dropping a frame costs nothing.
            pass


def announce(*changed, origin=None):
    """Tell every open page which files just changed.

    `origin` is the client that made the change, if it said who it was; it
    skips its own echo, having already applied the result of its own request.
    """
    payload = json.dumps({
        "changed": sorted(set(changed)),
        "origin": origin,
        "at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
    })

    with _listeners_lock:
        waiting = list(_listeners)

    send_to(waiting, f"data: {payload}\n\n")


def notify(name, notice):
    """Send one person word of something that happened to their request.

    Addressed by the name they signed in under, which each page reports when
    it opens its stream. Nothing checks that claim — the same as everywhere
    else here, since there is no session — so this routes a message to the
    right screen rather than keeping it from the wrong one.
    """
    if not name:
        return

    payload = json.dumps({
        **notice,
        "for": name,
        "at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
    })

    with _listeners_lock:
        waiting = [item for item in _listeners if item["who"] == name]

    send_to(waiting, f"event: notice\ndata: {payload}\n\n")


def client_id():
    """Which page made this request, if it identified itself."""
    return request.headers.get("X-Client-Id") or None


@app.get("/api/events")
def events():
    """The stream each open page listens on.

    `who` is the name the page is signed in under, so a message meant for one
    person reaches their screen rather than everybody's. A page reconnects
    with a new `who` when somebody signs in or out.
    """
    # Read before streaming: the generator below runs after this request's
    # context has been torn down, so `request` is gone by the time it starts.
    who = request.args.get("who") or None

    def stream():
        listener = {"outbox": queue.Queue(maxsize=64), "who": who}
        outbox = listener["outbox"]

        with _listeners_lock:
            _listeners.append(listener)

        try:
            # Reconnect briskly: a restart during development shouldn't leave
            # pages stale for the browser's three-second default.
            yield "retry: 1000\n\n"
            yield "event: ready\ndata: {}\n\n"

            while True:
                try:
                    payload = outbox.get(timeout=HEARTBEAT_SECONDS)
                except queue.Empty:
                    yield ": ping\n\n"
                    continue
                # Frames arrive fully formed: a broadcast and a message for
                # one person differ only in who they were queued to.
                yield payload
        finally:
            with _listeners_lock:
                if listener in _listeners:
                    _listeners.remove(listener)

    return Response(stream(), mimetype="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        # Nginx buffers streamed responses by default, which holds every
        # event until the connection closes.
        "X-Accel-Buffering": "no",
    })


def read_inventory():
    with INVENTORY_PATH.open(encoding="utf-8") as handle:
        return json.load(handle)


def write_atomically(path, text):
    """Write beside the target and rename, so an interrupted save can never
    leave a half-written file behind."""
    handle_fd, temp_path = tempfile.mkstemp(dir=path.parent, suffix=".tmp")
    try:
        with os.fdopen(handle_fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.replace(temp_path, path)
    except Exception:
        Path(temp_path).unlink(missing_ok=True)
        raise


def write_inventory(data):
    """Rewrite inv.json in place, preserving its layout and key order."""
    text = json.dumps(data, indent=4, ensure_ascii=False)
    text = _QTY_INLINE.sub(lambda match: '{"qty": %s}' % match.group(1), text)
    write_atomically(INVENTORY_PATH, text + "\n")


def read_requests():
    """Open requests, with any hand-written entry given an id.

    Requests are resolved by id, so an entry written straight into the file
    without one could never be taken off the queue. Backfilling on read keeps
    that from being a trap.
    """
    try:
        with REQUESTS_PATH.open(encoding="utf-8") as handle:
            data = json.load(handle)
    except FileNotFoundError:
        return []

    if not isinstance(data, list):
        return []

    entries = [entry for entry in data if isinstance(entry, dict)]
    missing = [entry for entry in entries if not entry.get("id")]
    for entry in missing:
        entry["id"] = uuid.uuid4().hex[:8]

    if missing:
        write_requests(entries)

    return entries


def dump_requests(entries):
    """Render a request list by hand, so each part stays on one line the way
    requests.json was first written rather than being fanned out by json.dump.

    Shared with history.json, which is the same shape plus how it ended.
    """
    if not entries:
        return "[]\n"

    lines = ["["]
    for position, entry in enumerate(entries):
        lines.append("    {")
        for field in ("id", "name", "at", "note"):
            lines.append(f'        "{field}": {json.dumps(entry.get(field, ""))},')

        # How it ended, on a history entry: filled, turned down and why, or
        # neither yet.
        for field in ("resolvedAt", "declinedAt", "reason"):
            if field in entry:
                lines.append(f'        "{field}": {json.dumps(entry[field])},')
        # "fulfilled" is what actually came off the shelf, which can differ
        # from what was asked for once a request has been trimmed.
        blocks = ["parts"]
        if "fulfilled" in entry:
            blocks.append("fulfilled")

        for block_index, field in enumerate(blocks):
            lines.append(f'        "{field}": [')

            parts = entry.get(field) or []
            for index, part in enumerate(parts):
                tail = "," if index < len(parts) - 1 else ""
                lines.append(
                    f'            {{"path": {json.dumps(part["path"])}, '
                    f'"qty": {int(part["qty"])}}}{tail}'
                )

            lines.append("        ]" + ("," if block_index < len(blocks) - 1 else ""))

        lines.append("    }" + ("," if position < len(entries) - 1 else ""))
    lines.append("]")

    return "\n".join(lines) + "\n"


def write_requests(entries):
    write_atomically(REQUESTS_PATH, dump_requests(entries))


def read_history():
    try:
        with HISTORY_PATH.open(encoding="utf-8") as handle:
            data = json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError):
        return []
    return data if isinstance(data, list) else []


def write_history(entries):
    write_atomically(HISTORY_PATH, dump_requests(entries))


def log_request(entry):
    """Append a request to the history the moment it is made.

    The queue in requests.json empties as work gets done; this doesn't, so
    there's still a record of what was asked for afterwards.
    """
    history = read_history()
    history.append({**entry, "resolvedAt": None})
    write_history(history)


def log_trimmed(request_id, parts):
    """Carry a quantity edit through to the history's open copy.

    The history is meant to read as the request did. Without this it would
    keep the number first asked for and then report a smaller `fulfilled`,
    which reads as the shelf coming up short rather than as someone deciding
    to hand over fewer.
    """
    history = read_history()
    for entry in history:
        if entry.get("id") == request_id and not settled(entry):
            entry["parts"] = [dict(part) for part in parts]
    write_history(history)


def log_resolved(request_id, when, fulfilled):
    """Stamp the history entry for a request that has just been resolved.

    The entry's own `parts` stay as the request stood when it was filled;
    `fulfilled` records what actually came off the shelf, which is smaller
    only when the stock could not cover it.
    """
    history = read_history()
    for entry in history:
        if entry.get("id") == request_id and not settled(entry):
            entry["resolvedAt"] = when
            entry["fulfilled"] = fulfilled
    write_history(history)


def log_declined(request_id, when, reason):
    """Stamp the history entry for a request that was turned down.

    Nothing comes off the shelf, so there is no `fulfilled` block — a decline
    is a request that ended without parts moving, and the log says so along
    with whatever reason was given.
    """
    history = read_history()
    for entry in history:
        if entry.get("id") == request_id and not settled(entry):
            # The null resolvedAt is what marked it still open; a declined
            # request isn't open and was never resolved, so drop it rather
            # than leave both stamps sitting there.
            entry.pop("resolvedAt", None)
            entry["declinedAt"] = when
            entry["reason"] = reason
    write_history(history)


def settled(entry):
    """Has this history entry already been filled or turned down?"""
    return bool(entry.get("resolvedAt") or entry.get("declinedAt"))


def stock_of(inventory, path):
    """How many of `path` are on the shelf, or None if it isn't there."""
    try:
        rack, bay, item_class, item = path
        return int(inventory[rack][bay][item_class][item]["qty"])
    except (KeyError, TypeError, ValueError):
        return None


@app.post("/api/login")
def login():
    """Check a name and password against accounts.json.

    There is no session yet, so this only answers "are these credentials
    good?" — it does not protect anything. The other endpoints stay open,
    and the login is a gate on the UI rather than on the data.
    """
    payload = request.get_json(silent=True) or {}
    name = payload.get("name")
    password = payload.get("password")

    if not isinstance(name, str) or not isinstance(password, str):
        return jsonify({"error": "name and password are required"}), 400

    try:
        with ACCOUNTS_PATH.open(encoding="utf-8") as handle:
            accounts = json.load(handle)
    except FileNotFoundError:
        return jsonify({"error": f"{ACCOUNTS_PATH.name} not found"}), 500
    except json.JSONDecodeError as exc:
        return jsonify({"error": f"{ACCOUNTS_PATH.name} is not valid JSON: {exc}"}), 500

    account = accounts.get(name.strip())
    stored = str(account.get("password", "")) if isinstance(account, dict) else ""

    # Compare even when the name is unknown, and say the same thing either
    # way, so the reply doesn't tell an outsider which names are real.
    if not hmac.compare_digest(stored, password) or not account:
        return jsonify({"error": "That name and password don't match an account."}), 401

    return jsonify({"name": name.strip(), "role": account.get("role", "")})


@app.route("/")
def index():
    return render_template("index.html")


# Both rack views take the rack number from ?rack=N and read their contents
# from /api/inventory.
@app.route("/std_rack")
def std_rack():
    return render_template("std_rack.html")


@app.route("/server_rack")
def server_rack():
    return render_template("server_rack.html")


@app.route("/api/inventory")
def inventory():
    """Serve inv.json, re-read per request so edits show up on a refresh."""
    try:
        return jsonify(read_inventory())
    except FileNotFoundError:
        return jsonify({"error": f"{INVENTORY_PATH.name} not found"}), 404
    except json.JSONDecodeError as exc:
        return jsonify({"error": f"{INVENTORY_PATH.name} is not valid JSON: {exc}"}), 500


PATH_FIELDS = ("rack", "bay", "itemClass", "item")
RACK_TYPES = ("std", "server")


class InventoryError(ValueError):
    """A rejected inventory document, with a message worth showing the user."""


def clean_inventory(raw):
    """Check a whole inventory document and return it normalised.

    Rebuilt key by key rather than trusted as-is, so nothing unexpected can
    ride along into the file the rest of the app reads.
    """
    if not isinstance(raw, dict):
        raise InventoryError("inventory must be an object of racks")

    racks = {}
    for rack_key, rack in raw.items():
        where = f"rack {rack_key!r}"
        if not rack_key.strip():
            raise InventoryError("a rack is missing its name")
        if not isinstance(rack, dict):
            raise InventoryError(f"{where} must be an object")
        if rack.get("type") not in RACK_TYPES:
            raise InventoryError(f"{where} needs a type of {' or '.join(RACK_TYPES)}")

        cleaned = {"type": rack["type"]}
        for bay_key, bay in rack.items():
            if bay_key == "type":
                continue
            if not bay_key.strip():
                raise InventoryError(f"{where} has a bay with no name")
            if not isinstance(bay, dict):
                raise InventoryError(f"{where}, bay {bay_key!r} must be an object")

            bins = {}
            for class_key, item_class in bay.items():
                if not class_key.strip():
                    raise InventoryError(f"{where}, bay {bay_key!r} has an item class with no name")
                if not isinstance(item_class, dict):
                    raise InventoryError(
                        f"{where}, bay {bay_key!r}, {class_key!r} must be an object"
                    )

                items = {}
                for item_key, item in item_class.items():
                    spot = f"{where}, {bay_key!r} / {class_key!r}"
                    if not item_key.strip():
                        raise InventoryError(f"{spot} has an item with no name")
                    if not isinstance(item, dict):
                        raise InventoryError(f"{spot}, item {item_key!r} must be an object")
                    try:
                        quantity = int(item["qty"])
                    except (KeyError, TypeError, ValueError):
                        raise InventoryError(f"{spot}, item {item_key!r} needs an integer qty")
                    if quantity < 0:
                        raise InventoryError(f"{spot}, item {item_key!r} cannot be negative")
                    items[item_key] = {"qty": quantity}

                bins[class_key] = items
            cleaned[bay_key] = bins
        racks[rack_key] = cleaned

    return racks


@app.put("/api/inventory")
def replace_inventory():
    """Replace the whole document — the structural editor's save."""
    try:
        data = clean_inventory(request.get_json(silent=True))
    except InventoryError as exc:
        return jsonify({"error": str(exc)}), 400

    write_inventory(data)
    announce("inventory", origin=client_id())
    return jsonify(data)


@app.post("/api/inventory/qty")
def update_qty():
    """Apply a batch of staged quantity changes in one write.

    Each change carries a delta rather than a total, so two people counting
    the same shelf add up instead of overwriting each other. The whole batch
    is validated before anything is written, so a bad path can't leave the
    inventory half-saved.
    """
    payload = request.get_json(silent=True) or {}
    changes = payload.get("changes")

    if not isinstance(changes, list) or not changes:
        return jsonify({"error": "expected a non-empty list of changes"}), 400

    try:
        data = read_inventory()
    except FileNotFoundError:
        return jsonify({"error": f"{INVENTORY_PATH.name} not found"}), 404
    except json.JSONDecodeError as exc:
        return jsonify({"error": f"{INVENTORY_PATH.name} is not valid JSON: {exc}"}), 500

    staged = []
    for change in changes:
        if not isinstance(change, dict):
            return jsonify({"error": "each change must be an object"}), 400

        path = {field: change.get(field) for field in PATH_FIELDS}
        if not all(isinstance(value, str) for value in path.values()) or path["bay"] == "type":
            return jsonify({"error": f"a change is missing one of {', '.join(PATH_FIELDS)}"}), 400

        try:
            delta = int(change["delta"])
        except (KeyError, TypeError, ValueError):
            return jsonify({"error": "each change needs an integer delta"}), 400

        try:
            entry = data[path["rack"]][path["bay"]][path["itemClass"]][path["item"]]
            int(entry["qty"])
        except (KeyError, TypeError, ValueError):
            return jsonify({
                "error": "no such item: "
                         f"{path['rack']} / {path['bay']} / {path['itemClass']} / {path['item']}"
            }), 404

        staged.append((path, entry, delta))

    saved = []
    for path, entry, delta in staged:
        quantity = max(0, int(entry["qty"]) + delta)
        entry["qty"] = quantity
        saved.append({**path, "qty": quantity})

    write_inventory(data)
    announce("inventory", origin=client_id())

    return jsonify({"changes": saved})


@app.get("/api/requests")
def list_requests():
    """Every open request, oldest first."""
    return jsonify(read_requests())


@app.post("/api/requests")
def create_request():
    """Add a request from someone's cart."""
    payload = request.get_json(silent=True) or {}

    name = payload.get("name")
    note = payload.get("note", "")
    parts = payload.get("parts")

    if not isinstance(name, str) or not name.strip():
        return jsonify({"error": "a request needs the name of whoever is asking"}), 400
    if not isinstance(note, str):
        return jsonify({"error": "note must be text"}), 400
    if not isinstance(parts, list) or not parts:
        return jsonify({"error": "a request needs at least one part"}), 400

    # The stock cap is a rule, not a nicety, so an unreadable inventory stops
    # the request rather than quietly letting it through unchecked.
    try:
        inventory = read_inventory()
    except FileNotFoundError:
        return jsonify({"error": f"{INVENTORY_PATH.name} not found"}), 500
    except json.JSONDecodeError as exc:
        return jsonify({"error": f"{INVENTORY_PATH.name} is not valid JSON: {exc}"}), 500

    cleaned = []
    for part in parts:
        path = part.get("path") if isinstance(part, dict) else None
        if not isinstance(path, list) or len(path) != 4:
            return jsonify({
                "error": "each part needs a path of rack, section, bin and item"
            }), 400
        if not all(isinstance(step, str) and step for step in path):
            return jsonify({"error": "a part path may not have empty steps"}), 400

        try:
            quantity = int(part["qty"])
        except (KeyError, TypeError, ValueError):
            return jsonify({"error": "each part needs an integer qty"}), 400
        if quantity < 1:
            return jsonify({"error": "a part quantity must be at least 1"}), 400

        # You can't ask for more than is on the shelf. The browser caps this
        # too, but the rule belongs here as well.
        available = stock_of(inventory, path)
        if available is None:
            return jsonify({"error": f"no such item: {' / '.join(path)}"}), 400
        if quantity > available:
            return jsonify({
                "error": f"only {available} of {path[3]} on hand, {quantity} requested"
            }), 409

        cleaned.append({"path": path, "qty": quantity})

    entry = {
        # An id rather than a list position, so two people resolving at once
        # can't take each other's request off the queue.
        "id": uuid.uuid4().hex[:8],
        "name": name.strip(),
        "at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "note": note.strip(),
        "parts": cleaned,
    }

    entries = read_requests()
    entries.append(entry)
    write_requests(entries)
    log_request(entry)

    # The queue growing is the whole point of the filling side's screen, so
    # this is the announcement that matters most.
    announce("requests", "history", origin=client_id())

    return jsonify(entry), 201


@app.post("/api/requests/<request_id>/resolve")
def resolve_request(request_id):
    """Fill a request: take it off the queue, move the stock, log it.

    Filling is what actually empties the shelf, so this is the one place a
    request writes to inv.json. A count is never driven negative — if the
    shelf has less than was asked for, it takes what is there and reports
    the shortfall, and the history records what came off rather than what
    was wanted.

    There is no undo. Resolving is the record of a physical handover.
    """
    entries = read_requests()
    target = next((entry for entry in entries if entry.get("id") == request_id), None)

    if target is None:
        return jsonify({"error": f"no open request with id {request_id}"}), 404

    try:
        inventory = read_inventory()
    except FileNotFoundError:
        return jsonify({"error": f"{INVENTORY_PATH.name} not found"}), 500
    except json.JSONDecodeError as exc:
        return jsonify({"error": f"{INVENTORY_PATH.name} is not valid JSON: {exc}"}), 500

    fulfilled = []
    short = []

    for part in target.get("parts", []):
        path = part["path"]
        wanted = int(part["qty"])
        available = stock_of(inventory, path)

        if available is None:
            # The item has been renamed or removed since the request was made.
            short.append({"item": path[3], "wanted": wanted, "taken": 0})
            continue

        # Never drive a count negative: take what is there and say so.
        taken = min(available, wanted)
        rack, bay, item_class, item = path
        inventory[rack][bay][item_class][item]["qty"] = available - taken
        fulfilled.append({"path": path, "qty": taken})

        if taken < wanted:
            short.append({"item": path[3], "wanted": wanted, "taken": taken})

    when = datetime.now(timezone.utc).replace(microsecond=0).isoformat()

    write_inventory(inventory)
    write_requests([entry for entry in entries if entry.get("id") != request_id])
    log_resolved(request_id, when, fulfilled)

    # A fill touches all three: the queue shrinks, the shelf empties, the log
    # gains a resolution.
    announce("requests", "history", "inventory", origin=client_id())

    # And the person who asked wants to know their parts are waiting, which
    # nothing else on their screen would tell them.
    notify(target.get("name"), {
        "kind": "resolved",
        "requestId": request_id,
        "lines": len(fulfilled),
        "items": sum(part["qty"] for part in fulfilled),
        "short": short,
    })

    return jsonify({
        "resolved": request_id,
        "resolvedAt": when,
        "open": len(entries) - 1,
        "fulfilled": fulfilled,
        "short": short,
    })


@app.post("/api/requests/<request_id>/decline")
def decline_request(request_id):
    """Turn a request down: off the queue, into the log, nothing off the shelf.

    The counterpart to resolving. Both end a request and both are final —
    what separates them is whether any parts moved. A reason is optional but
    worth giving: it is the only thing the person who asked will be told
    beyond the fact that they aren't getting the parts.
    """
    payload = request.get_json(silent=True) or {}
    reason = str(payload.get("reason") or "").strip()

    entries = read_requests()
    target = next((entry for entry in entries if entry.get("id") == request_id), None)

    if target is None:
        return jsonify({"error": f"no open request with id {request_id}"}), 404

    when = datetime.now(timezone.utc).replace(microsecond=0).isoformat()

    write_requests([entry for entry in entries if entry.get("id") != request_id])
    log_declined(request_id, when, reason)

    announce("requests", "history", origin=client_id())

    notify(target.get("name"), {
        "kind": "declined",
        "requestId": request_id,
        "reason": reason,
    })

    return jsonify({
        "declined": request_id,
        "declinedAt": when,
        "reason": reason,
        "open": len(entries) - 1,
    })


@app.post("/api/requests/qty")
def update_request_qty():
    """Set quantities on open requests.

    Absolute totals, not deltas: whoever is filling the request is deciding
    the final number, rather than adding to a count someone else is also
    moving. Capped at what's on the shelf.
    """
    payload = request.get_json(silent=True) or {}
    changes = payload.get("changes")

    if not isinstance(changes, list) or not changes:
        return jsonify({"error": "expected a non-empty list of changes"}), 400

    entries = read_requests()
    by_id = {entry.get("id"): entry for entry in entries}

    try:
        inventory = read_inventory()
    except FileNotFoundError:
        return jsonify({"error": f"{INVENTORY_PATH.name} not found"}), 500
    except json.JSONDecodeError as exc:
        return jsonify({"error": f"{INVENTORY_PATH.name} is not valid JSON: {exc}"}), 500

    # Check the whole batch before writing any of it.
    staged = []
    for change in changes:
        if not isinstance(change, dict):
            return jsonify({"error": "each change must be an object"}), 400

        entry = by_id.get(change.get("id"))
        path = change.get("path")
        if entry is None:
            return jsonify({"error": f"no open request with id {change.get('id')}"}), 404
        if not isinstance(path, list) or len(path) != 4:
            return jsonify({"error": "each change needs the part's path"}), 400

        try:
            quantity = int(change["qty"])
        except (KeyError, TypeError, ValueError):
            return jsonify({"error": "each change needs an integer qty"}), 400
        if quantity < 1:
            return jsonify({"error": "a part quantity must be at least 1"}), 400

        part = next((item for item in entry.get("parts", []) if item["path"] == path), None)
        if part is None:
            return jsonify({"error": f"{' / '.join(path)} is not on that request"}), 404

        available = stock_of(inventory, path)
        if available is not None and quantity > available:
            return jsonify({
                "error": f"only {available} of {path[3]} on hand, {quantity} asked for"
            }), 409

        staged.append((part, quantity))

    for part, quantity in staged:
        part["qty"] = quantity

    write_requests(entries)

    # Keep the history's open copy in step with the queue.
    for entry_id in {change.get("id") for change in changes}:
        entry = by_id.get(entry_id)
        if entry is not None:
            log_trimmed(entry_id, entry.get("parts", []))

    announce("requests", "history", origin=client_id())

    return jsonify({"changes": len(staged)})


@app.get("/api/history")
def list_history():
    """Every request ever made, resolved or not, oldest first.

    Only an admin is shown this in the UI. With no session the server can't
    tell who is asking, so that is a rule about the interface, not the data.
    """
    return jsonify(read_history())


if __name__ == "__main__":
    # threaded is the default, but say so: every open page holds an event
    # stream for as long as it is open, and a single-threaded server would
    # serve the first one and hang for everybody else.
    app.run(debug=True, port=8000, threaded=True)
