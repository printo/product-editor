#!/bin/sh
set -e

# Next.js's own "standalone" server prints a startup banner like
# "- Local: http://localhost:3000" using the CONTAINER's internal port
# (from $PORT). It has no idea Docker Compose remaps that port on the host
# (FRONTEND_HOST_PORT in .env — e.g. 5005 here, so pops/riderpro can keep
# 5004 on the same machine), so that line is misleading outside the
# container. Print the actual host-reachable URLs first so they're not lost
# above Next's banner in `docker compose up` output.
HOST_PORT="${FRONTEND_HOST_PORT:-5004}"
echo ""
echo "Container listens internally on port ${PORT:-3000}. From the HOST machine, open:"
echo "  http://localhost:${HOST_PORT}   (direct — bypasses nginx TLS)"
echo "  https://localhost               (via nginx proxy, self-signed cert in dev)"
echo ""

exec node server.js
