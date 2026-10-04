# Emit native single-binary build.
#
# `make` (or `make native`) builds one executable for the host OS/architecture.
# Dependencies are installed from the lockfile on the first build and whenever
# the manifest, lockfile, or the Pi patch script changes.
.DEFAULT_GOAL := all
.PHONY: all binary native smoke

all: binary
native: binary

node_modules/.emit-deps: package.json package-lock.json scripts/apply-pi-durable-patch.mjs
	npm ci
	@touch node_modules/.emit-deps

# Always rebuild: a source or resource edit must never leave a stale bundle.
binary: node_modules/.emit-deps
	npm run build
	node scripts/build-binary.mjs

smoke: binary
	node test/native-binary.smoke.mjs
