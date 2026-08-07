# Declarative task runner. Every common operation is a named, idempotent target.
# Usage: `make up`, `make test`, `make ci` etc.
COMPOSE      := docker compose
COMPOSE_DEV  := $(COMPOSE) -f docker-compose.yml -f docker-compose.dev.yml

.DEFAULT_GOAL := help

.PHONY: help
help: ## Show available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

.PHONY: up
up: ## Start the full stack (prod-style images)
	$(COMPOSE) up -d --build

.PHONY: dev
dev: ## Start with hot reload (backend + vite + postgres)
	$(COMPOSE_DEV) up --build

.PHONY: down
down: ## Stop and remove containers
	$(COMPOSE) down

.PHONY: clean
clean: ## Stop containers and remove the database volume (DESTRUCTIVE)
	$(COMPOSE) down -v

.PHONY: logs
logs: ## Tail logs from all services
	$(COMPOSE) logs -f --tail=100

.PHONY: ps
ps: ## Show service status
	$(COMPOSE) ps

.PHONY: migrate
migrate: ## Apply pending Alembic migrations
	$(COMPOSE) exec backend alembic upgrade head

.PHONY: revision
revision: ## Autogenerate a new migration (m=<message>)
	$(COMPOSE) exec backend alembic revision --autogenerate -m "$(m)"

.PHONY: lint
lint: ## Run ruff linter + formatter check
	$(COMPOSE) exec backend ruff check app tests

.PHONY: format
format: ## Auto-format with ruff
	$(COMPOSE) exec backend ruff format app tests && ruff check --fix app tests

.PHONY: test
test: ## Run the pytest suite
	$(COMPOSE) exec backend pytest -q

.PHONY: shell
shell: ## Open a shell in the backend container
	$(COMPOSE) exec backend /bin/bash

.PHONY: psql
psql: ## Open a psql prompt against the database
	$(COMPOSE_DEV) run --rm psql

.PHONY: ci
ci: lint test ## Local approximation of the CI pipeline
