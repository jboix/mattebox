#!/usr/bin/env bash
# Fails the build on any banned TypeScript construct's footprint in the modern output.
# Checks emitted output rather than an AST rule per feature — catches the actual harm.
set -euo pipefail

if grep -rEl '__publicField|tslib|regenerator|__decorate|__createBinding|__spreadArray' \
  dist/ --include='*.js' --exclude-dir=legacy; then
  echo "ERROR: banned TypeScript construct found in modern output"
  exit 1
fi

# The modern build must have no runtime imports outside itself
if grep -rEl "from ['\"][^./]" dist/ --include='*.js' --exclude-dir=legacy; then
  echo "ERROR: bare import specifier in output — a runtime dependency leaked in"
  exit 1
fi

echo "emit check passed"
