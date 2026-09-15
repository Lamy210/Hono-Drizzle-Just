set shell := ["bash", "-uc"]
set positional-arguments

default: check

dev:
  bun run dev

install:
  bun install

init *args:
  bun run template:init -- "$@"

doctor:
  bun run template:doctor

check-fast:
  bun run check:fast

check:
  bun run check

coverage:
  bun run test:coverage

openapi-generate:
  bun run openapi:generate

openapi-verify:
  bun run openapi:contract

ci:
  DATABASE_URL=${DATABASE_URL:-postgres://postgres:postgres@localhost:5432/app} bun run ci

test:
  bun run test

test-integration:
  DATABASE_URL=${DATABASE_URL:-postgres://postgres:postgres@localhost:5432/app} bun run test:integration

test-e2e:
  DATABASE_URL=${DATABASE_URL:-postgres://postgres:postgres@localhost:5432/app} bun run test:e2e

test-all:
  DATABASE_URL=${DATABASE_URL:-postgres://postgres:postgres@localhost:5432/app} bun run test:all

format:
  bun run format

db-up:
  docker compose up -d postgres

db-down:
  docker compose down

db-reset:
  docker compose down -v
  docker compose up -d postgres

db-generate:
  bun run db:generate

db-check:
  bun run db:check

db-migrate:
  bun run db:migrate

db-verify:
  bun run db:migrations:verify

db-push:
  bun run db:push

db-studio:
  bun run db:studio
