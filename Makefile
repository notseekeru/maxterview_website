DEV_CMD     = docker compose -p maxterview-dev -f compose.yml -f compose.dev.yml
PROD_CMD    = docker compose -p maxterview-prod -f compose.yml -f compose.prod.yml
DEV_PROJECT = maxterview-dev
PROD_PROJECT = maxterview-prod
FRONTEND_DEV = maxterview_frontend_dev
BACKEND_DEV  = maxterview_backend_dev
PORTS        = 8000 5173 5432

exec:
	@echo "**---------Checking Frontend...-----------**"
	docker exec -t $(FRONTEND_DEV) sh -c "npm ci && npx biome check . && npm run typecheck && npx vite build --outDir /tmp/dist --emptyOutDir && (npm audit --audit-level=moderate || true)"

	@echo "**---------Checking Backend...-----------**"
	docker exec -t $(BACKEND_DEV) sh -c "npm ci && npx biome check . && npm run typecheck && npm run build && npx vitest run"

lint:
	docker exec -t $(FRONTEND_DEV) sh -c "npx biome check . --write --unsafe"
	docker exec -t $(BACKEND_DEV) sh -c "npm run lint"

env-sync-dev: ## Pull the credential lines into .env and backend/.env from Infisical dev, then sync-check both against their templates. The only target that needs the network.
	@scripts/env-sync-dev.sh
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
	docker exec -t $(BACKEND_DEV) npx tsx scripts/migrate.ts apply
rollback:
	docker exec -t $(BACKEND_DEV) npx tsx scripts/migrate.ts rollback
new-migration:
	@test -n "$(name)" || (echo "usage: make new-migration name=<name>" && exit 1)
	@n=$$(ls backend/migrations/*.sql | sed -n 's#.*/\([0-9]\{4\}\)_.*#\1#p' | sort -n | tail -1); \
		touch backend/migrations/$$(printf '%04d' $$((10#$$n + 1)))_$(name).sql

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
	@fail=0; for svc in frontend backend; do \
		ctx=$$svc; [ "$$svc" = backend ] && ctx=backend; \
		echo "== scanning maxterview-prod-$$svc =="; \
		docker run --rm \
			-v /var/run/docker.sock:/var/run/docker.sock \
			-v $(CURDIR)/$$ctx/.trivyignore.yaml:/.trivyignore.yaml \
			aquasec/trivy:0.74.0 image \
			--skip-dirs "root/.cache,usr/local" \
			--pkg-types os \
			--severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 \
			--ignorefile /.trivyignore.yaml \
			maxterview-prod-$$svc || fail=1; \
	done; exit $$fail
