#!/bin/sh
# Runs forge inside contracts/. macOS writes "._*" AppleDouble files on exFAT
# drives and solc cannot read them, so they are removed first.
set -e
cd "$(dirname "$0")/../contracts"
find . ../node_modules/@primuslabs ../node_modules/@openzeppelin -name '._*' -type f -delete 2>/dev/null || true
exec forge "$@"
