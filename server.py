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


@app.post("/api/inventory/qty")
def update_qty():
    """Apply a relative change to one item's quantity.

    The client sends a delta rather than a total, so two people counting the
    same shelf add up instead of overwriting each other.
    """
    payload = request.get_json(silent=True) or {}

    rack = payload.get("rack")
    bay = payload.get("bay")
    item_class = payload.get("itemClass")
    item = payload.get("item")
    try:
        delta = int(payload["delta"])
    except (KeyError, TypeError, ValueError):
        return jsonify({"error": "delta must be an integer"}), 400

    if not all(isinstance(part, str) for part in (rack, bay, item_class, item)):
        return jsonify({"error": "rack, bay, itemClass and item are required"}), 400
    if bay == "type":
        return jsonify({"error": '"type" is not a bay'}), 400

    try:
        data = read_inventory()
    except FileNotFoundError:
        return jsonify({"error": f"{INVENTORY_PATH.name} not found"}), 404
    except json.JSONDecodeError as exc:
        return jsonify({"error": f"{INVENTORY_PATH.name} is not valid JSON: {exc}"}), 500

    try:
        entry = data[rack][bay][item_class][item]
        current = int(entry["qty"])
    except (KeyError, TypeError, ValueError):
        return jsonify({"error": f"no such item: {rack} / {bay} / {item_class} / {item}"}), 404

    quantity = max(0, current + delta)
    entry["qty"] = quantity
    write_inventory(data)

    return jsonify({"qty": quantity})


if __name__ == "__main__":
    app.run(debug=True, port=8000)
