DEV_CMD     = docker compose -p maxterview-dev -f compose.yml -f compose.dev.yml
PROD_CMD    = docker compose -p maxterview-prod -f compose.yml -f compose.prod.yml
DEV_PROJECT = maxterview-dev
PROD_PROJECT = maxterview-prod
FRONTEND_DEV = maxterview_frontend_dev
BACKEND_DEV  = maxterview_backend_dev
PORTS        = 8000 5173 5432

exec:
	@echo "**---------Checking Frontend...-----------**"
	docker exec -t $(FRONTEND_DEV) sh -c "npm ci && npx biome check . && npm run typecheck && npm run build && (npm audit --audit-level=moderate || true)"

	@echo "**---------Checking Backend...-----------**"
	docker exec -t $(BACKEND_DEV) sh -c "uv sync --frozen && uv run ruff check src tests && uv run ruff format --check src tests && uv run pytest -q"

lint:
	docker exec -t $(FRONTEND_DEV) sh -c "npx biome check . --write --unsafe"
	docker exec -t $(BACKEND_DEV) sh -c "uv run ruff check src tests"

test-llm: ## End-to-end LLM smoke test (needs live model + running stack). See scripts/llm-smoke.sh.
	@scripts/llm-smoke.sh
# DEV
check-ports:
	@scripts/port-claimer.sh --self $(DEV_PROJECT) $(PORTS)

up: check-ports
	$(DEV_CMD) up -d
build:
	$(DEV_CMD) build
buildcache:
	$(DEV_CMD) build --no-cache
down:
	$(DEV_CMD) down
clean:
	$(DEV_CMD) down -v
logs:
	$(DEV_CMD) logs -f --tail=100
ps:
	$(DEV_CMD) ps
shell:
	docker exec -it $(BACKEND_DEV) /bin/bash
psql:
	$(DEV_CMD) run --rm psql

migrate:
	docker exec -t $(BACKEND_DEV) bash -c 'uv run yoyo apply --no-config-file --batch --database "$$DATABASE_URL" /app/migrations'
rollback:
	docker exec -t $(BACKEND_DEV) bash -c 'uv run yoyo rollback --no-config-file --batch --database "$$DATABASE_URL" /app/migrations'
new-migration:
	@test -n "$(name)" || (echo "usage: make new-migration name=<name>" && exit 1)
	touch backend/migrations/$$(date +%s)_$(name).sql

# PROD
prod-build:
	$(PROD_CMD) build
prod-buildcache:
	$(PROD_CMD) build --no-cache
prod-up:
	$(PROD_CMD) up -d
prod-logs:
	$(PROD_CMD) logs -f
prod-down:
	$(PROD_CMD) down -v

prod-scan: prod-build
	@echo '**--- Trivy image scan: maxterview-prod-<service> ---**'
	for img in frontend backend; do \
		echo "== scanning maxterview-prod-$$img =="; \
		docker run --rm \
			-v /var/run/docker.sock:/var/run/docker.sock \
			-v $(CURDIR)/$$img/.trivyignore.yaml:/.trivyignore.yaml \
			aquasec/trivy:0.74.0 image \
			--skip-dirs "/root/.cache,app/.venv" \
			--severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 \
			--ignorefile /.trivyignore.yaml \
			maxterview-prod-$$img; \
	done
