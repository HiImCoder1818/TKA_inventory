from flask import Flask, render_template

app = Flask(__name__)


@app.route("/")
def index():
    return render_template("index.html")


# Both rack views take the rack number from ?rack=N and read the rest out of
# the shared registry in static/scripts/racks-data.js.
@app.route("/std_rack")
def std_rack():
    return render_template("std_rack.html")


@app.route("/server_rack")
def server_rack():
    return render_template("server_rack.html")


if __name__ == "__main__":
    app.run(debug=True)
