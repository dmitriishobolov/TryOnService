# Worker

Worker - сервис-исполнитель TryOnService. Он запускается на отдельном сервере, регистрируется в coordinator и выполняет тяжелую обработку клиентских данных через AI API.

Worker можно масштабировать горизонтально: поднимаем новый экземпляр, он сообщает coordinator о готовности, после чего scheduler может назначать ему jobs.

## Запуск

```bash
npm run dev:worker
```

По умолчанию worker слушает `http://localhost:4001`, регистрируется в `http://localhost:3000` и отправляет heartbeat каждые 5 секунд.

## Подпапки

- [api](api/README.md) - связь worker'а с coordinator и, при необходимости, локальные service endpoints.
- [config](config/README.md) - настройки worker, AI API keys, лимиты и адрес coordinator.
- [models](models/README.md) - адаптеры к AI API и конкретным моделям.
- [runner](runner/README.md) - пайплайны обработки данных клиента.
- [utils](utils/README.md) - общие утилиты worker'а.

## Жизненный цикл

1. Worker стартует и загружает config.
2. Worker формирует `workerId`, `capacity` и список `capabilities`.
3. Worker регистрируется в coordinator через API и registration key.
4. Worker регулярно отправляет heartbeat.
5. Worker получает назначенную job или сам забирает job из coordinator, в зависимости от выбранной модели доставки.
6. Runner выполняет обработку и вызывает нужные adapters из `models`.
7. Worker отправляет прогресс, результат или ошибку обратно в coordinator.

В текущем первом срезе runner использует mock model и возвращает текст `Ответ от сервера.`.

## Принципы

- Worker не должен быть источником правды по job state.
- Временные файлы должны очищаться после обработки.
- Конкретные AI providers изолируются в `models`.
- Runner описывает бизнес-пайплайн, но не знает деталей HTTP API конкретного AI provider.
- Все входные и выходные данные сверяются с контрактами из `apps/shared`.
