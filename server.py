import atexit
import copy
import hashlib
import hmac
import json
import os
import queue
import re
import sys
import tempfile
import threading
import time
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
NOTICES_PATH = Path(__file__).parent / "notices.json"
DRAFTS_PATH = Path(__file__).parent / "drafts.json"

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

# Undismissed messages, read and rewritten as a whole file, so one lock round
# the pair keeps two at once from losing each other.
_notices_lock = threading.Lock()

# Per person, so one ignored queue can't crowd out everybody else's.
MAX_NOTICES_EACH = 30

# How long a write of the notices file waits for its turn before giving up.
# The file is small and a turn costs milliseconds, so this is only ever
# reached when something is wrong — and then it is the ceiling on how much a
# jammed file can slow a handover down. Missing a notice costs somebody a
# toast; a slow resolve costs whoever is standing at the shelf.
NOTICES_LOCK_WAIT = 3

# Drafts are read and rewritten whole, so the same arrangement: one lock, and
# a deadline on it rather than a handler that waits forever.
_drafts_lock = threading.Lock()
DRAFTS_LOCK_WAIT = 3

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
    """Leave one person word of something that happened to their request.

    Addressed by the name they signed in under, which each page reports when
    it opens its stream. Nothing checks that claim — the same as everywhere
    else here, since there is no session — so this routes a message to the
    right screen rather than keeping it from the wrong one.

    The message is written down before it is pushed. A notice stays put until
    the person it is for dismisses it, so one sent while they were away is
    waiting when they come back rather than lost to a screen nobody saw.
    """
    if not name:
        return

    entry = {
        "id": uuid.uuid4().hex[:8],
        "for": name,
        "at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        **notice,
    }

    # Writing a notice is a read-modify-write, so it does need the lock — but
    # with a deadline. The handover itself is already done and written by the
    # time we get here; making somebody's resolve hang because the notices
    # file is slow would be letting the receipt hold up the delivery.
    if not _notices_lock.acquire(timeout=NOTICES_LOCK_WAIT):
        app.logger.warning(
            "gave up waiting to write a notice for %s — %s is not responding",
            name, NOTICES_PATH.name)
        return

    try:
        pending = read_notices()
        pending.append(entry)
        write_notices(pending)
    except OSError as exc:
        # Never write a trimmed file off a read that failed: that would throw
        # away everybody's unread notices to save one.
        app.logger.warning("could not record a notice for %s: %s", name, exc)
        return
    finally:
        _notices_lock.release()

    payload = json.dumps(entry)

    with _listeners_lock:
        waiting = [item for item in _listeners if item["who"] == name]

    send_to(waiting, f"event: notice\ndata: {payload}\n\n")


def notices_for(name):
    """Everything still waiting to be read by `name`, oldest first.

    Deliberately takes no lock. Notices are written by replacing the whole
    file in one rename, so a reader opens either the old file or the new one
    and never a half-written one — the lock buys a reader nothing, and taking
    it would mean every page that connects queues behind every other.

    Nor does a failure here get to travel. This runs inside the event stream,
    and an exception would kill the stream mid-response and have the page
    reconnect into the same failure a second later. A page with no notices on
    it is a far smaller problem than a page that cannot hold a connection.
    """
    if not name:
        return []
    try:
        return [entry for entry in read_notices() if entry.get("for") == name]
    except OSError as exc:
        app.logger.warning("could not read %s: %s", NOTICES_PATH.name, exc)
        return []


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

            # Everything still unread, as a set rather than one at a time.
            # The page shows exactly this, so a notice dismissed on another
            # screen stops showing here too.
            waiting = json.dumps(notices_for(who))
            yield f"event: notices\ndata: {waiting}\n\n"

            # Whether changes are reaching the disk. Sent every time, so a
            # page that reconnects after the trouble has passed stops saying
            # there is some.
            yield f"event: storage\ndata: {json.dumps({'state': storage_state()})}\n\n"

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


