#!/usr/bin/env bash
# Serve the display from a persistent named container (kist-cortex-gui).
#
#   docker/run.sh                     start serving on :8080 (re-run: restarts it)
#   docker/run.sh mock [args]         fake publisher on :8081 inside the container,
#                                     e.g.  docker/run.sh mock --scenario fail --loop
#   docker/run.sh logs                follow the server log
#
# Then open  http://<this-host>:8080/?ws=ws://<cortex-host>:8081
# (same host: the ?ws= part can be left out).
#
#   --network host     :8080 (page) and, for mock, :8081 on the host directly
#   --restart unless-stopped
#                      comes back after a reboot until you `docker rm -f kist-cortex-gui`
#
# Iterative dev: add  -v "$(pwd)":/srv/cortex-gui  to serve your working copy
# (docker rm -f kist-cortex-gui first; mounts are fixed at creation).
set -euo pipefail

CONTAINER=kist-cortex-gui
IMAGE=kist-cortex-gui
GUI_PORT="${GUI_PORT:-8080}"

case "${1:-}" in
    mock)
        shift
        exec docker exec -it "${CONTAINER}" python tools/mock_publisher.py "$@"
        ;;
    logs)
        exec docker logs -f "${CONTAINER}"
        ;;
esac

if [ "$(docker ps -aq -f name=^${CONTAINER}$)" ]; then
    docker restart "${CONTAINER}" >/dev/null
else
    docker run -d --name "${CONTAINER}" \
        --network host \
        --restart unless-stopped \
        -e GUI_PORT="${GUI_PORT}" \
        "${IMAGE}" >/dev/null
fi
echo "serving on http://localhost:${GUI_PORT}/  (add ?ws=ws://<cortex-host>:8081 if cortex runs elsewhere)"
