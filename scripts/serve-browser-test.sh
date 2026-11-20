#!/bin/sh
set -eu
state=$(mktemp -d)
trap 'rm -rf "$state"' EXIT
trap 'exit 0' TERM INT
export XDG_CONFIG_HOME="$state/config"
export WRANGLER_SEND_METRICS=false
./node_modules/.bin/wrangler dev --local --ip 127.0.0.1 --port 8791 --persist-to "$state/storage" &
wait $!
