# maxterview — declarative task runner.
# Usage: `make up`, `make test`, `make ci` etc.
COMPOSE   := docker compose
DEV_CMD   := $(COMPOSE) -p maxterview-dev -f compose.yml -f compose.dev.yml
PROD_CMD  := $(COMPOSE) -p maxterview-prod -f compose.yml -f compose.prod.yml
PORTS     := 8000 5173 5432

.DEFAULT_GOAL := help

.PHONY: help
help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

.PHONY: check-ports
check-ports: ## Ensure dev ports are free (frees ports held by other compose projects)
	@scripts/port-claimer.sh --self maxterview-dev $(PORTS)

.PHONY: up
up: check-ports ## Start the dev stack (postgres + backend + frontend)
	$(DEV_CMD) up -d --build

.PHONY: dev
dev: check-ports ## Dev with hot reload, attached logs
	$(DEV_CMD) up --build

.PHONY: prod
prod: ## Build + start prod-style images
	$(PROD_CMD) up -d --build

.PHONY: down
down: ## Stop the dev stack
	$(DEV_CMD) down

.PHONY: clean
clean: ## Stop dev stack and remove the database volume (DESTRUCTIVE)
	$(DEV_CMD) down -v

.PHONY: prod-down
prod-down: ## Stop the prod-style stack
	$(PROD_CMD) down -v

.PHONY: logs
logs: ## Tail dev logs
	$(DEV_CMD) logs -f --tail=100

.PHONY: ps
ps: ## Show dev service status
	$(DEV_CMD) ps

.PHONY: migrate
migrate: ## Apply pending .sql migrations in order
	@for f in $$(ls backend/migrations/*.sql | sort); do \
		echo "==> $${f}"; \
		$(DEV_CMD) run --rm -T psql -v ON_ERROR_STOP=1 -f /migrations/$$(basename $${f}); \
	done

.PHONY: lint
lint: ## Run ruff linter
	$(DEV_CMD) exec backend ruff check app tests

.PHONY: format
format: ## Auto-format with ruff
	$(DEV_CMD) exec backend ruff format app tests && ruff check --fix app tests

.PHONY: test
test: ## Run the pytest suite
	$(DEV_CMD) exec backend pytest -q

.PHONY: shell
shell: ## Open a shell in the backend container
	$(DEV_CMD) exec backend /bin/bash

.PHONY: psql
psql: ## Open a psql prompt against the database
	$(DEV_CMD) run --rm psql

.PHONY: ci
ci: lint test ## Local approximation of the CI pipeline