# --------------------------------- storage ---------------------------------
#
# The JSON files are the record, but nobody waits on them.
#
# Every request used to open, parse and rewrite them inline: sending a parts
# request was three reads and two writes before the server could answer. That
# is fine while the disk answers in a millisecond, and it stops being fine the
# moment it doesn't — a project folder that a sync service keeps (iCloud,
# Drive, OneDrive) or that sits on a network share can take seconds per file,
# or hang outright when the machine is offline. Then every submission timed
# out, and every page re-reading after it queued up behind.
#
# So each file is held in memory. Reads are answered from there and never
# touch the disk. Writes change the copy in memory, answer, and are put on
# disk a moment later by one background thread — which is also what notices
# when a file was edited by hand, or by a git pull, and reads it back in.
#
# What that costs: a change is acknowledged a few milliseconds before it is
# on disk. If the disk stops accepting writes, the server carries on from
# memory, says so loudly, and keeps retrying — but anything it could not
# write is lost if it is shut down before the disk comes back.

class JsonFile:
    """One JSON file, mirrored in memory."""

    def __init__(self, path):
        self.path = path
        self._lock = threading.Lock()
        self._loaded = False
        self._value = None       # the parsed document
        self._error = None       # or why there isn't one: missing, not JSON
        self._unsaved = None     # text waiting to be written
        self._on_disk = None     # what the disk copy looked like when we last knew

    def _signature(self):
        try:
            found = os.stat(self.path)
        except FileNotFoundError:
            return None
        return (found.st_mtime_ns, found.st_size)

    def load(self):
        """Read the file off the disk. The one slow operation here, so it runs
        at start-up and on the background thread, not while somebody waits."""
        signature = self._signature()
        try:
            with self.path.open(encoding="utf-8") as handle:
                value, error = json.loads(handle.read()), None
        except (FileNotFoundError, json.JSONDecodeError) as exc:
            value, error = None, exc

        with self._lock:
            # Something newer than the disk is waiting to be written: ours
            # stands, and the disk catches up when the write goes through.
            if self._unsaved is None:
                self._value, self._error = value, error
                self._on_disk = signature
            self._loaded = True

    def read(self):
        """The document, as a copy the caller is free to change. Raises what
        opening the file would have: FileNotFoundError, JSONDecodeError."""
        if not self._loaded:
            self.load()
        with self._lock:
            if self._error is not None:
                raise self._error.with_traceback(None)
            return copy.deepcopy(self._value)

    def write(self, value, text):
        """Take `value` as the document from now on; `text` is how it is laid
        out on disk, which happens shortly, off this thread."""
        with self._lock:
            self._value, self._error = copy.deepcopy(value), None
            self._unsaved = text
            self._loaded = True
        start_storage()
        _disk_wake.set()

    def flush(self):
        """Put the waiting text on disk. Raises OSError if the disk won't."""
        with self._lock:
            text = self._unsaved
        if text is None:
            return False

        write_atomically(self.path, text)
        signature = self._signature()

        with self._lock:
            if self._unsaved is text:       # nothing newer arrived meanwhile
                self._unsaved = None
            self._on_disk = signature
        return True

    def changed_on_disk(self):
        """Has somebody else rewritten the file — a hand edit, a git pull?
        Only a stat, which stays quick even where a read would not."""
        with self._lock:
            if self._unsaved is not None or not self._loaded:
                return False
            known = self._on_disk
        return self._signature() != known

    @property
    def unsaved(self):
        with self._lock:
            return self._unsaved is not None


INVENTORY = JsonFile(INVENTORY_PATH)
ACCOUNTS = JsonFile(ACCOUNTS_PATH)
REQUESTS = JsonFile(REQUESTS_PATH)
HISTORY = JsonFile(HISTORY_PATH)
NOTICES = JsonFile(NOTICES_PATH)
DRAFTS = JsonFile(DRAFTS_PATH)

# Files whose changes pages care about, and the name each is announced under.
FILES = {
    INVENTORY: "inventory",
    REQUESTS: "requests",
    HISTORY: "history",
    ACCOUNTS: None,
    NOTICES: None,
    DRAFTS: None,
}

_disk_wake = threading.Event()
_disk_thread = None
_disk_thread_lock = threading.Lock()

