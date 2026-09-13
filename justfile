set shell := ["bash", "-uc"]

default: check

dev:
  bun run dev

install:
  bun install

check:
  bun run check

test:
  bun run test

test-integration:
  DATABASE_URL=${DATABASE_URL:-postgres://postgres:postgres@localhost:5432/app} bun run test:integration

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

db-push:
  bun run db:push

db-studio:
  bun run db:studio
