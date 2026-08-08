COMPOSE   := docker compose
DEV_CMD   := $(COMPOSE) -p maxterview-dev -f compose.yml -f compose.dev.yml
PROD_CMD  := $(COMPOSE) -p maxterview-prod -f compose.yml -f compose.prod.yml
PORTS     := 8000 5173 5432

.PHONY: check-ports
check-ports:
	@scripts/port-claimer.sh --self maxterview-dev $(PORTS)

.PHONY: up
up: check-ports
	$(DEV_CMD) up -d

.PHONY: build
build:
	$(PROD_CMD) up -d --build

.PHONY: down
down:
	$(DEV_CMD) down

.PHONY: clean
clean:
	$(DEV_CMD) down -v

.PHONY: prod-down
prod-down:
	$(PROD_CMD) down -v

.PHONY: logs
logs:
	$(DEV_CMD) logs -f --tail=100

.PHONY: ps
ps:
	$(DEV_CMD) ps

.PHONY: migrate
migrate:
	$(DEV_CMD) exec backend sh -c 'yoyo apply --database "$$DATABASE_URL" /app/migrations'

.PHONY: rollback
rollback:
	$(DEV_CMD) exec backend sh -c 'yoyo rollback --database "$$DATABASE_URL" /app/migrations'

.PHONY: new-migration
new-migration:
	@test -n "$(name)" || (echo "usage: make new-migration name=<name>" && exit 1)
	touch backend/migrations/$$(date +%s)_$(name).sql

.PHONY: lint
lint:
	$(DEV_CMD) exec backend ruff check app tests

.PHONY: format
format:
	$(DEV_CMD) exec backend ruff format app tests && ruff check --fix app tests

.PHONY: test
test:
	$(DEV_CMD) exec backend pytest -q

.PHONY: shell
shell:
	$(DEV_CMD) exec backend /bin/bash

.PHONY: psql
psql:
	$(DEV_CMD) run --rm psql

.PHONY: ci
ci: lint test
