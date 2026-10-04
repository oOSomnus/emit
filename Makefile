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
        test-gate patch e2e e2e-web mock

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

help:
	@echo "emit · Make 目标（未列出则运行 make）"
	@echo ""
	@echo "  make [all|native]   构建本机单文件二进制（默认目标）"
	@echo "  make binary         同上；总是重新构建"
	@echo "  make smoke          构建并运行原生二进制冒烟测试"
	@echo "  make install        按锁文件安装/校验依赖（stamp 未过期时跳过）"
	@echo "  make dev            构建前端并启动开发服务器（watch）"
	@echo "  make dev-web        仅 watch 构建前端"
	@echo "  make dev-server     仅启动后端（tsx watch）"
	@echo "  make start          构建前端并启动应用"
	@echo "  make build          类型检查并构建前端"
	@echo "  make build-web      仅构建前端"
	@echo "  make typecheck      类型检查服务端、前端与浏览器测试"
	@echo "  make test           运行 vitest；ARGS 传入筛选参数"
	@echo "  make test-watch     监听模式运行 vitest"
	@echo "  make patch          重新应用 Pi Durable 补丁"
	@echo "  make mock           用真实模型凭据启动隔离测试工作区并运行应用"
	@echo "                      发送消息会调用真实模型并可能产生费用"
	@echo "  make e2e            构建前端并运行 Vitest 端到端项目"
	@echo "  make e2e-web        构建前端并运行桌面与移动 Chromium 浏览器测试"
	@echo "  make test-api       运行 HTTP API 契约测试"
	@echo "  make test-fault     运行显式手动故障测试"
	@echo "  make test-stress    运行显式手动压力测试"
	@echo "  make test-gate      顺序运行完整日常门禁"
	@echo ""
	@echo "参数示例："
	@echo "  make test ARGS='test/mock.test.ts'"
	@echo "  make start ARGS='--port 8787'"
	@echo "  make mock ARGS='--source-data-dir /home/me/.emit --port 8787'"
	@echo ""
	@echo "make mock 只读取真实工作区的模型与凭据配置，工作数据和运行都不落在真实目录。"