# Whether the last attempt to write succeeded. Pages are told when this flips,
# because "your changes are only in memory" is something people working the
# shelves need to know and can't see.
_disk_ok = True

DISK_RETRY_SECONDS = 5       # between attempts while the disk is refusing
DISK_WATCH_SECONDS = 2       # how often to look for edits made outside the app
DISK_SLOW_SECONDS = 1.0      # a write slower than this is worth a line in the log


def storage_state():
    return "ok" if _disk_ok else "stalled"


def _set_disk_ok(ok, why=""):
    global _disk_ok
    if ok == _disk_ok:
        return
    _disk_ok = ok

    if ok:
        app.logger.warning("the disk is taking writes again; everything is saved")
    else:
        app.logger.error(
            "CANNOT WRITE TO DISK (%s). Still running from memory and retrying "
            "every %ss. Changes made from here on are NOT saved until this "
            "clears. Do not stop the server while this is showing.",
            why, DISK_RETRY_SECONDS)

    with _listeners_lock:
        waiting = list(_listeners)
    send_to(waiting, f"event: storage\ndata: {json.dumps({'state': storage_state()})}\n\n")


def _disk_loop():
    """The only thread that reads or writes the data files once the server is
    up. If the disk is slow, this is the thing that waits — not a request."""
    last_look = 0.0

    while True:
        _disk_wake.wait(timeout=DISK_WATCH_SECONDS if _disk_ok else DISK_RETRY_SECONDS)
        _disk_wake.clear()

        try:
            for data_file in FILES:
                started = time.monotonic()
                if data_file.flush():
                    took = time.monotonic() - started
                    if took > DISK_SLOW_SECONDS:
                        app.logger.warning(
                            "writing %s took %.1fs. A local disk does this in "
                            "milliseconds; is this folder synced or on a network?",
                            data_file.path.name, took)
            _set_disk_ok(True)
        except OSError as exc:
            _set_disk_ok(False, f"{type(exc).__name__}: {exc}")
            continue

        # Pick up edits made behind the app's back, and tell the pages.
        if time.monotonic() - last_look < DISK_WATCH_SECONDS:
            continue
        last_look = time.monotonic()

        changed = []
        for data_file, name in FILES.items():
            try:
                if data_file.changed_on_disk():
                    data_file.load()
                    app.logger.info("%s changed on disk; re-read it", data_file.path.name)
                    if name:
                        changed.append(name)
            except OSError as exc:
                app.logger.warning("could not re-read %s: %s", data_file.path.name, exc)
        if changed:
            announce(*changed)


def start_storage():
    """Start the background writer. Safe to call more than once."""
    global _disk_thread
    with _disk_thread_lock:
        if _disk_thread is None or not _disk_thread.is_alive():
            _disk_thread = threading.Thread(target=_disk_loop, name="disk", daemon=True)
            _disk_thread.start()


@atexit.register
def _save_on_exit():
    """A last attempt to put anything unsaved on disk on the way out."""
    for data_file in FILES:
        try:
            data_file.flush()
        except OSError as exc:
            print(f"!! could not save {data_file.path.name} on exit: {exc}", file=sys.stderr)


def read_inventory():
    return INVENTORY.read()


def write_inventory(data):
    """Rewrite inv.json, preserving its layout and key order."""
    text = json.dumps(data, indent=4, ensure_ascii=False)
    text = _QTY_INLINE.sub(lambda match: '{"qty": %s}' % match.group(1), text)
    INVENTORY.write(data, text + "\n")


def read_requests():
    """Open requests, with any hand-written entry given an id.

    Requests are resolved by id, so an entry written straight into the file
    without one could never be taken off the queue. Backfilling on read keeps
    that from being a trap.
    """
    try:
        data = REQUESTS.read()
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
    REQUESTS.write(entries, dump_requests(entries))


def read_history():
    try:
        data = HISTORY.read()
    except (FileNotFoundError, json.JSONDecodeError):
        return []
    return data if isinstance(data, list) else []


def write_history(entries):
    HISTORY.write(entries, dump_requests(entries))


