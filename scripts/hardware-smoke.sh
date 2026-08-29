#!/bin/sh
set -eu

backend="${1:-wip}"

if [ "$backend" != "wip" ] && [ "$backend" != "cdp" ]; then
    echo "usage: $0 [wip|cdp]" >&2
    exit 64
fi

sudo ios-safari-debug backend set "$backend"
ios-safari-debug doctor --json

if [ "$backend" = "wip" ]; then
    curl --fail --silent --show-error http://127.0.0.1:9221/json
else
    curl --fail --silent --show-error http://127.0.0.1:9333/json/version
    curl --fail --silent --show-error http://127.0.0.1:9333/json/list
fi
