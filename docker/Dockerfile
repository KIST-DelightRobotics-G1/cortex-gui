# Display renderer container: the static page + the mock publisher.
#
# Separate from the cortex image on purpose — the renderer is a browser page
# and only needs a static file server; cortex (gui_bridge_node) serves the
# websocket it connects to (:8081).
#
# Self-contained: the page is baked in via COPY. For iterative dev, shadow it
# with a bind mount (see run.sh).
FROM python:3.12-slim

# mock_publisher.py only (the page itself needs nothing): websockets for the
# fake :8081 server, pillow for its fake camera frames.
RUN pip install --no-cache-dir websockets==16.1.1 pillow==12.3.0

WORKDIR /srv/cortex-gui
COPY index.html config.js app.js style.css ./
COPY tools ./tools

ENV GUI_PORT=8080
CMD python -m http.server "${GUI_PORT}"
