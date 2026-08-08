import json
import os
import re
import tempfile
from pathlib import Path

from flask import Flask, jsonify, render_template, request

app = Flask(__name__)

# Bay order is physical (top before middle before bottom), so keys have to
# reach the browser in the order inv.json writes them, not alphabetised.
app.json.sort_keys = False

INVENTORY_PATH = Path(__file__).parent / "inv.json"

# Items are single-key objects; keeping them on one line means a quantity
# change stays a one-line diff in git.
_QTY_INLINE = re.compile(r'\{\s*"qty":\s*(-?\d+)\s*\}')


def read_inventory():
    with INVENTORY_PATH.open(encoding="utf-8") as handle:
        return json.load(handle)


def write_inventory(data):
    """Rewrite inv.json in place, preserving its layout and key order."""
    text = json.dumps(data, indent=4, ensure_ascii=False)
    text = _QTY_INLINE.sub(lambda match: '{"qty": %s}' % match.group(1), text)

    # Write beside the target and rename, so an interrupted save can never
    # leave a half-written inventory behind.
    handle_fd, temp_path = tempfile.mkstemp(dir=INVENTORY_PATH.parent, suffix=".tmp")
    try:
        with os.fdopen(handle_fd, "w", encoding="utf-8") as handle:
            handle.write(text + "\n")
        os.replace(temp_path, INVENTORY_PATH)
    except Exception:
        Path(temp_path).unlink(missing_ok=True)
        raise


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


if __name__ == "__main__":
    app.run(debug=True, port=8000)
