#!/usr/bin/env bash
set -euo pipefail

export PATH="/Users/cihan/.solana-custom/bin:${PATH}"

cd "$(dirname "$0")/.."

anchor build
