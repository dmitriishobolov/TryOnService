# Coordinator Persistence

Persistence слой выбирает, где coordinator хранит состояние jobs, worker registry, client registry и storage-node registry.

## Backends

- `memory` - dev backend по умолчанию. Быстрый локальный запуск, состояние теряется при рестарте.
- `postgres` - production-направление. Coordinator сам создает таблицы `tryon_jobs`, `tryon_workers`, `tryon_clients`, `tryon_storage_nodes` и `tryon_storage_objects`, если их еще нет.

## Важная граница

Postgres принадлежит coordinator. Worker и client не получают `POSTGRES_URL` и не пишут в БД напрямую. Они меняют состояние через coordinator API.

## Env

- `COORDINATOR_PERSISTENCE=memory|postgres`
- `POSTGRES_URL=postgres://user:password@host:5432/db`
- `POSTGRES_SSL=false`
- `POSTGRES_MAX_CONNECTIONS=10`
