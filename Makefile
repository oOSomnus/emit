# Emit Make entry points.
#
# `make` (or `make native`/`make binary`) builds one executable for the host
# OS/architecture. Every other project workflow has its own target; dependency
# installation is shared through the stamp below and only reruns when the
# manifest, the lockfile, or the Pi patch script changes.
#
# Runtime arguments go through ARGS, for example:
#   make test ARGS='test/mock.test.ts'
#   make start ARGS='--port 8787'
#   make mock ARGS='--source-data-dir /home/me/.emit --port 8787'

.DEFAULT_GOAL := all
.PHONY: all binary native smoke help install dev dev-web dev-server start \
        build build-web typecheck test test-watch test-api test-fault test-stress \
        test-gate patch e2e e2e-web mock clean nuke

ARGS ?=

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

# Install/verify dependencies from the lockfile; a no-op while the stamp holds.
install: node_modules/.emit-deps

dev: node_modules/.emit-deps
	npm run dev -- $(ARGS)

dev-web: node_modules/.emit-deps
	npm run dev:web -- $(ARGS)

dev-server: node_modules/.emit-deps
	npm run dev:server -- $(ARGS)

# The application serves compiled frontend assets, so build them first.
start: build-web
	npm start -- $(ARGS)

build: node_modules/.emit-deps
	npm run build

build-web: node_modules/.emit-deps
	npm run build:web

typecheck: node_modules/.emit-deps
	npm run typecheck

test: node_modules/.emit-deps
	npm test -- $(ARGS)

test-watch: node_modules/.emit-deps
	npm run test:watch -- $(ARGS)

patch: node_modules/.emit-deps
	node scripts/apply-pi-durable-patch.mjs

# Run the isolated Vitest end-to-end project.
e2e: build-web
	npm run test:e2e -- $(ARGS)

# Run browser end-to-end tests against the freshly built web assets.
e2e-web: build-web
	npm run test:browser -- $(ARGS)

test-api: node_modules/.emit-deps
	npm run test:api -- $(ARGS)

test-fault: node_modules/.emit-deps
	npm run test:fault -- $(ARGS)

test-stress: node_modules/.emit-deps
	npm run test:stress -- $(ARGS)

test-gate: node_modules/.emit-deps
	npm run test:gate -- $(ARGS)

# Rebuild a private mock workspace from the real data directory's committed
# configuration (models, credentials) and start the real server on it.
# Sending messages calls the configured real models and may cost money.
mock: build-web
	node --import tsx scripts/mock.ts $(ARGS)

# Remove build and test artifacts. Runtime state (data/, tmp/, credentials,
# .env*) stays; only the listed artifact directories are deleted.
clean:
	rm -rf -- dist coverage test-results playwright-report

# clean plus the installed dependency tree; the next build reruns npm ci.
nuke: clean
	rm -rf -- node_modules

help:
	@echo "emit · Make targets (run make for the default target)"
	@echo ""
	@echo "  make [all|native]   build the native single-file binary (default target)"
	@echo "  make binary         same; always rebuild"
	@echo "  make smoke          build and run the native-binary smoke suite"
	@echo "  make install        install/check dependencies from lockfile (skip while stamp is fresh)"
	@echo "  make dev            build frontend and start the development server (watch)"
	@echo "  make dev-web        watch the frontend build only"
	@echo "  make dev-server     start the backend only (tsx watch)"
	@echo "  make start          build frontend and start the app"
	@echo "  make build          typecheck and build frontend"
	@echo "  make build-web      build frontend only"
	@echo "  make typecheck      typecheck server, frontend, and browser tests"
	@echo "  make test           run vitest; pass filters via ARGS"
	@echo "  make test-watch     run vitest in watch mode"
	@echo "  make patch          reapply the Pi Durable patch"
	@echo "  make mock           start the app with a disposable test workspace using real model credentials"
	@echo "                      sending messages calls real models and may incur costs"
	@echo "  make e2e            build frontend and run the Vitest end-to-end project"
	@echo "  make e2e-web        build frontend and run desktop and mobile Chromium browser tests"
	@echo "  make test-api       run the HTTP API contract tests"
	@echo "  make test-fault     run explicit manual fault tests"
	@echo "  make test-stress    run explicit manual stress tests"
	@echo "  make test-gate      run the full daily gate sequentially"
	@echo "  make clean          remove build/test artifacts (dist, coverage, test-results, playwright-report)"
	@echo "  make nuke           clean plus node_modules; next build reinstalls dependencies"
	@echo ""
	@echo "Argument examples:"
	@echo "  make test ARGS='test/mock.test.ts'"
	@echo "  make start ARGS='--port 8787'"
	@echo "  make mock ARGS='--source-data-dir /home/me/.emit --port 8787'"
	@echo ""
	@echo "make mock reads only model and credential configuration from the real workspace; work data and runs stay out of the real directory."