# Notices are the app's own bookkeeping rather than something anyone edits by
# hand, so they get plain json.dump instead of the laid-out writer the
# request files use.
def read_notices():
    try:
        data = NOTICES.read()
    except (FileNotFoundError, json.JSONDecodeError):
        return []
    return [entry for entry in data if isinstance(entry, dict)] if isinstance(data, list) else []


def write_notices(entries):
    # Trim per person: somebody who never dismisses anything shouldn't grow
    # the file without bound, and the oldest unread is the least useful.
    kept = []
    seen = {}
    for entry in reversed(entries):
        name = entry.get("for")
        seen[name] = seen.get(name, 0) + 1
        if seen[name] <= MAX_NOTICES_EACH:
            kept.append(entry)

    kept.reverse()
    NOTICES.write(kept, json.dumps(kept, indent=4, ensure_ascii=False) + "\n")


# Work in progress in the structural editor, one entry per person: what the
# document looked like when they opened it, and what they have made of it.
# Kept on the server so closing the tab, or somebody else saving first,
# doesn't throw away an afternoon of typing.
def read_drafts():
    try:
        data = DRAFTS.read()
    except (FileNotFoundError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def write_drafts(drafts):
    DRAFTS.write(drafts, json.dumps(drafts, indent=4, ensure_ascii=False) + "\n")


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


def hash_password(password):
    """The one place a password becomes what accounts.json stores.

    MD5, so the file no longer reads out everybody's password to anyone who
    opens it. That is the whole of what it buys: MD5 is fast and unsalted, so
    these hashes fall to a lookup table in seconds, and two people who pick
    the same password get the same hash. It is a lock on the drawer, not on
    the door.

    Everything that hashes goes through here, so trading MD5 for something
    that stands up — scrypt, bcrypt, argon2 — is a change to this function
    and a re-hash of the file, and nothing else.
    """
    return hashlib.md5(password.encode("utf-8")).hexdigest()


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
        accounts = ACCOUNTS.read()
    except FileNotFoundError:
        return jsonify({"error": f"{ACCOUNTS_PATH.name} not found"}), 500
    except json.JSONDecodeError as exc:
        return jsonify({"error": f"{ACCOUNTS_PATH.name} is not valid JSON: {exc}"}), 500

    account = accounts.get(name.strip())
    stored = str(account.get("password", "")) if isinstance(account, dict) else ""

    # Compare even when the name is unknown, and say the same thing either
    # way, so the reply doesn't tell an outsider which names are real.
    if not hmac.compare_digest(stored, hash_password(password)) or not account:
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


@app.route("/grid_rack")
def grid_rack():
    return render_template("grid_rack.html")


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
RACK_TYPES = ("std", "server", "grid")

# A rack's own settings. Every other key on a rack is one of its levels.
RACK_FIELDS = ("type", "width")

# An item class's own settings. Every other key on one is an item.
SLOT_FIELDS = ("cols", "rows")


# --------------------------- merging two editors ---------------------------
#
# The editor used to save by replacing the whole document, so whoever saved
# second quietly undid the first. Two people tidying different racks is the
# normal case, though, and neither should have to wait for the other.
#
# So a save is worked out three ways: what the document looked like when you
# opened it (base), what you made it (yours), and what it is on disk right now
# (current). Anything you didn't touch keeps whatever it says on disk, and
# anything nobody else touched takes your value. Only a field you both changed
# is a real argument, and that is reported rather than guessed at.
#
# The comparison runs on leaves, not whole racks, so "we both edited rack 5"
# is not a conflict — "we both set the count of the same item" is.

# Stands for "this key isn't in that version of the document", which is a
# different thing from a key whose value is None.
MISSING = object()

# Attribute keys are prefixed so they can't collide with a bay, a class or an
# item that happens to be called "type" or "cols".
def flatten_inventory(doc):
    """A document as a flat map of leaf path -> value, with a marker for each
    container so an empty rack or level still registers as existing."""
    flat = {}
    for rack_key, rack in (doc or {}).items():
        if not isinstance(rack, dict):
            continue
        flat[(rack_key,)] = True
        flat[(rack_key, "#type")] = rack.get("type")
        flat[(rack_key, "#width")] = rack.get("width")

        for bay_key, bay in rack.items():
            if bay_key in RACK_FIELDS or not isinstance(bay, dict):
                continue
            flat[(rack_key, bay_key)] = True

            for class_key, item_class in bay.items():
                if not isinstance(item_class, dict):
                    continue
                flat[(rack_key, bay_key, class_key)] = True
                flat[(rack_key, bay_key, class_key, "#cols")] = item_class.get("cols")
                flat[(rack_key, bay_key, class_key, "#rows")] = item_class.get("rows")

                for item_key, item in item_class.items():
                    if item_key in SLOT_FIELDS:
                        continue
                    flat[(rack_key, bay_key, class_key, item_key)] = (
                        item.get("qty") if isinstance(item, dict) else None
                    )
    return flat


def describe_key(key):
    """A leaf path, said the way the screen says it."""
    if len(key) == 1:
        return f"rack {key[0]}"
    if key[-1].startswith("#"):
        return f"{' / '.join(key[:-1])} ({key[-1][1:]})"
    return " / ".join(key)


def say_value(value):
    if value is MISSING:
        return "removed"
    if value is True:
        return "added"
    if value is None:
        return "unset"
    return str(value)


def merge_flat(base, mine, current):
    """Three-way merge of flattened documents.

    Returns the merged map and the keys we both changed — those take the
    saving editor's value, since somebody has to win and they are the one
    standing here.
    """
    merged = {}
    conflicts = []

    for key in set(base) | set(mine) | set(current):
        was = base.get(key, MISSING)
        ours = mine.get(key, MISSING)
        theirs = current.get(key, MISSING)

        if ours == was:
            value = theirs          # we left it alone; take the file's word
        elif theirs == was:
            value = ours            # nobody else touched it; take ours
        elif ours == theirs:
            value = ours            # same edit, nothing to argue about
        else:
            value = ours
            conflicts.append({
                "where": describe_key(key),
                "was": say_value(was),
                "yours": say_value(ours),
                "theirs": say_value(theirs),
            })

        if value is not MISSING:
            merged[key] = value

    conflicts.sort(key=lambda item: item["where"])
    return merged, conflicts


def changed_against(base, mine):
    """What the saving editor actually altered, for them to look over."""
    changes = []
    for key in set(base) | set(mine):
        was = base.get(key, MISSING)
        ours = mine.get(key, MISSING)
        if ours != was:
            changes.append({
                "where": describe_key(key),
                "was": say_value(was),
                "now": say_value(ours),
            })
    changes.sort(key=lambda item: item["where"])
    return changes


def _ordered(prefix, depth, merged, *sources):
    """Keys that survive at one level, in the order the sources list them, so
    a merge doesn't shuffle the file."""
    seen = set()
    out = []
    for source in sources:
        for key in source:
            if len(key) != depth or key[:depth - 1] != prefix:
                continue
            name = key[depth - 1]
            if name in seen or name.startswith("#") or (prefix + (name,)) not in merged:
                continue
            seen.add(name)
            out.append(name)
    return out


def rebuild_inventory(merged, current, mine):
    """The flat map back into the nested document inv.json stores.

    Order follows the file first and the editor second, so racks and levels
    stay where they were and anything new lands at the end."""
    order_sources = (flatten_inventory(current), flatten_inventory(mine))
    doc = {}

    for rack_key in _ordered((), 1, merged, *order_sources):
        rack = {"type": merged.get((rack_key, "#type"))}
        width = merged.get((rack_key, "#width"))
        if width is not None:
            rack["width"] = width

        for bay_key in _ordered((rack_key,), 2, merged, *order_sources):
            bay = {}
            for class_key in _ordered((rack_key, bay_key), 3, merged, *order_sources):
                item_class = {}
                for field in SLOT_FIELDS:
                    size = merged.get((rack_key, bay_key, class_key, f"#{field}"))
                    if size is not None:
                        item_class[field] = size

                for item_key in _ordered((rack_key, bay_key, class_key), 4,
                                         merged, *order_sources):
                    item_class[item_key] = {
                        "qty": merged[(rack_key, bay_key, class_key, item_key)]
                    }
                bay[class_key] = item_class
            rack[bay_key] = bay
        doc[rack_key] = rack

    return doc


def merge_inventory(base, mine, current):
    """Fold one editor's work into the document as it stands now."""
    flat_merged, conflicts = merge_flat(
        flatten_inventory(base), flatten_inventory(mine), flatten_inventory(current)
    )
    return rebuild_inventory(flat_merged, current, mine), conflicts


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

        # Standard racks aren't all the same size. Width is a fraction of a
        # full-width one, so 0.5 is half as wide; leaving it off means full.
        if "width" in rack:
            try:
                width = float(rack["width"])
            except (TypeError, ValueError):
                raise InventoryError(f"{where} has a width that isn't a number")
            if not 0 < width <= 1:
                raise InventoryError(f"{where} needs a width above 0 and at most 1")
            if width != 1:
                cleaned["width"] = round(width, 3)

        for bay_key, bay in rack.items():
            if bay_key in RACK_FIELDS:
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

                spot = f"{where}, {bay_key!r} / {class_key!r}"

                # A grid rack's blocks say how their compartments are laid
                # out. Kept ahead of the items so the shape reads first.
                items = {}
                for field in SLOT_FIELDS:
                    if field not in item_class:
                        continue
                    try:
                        size = int(item_class[field])
                    except (TypeError, ValueError):
                        raise InventoryError(f"{spot} has a {field} that isn't a whole number")
                    if size < 1:
                        raise InventoryError(f"{spot} needs at least one {field[:-1]}")
                    items[field] = size

                for item_key, item in item_class.items():
                    if item_key in SLOT_FIELDS:
                        continue
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
    """Replace the whole document, wholesale.

    The editor no longer comes this way: replacing is what let one person's
    save undo another's, so it goes through a draft and a merge instead. This
    stays for scripted bulk edits, where there is one author and no race —
    but wire a second editor up to it and the old problem comes back.
    """
    try:
        data = clean_inventory(request.get_json(silent=True))
    except InventoryError as exc:
        return jsonify({"error": str(exc)}), 400

    write_inventory(data)
    announce("inventory", origin=client_id())
    return jsonify(data)


# ----------------------------- editor drafts -----------------------------

def draft_owner():
    """Whose draft a request is about. Unverified, like every other name
    here — it decides which drawer to open, not who is allowed to."""
    payload = request.get_json(silent=True) or {}
    name = payload.get("name") or request.args.get("who") or ""
    return name.strip()


def preview_draft(draft, current):
    """What this draft would do to the document as it stands now."""
    merged, conflicts = merge_inventory(draft["base"], draft["proposed"], current)
    return {
        "at": draft.get("at", ""),
        "changes": changed_against(
            flatten_inventory(draft["base"]), flatten_inventory(draft["proposed"])
        ),
        "conflicts": conflicts,
    }, merged


@app.get("/api/inventory/draft")
def read_draft():
    """Whatever this person had in the editor when they last left it."""
    name = draft_owner()
    if not name:
        return jsonify({"error": "who is asking?"}), 400

    draft = read_drafts().get(name)
    if not draft:
        return jsonify({"draft": None})

    try:
        current = read_inventory()
    except (FileNotFoundError, json.JSONDecodeError) as exc:
        return jsonify({"error": f"{INVENTORY_PATH.name}: {exc}"}), 500

    summary, _ = preview_draft(draft, current)
    return jsonify({"draft": draft["proposed"], "base": draft["base"], **summary})


@app.post("/api/inventory/draft")
def save_draft():
    """Put the editor's working copy aside without touching inv.json.

    Answers with what applying it would do — what this person changed, and
    anything somebody else has changed underneath them since they started.
    """
    payload = request.get_json(silent=True) or {}
    name = draft_owner()
    if not name:
        return jsonify({"error": "a draft needs a name to belong to"}), 400

    try:
        proposed = clean_inventory(payload.get("proposed"))
    except InventoryError as exc:
        return jsonify({"error": str(exc)}), 400

    base = payload.get("base")
    if not isinstance(base, dict):
        return jsonify({"error": "a draft needs the document it started from"}), 400

    draft = {
        "at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "base": base,
        "proposed": proposed,
    }

    if not _drafts_lock.acquire(timeout=DRAFTS_LOCK_WAIT):
        return jsonify({"error": f"{DRAFTS_PATH.name} is busy, try again"}), 503
    try:
        drafts = read_drafts()
        drafts[name] = draft
        write_drafts(drafts)
    except OSError as exc:
        app.logger.warning("could not save %s's draft: %s", name, exc)
        return jsonify({"error": f"could not reach {DRAFTS_PATH.name}"}), 503
    finally:
        _drafts_lock.release()

    try:
        current = read_inventory()
    except (FileNotFoundError, json.JSONDecodeError) as exc:
        return jsonify({"error": f"{INVENTORY_PATH.name}: {exc}"}), 500

    summary, _ = preview_draft(draft, current)
    return jsonify(summary), 201


@app.delete("/api/inventory/draft")
def discard_draft():
    """Throw the working copy away. inv.json was never touched."""
    name = draft_owner()
    if not name:
        return jsonify({"error": "who is asking?"}), 400

    if not _drafts_lock.acquire(timeout=DRAFTS_LOCK_WAIT):
        return jsonify({"error": f"{DRAFTS_PATH.name} is busy, try again"}), 503
    try:
        drafts = read_drafts()
        existed = drafts.pop(name, None) is not None
        if existed:
            write_drafts(drafts)
    except OSError as exc:
        app.logger.warning("could not discard %s's draft: %s", name, exc)
        return jsonify({"error": f"could not reach {DRAFTS_PATH.name}"}), 503
    finally:
        _drafts_lock.release()

    return jsonify({"discarded": existed})


@app.post("/api/inventory/draft/confirm")
def confirm_draft():
    """Fold the draft into inv.json and let it go.

    The merge is worked out again here rather than trusting the preview: the
    file may have moved on in the seconds between looking and saying yes.
    """
    name = draft_owner()
    if not name:
        return jsonify({"error": "who is asking?"}), 400

    draft = read_drafts().get(name)
    if not draft:
        return jsonify({"error": "there is no draft to apply"}), 404

    try:
        current = read_inventory()
    except (FileNotFoundError, json.JSONDecodeError) as exc:
        return jsonify({"error": f"{INVENTORY_PATH.name}: {exc}"}), 500

    merged, conflicts = merge_inventory(draft["base"], draft["proposed"], current)

    try:
        data = clean_inventory(merged)
    except InventoryError as exc:
        return jsonify({"error": f"the merged inventory doesn't hold up: {exc}"}), 409

    write_inventory(data)

    if not _drafts_lock.acquire(timeout=DRAFTS_LOCK_WAIT):
        app.logger.warning("applied %s's draft but could not clear it", name)
    else:
        try:
            drafts = read_drafts()
            drafts.pop(name, None)
            write_drafts(drafts)
        except OSError as exc:
            app.logger.warning("applied %s's draft but could not clear it: %s", name, exc)
        finally:
            _drafts_lock.release()

    announce("inventory", origin=client_id())
    return jsonify({"applied": True, "conflicts": conflicts, "inventory": data})


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


@app.get("/api/notices")
def list_notices():
    """Whatever `who` still has waiting.

    The stream hands these over when a page connects, so this is the fallback
    for a page whose stream hasn't come up yet.
    """
    return jsonify(notices_for(request.args.get("who")))


@app.post("/api/notices/<notice_id>/dismiss")
def dismiss_notice(notice_id):
    """Put a notice away. The only thing that ever removes one."""
    if not _notices_lock.acquire(timeout=NOTICES_LOCK_WAIT):
        return jsonify({"error": f"{NOTICES_PATH.name} is busy, try again"}), 503

    try:
        pending = read_notices()
        kept = [entry for entry in pending if entry.get("id") != notice_id]

        if len(kept) == len(pending):
            return jsonify({"error": f"no notice with id {notice_id}"}), 404

        write_notices(kept)
    except OSError as exc:
        app.logger.warning("could not dismiss %s: %s", notice_id, exc)
        return jsonify({"error": f"could not reach {NOTICES_PATH.name}"}), 503
    finally:
        _notices_lock.release()

    return jsonify({"dismissed": notice_id, "waiting": len(kept)})


# ------------------------------- start-up -------------------------------

# Where a project folder ends up when something is syncing it. Files in these
# can be "in the cloud" rather than on the disk, and reading one then needs
# the internet — on a network without it, the read hangs and times out.
SYNCED_FOLDERS = (
    ("/Library/Mobile Documents/", "iCloud Drive"),
    ("/Library/CloudStorage/", "a cloud drive (Google Drive, OneDrive or Dropbox)"),
    ("/Google Drive", "Google Drive"),
    ("/GoogleDrive", "Google Drive"),
    ("/OneDrive", "OneDrive"),
    ("/Dropbox", "Dropbox"),
)

# macOS marks a file whose contents are in the cloud and not on this disk.
SF_DATALESS = 0x40000000


def data_folder_warnings():
    """Reasons to expect this folder to be slow or unreadable offline."""
    folder = str(INVENTORY_PATH.parent.resolve())
    found = []

    for marker, service in SYNCED_FOLDERS:
        if marker.lower() in (folder + "/").lower():
            found.append(
                f"This folder is inside {service}. Its files can live in the cloud "
                "instead of on this disk, and reading them then needs the internet.")
            break
    else:
        home = str(Path.home())
        if sys.platform == "darwin" and any(
                (folder + "/").startswith(f"{home}/{part}/") for part in ("Desktop", "Documents")):
            found.append(
                "This folder is under Desktop or Documents. If 'Desktop & Documents "
                "Folders' is switched on in iCloud settings, macOS syncs it, and its "
                "files can need the internet to read.")

    for data_file in FILES:
        try:
            flags = getattr(os.stat(data_file.path), "st_flags", 0)
        except OSError:
            continue
        if flags & SF_DATALESS:
            found.append(
                f"{data_file.path.name} is NOT on this disk right now: macOS is keeping "
                "it in the cloud. It cannot be read without the internet.")

    return found


def load_data_files():
    """Read every data file into memory before taking a request, and say so
    plainly if the disk is the kind that will cause trouble later."""
    say = lambda text: print(text, file=sys.stderr, flush=True)
    warnings = data_folder_warnings()

    for data_file in FILES:
        started = time.monotonic()
        try:
            data_file.load()
        except OSError as exc:
            say(f"\n!! Could not read {data_file.path.name}: {exc}")
            say("!! This is what a file kept in the cloud, or on a network drive, looks")
            say("!! like when the machine can't reach it. The server cannot start without")
            say("!! its data. Move the whole project folder somewhere that is only on")
            say(f"!! this computer (for example {Path.home() / 'tka_inventory'}) and run it")
            say("!! from there.")
            for line in warnings:
                say(f"!!   - {line}")
            raise SystemExit(1)

        took = time.monotonic() - started
        if took > 0.5:
            warnings.append(
                f"Reading {data_file.path.name} took {took:.1f}s. A local disk takes "
                "a few milliseconds.")

    if warnings:
        say("\n" + "=" * 74)
        say("WARNING: this folder may not be a plain local folder.")
        for line in warnings:
            say(f"  - {line}")
        say("  The server holds its data in memory, so requests will not wait on the")
        say("  disk. But saving can stall when this machine is offline, and anything")
        say("  not saved is lost if the server is stopped. Moving the project folder")
        say(f"  somewhere local (for example {Path.home() / 'tka_inventory'}) fixes it for good.")
        say("=" * 74 + "\n")

    start_storage()


if __name__ == "__main__":
    # accounts.json stores hashes now, so adding somebody means putting a
    # hash in it rather than a password:
    #
    #     python3 server.py --hash theirpassword
    #
    # which saves hunting for a hashing tool and pasting a password into one.
    if len(sys.argv) == 3 and sys.argv[1] == "--hash":
        print(hash_password(sys.argv[2]))
        raise SystemExit(0)

    load_data_files()

    # threaded is the default, but say so: every open page holds an event
    # stream for as long as it is open, and a single-threaded server would
    # serve the first one and hang for everybody else.
    app.run(host="::", debug=False, port=8000, threaded=True)
