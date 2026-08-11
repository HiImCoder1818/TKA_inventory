import hmac
import json
import os
import re
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

from flask import Flask, jsonify, render_template, request

app = Flask(__name__)

# Bay order is physical (top before middle before bottom), so keys have to
# reach the browser in the order inv.json writes them, not alphabetised.
app.json.sort_keys = False

INVENTORY_PATH = Path(__file__).parent / "inv.json"
ACCOUNTS_PATH = Path(__file__).parent / "accounts.json"
REQUESTS_PATH = Path(__file__).parent / "requests.json"

# Items are single-key objects; keeping them on one line means a quantity
# change stays a one-line diff in git.
_QTY_INLINE = re.compile(r'\{\s*"qty":\s*(-?\d+)\s*\}')


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
    """Render requests.json by hand, so each part stays on one line the way
    the file was first written rather than being fanned out by json.dump."""
    if not entries:
        return "[]\n"

    lines = ["["]
    for position, entry in enumerate(entries):
        lines.append("    {")
        for field in ("id", "name", "at", "note"):
            lines.append(f'        "{field}": {json.dumps(entry.get(field, ""))},')
        lines.append('        "parts": [')

        parts = entry.get("parts", [])
        for index, part in enumerate(parts):
            tail = "," if index < len(parts) - 1 else ""
            lines.append(
                f'            {{"path": {json.dumps(part["path"])}, '
                f'"qty": {int(part["qty"])}}}{tail}'
            )

        lines.append("        ]")
        lines.append("    }" + ("," if position < len(entries) - 1 else ""))
    lines.append("]")

    return "\n".join(lines) + "\n"


def write_requests(entries):
    write_atomically(REQUESTS_PATH, dump_requests(entries))


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

    return jsonify(entry), 201


@app.post("/api/requests/<request_id>/resolve")
def resolve_request(request_id):
    """Take a request off the queue.

    Deliberately does not touch inv.json — marking a request done and moving
    the stock that went with it are separate steps, and only the first is
    wanted so far.
    """
    entries = read_requests()
    remaining = [entry for entry in entries if entry.get("id") != request_id]

    if len(remaining) == len(entries):
        return jsonify({"error": f"no open request with id {request_id}"}), 404

    write_requests(remaining)
    return jsonify({"resolved": request_id, "open": len(remaining)})


if __name__ == "__main__":
    app.run(debug=True, port=8000)
