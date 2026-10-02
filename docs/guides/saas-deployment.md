# Развёртывание бесплатного SaaS

Приложение обслуживает кабинет в стиле Telegram и защищённый MCP endpoint на одном HTTPS-домене. Docker Compose использует только проект `mcp-telegram`, сервис `mcp` и порт `127.0.0.1:18770`. Nginx проксирует этот порт; другие проекты не участвуют в развёртывании.

## Реквизиты и первое включение

Frontend собирается из `apps/dashboard` стандартным TypeScript без отдельного install. В браузере нет Telegram API, MTProto или сессии Telegram; API_ID/API_HASH нужны только серверу в `telegram.env`. Для сборки: `npm ci && npm run web:build`; проверка типов: `npm run web:check`. Пользователь вводит Telegram 2FA только во время серверного QR-подключения.

Установите проверенные `scripts/deploy-vps.sh` и `scripts/initialize-saas.sh` в приватный `/opt/mcp-telegram`, сохранив существующий forced SSH command и права root. Выполните инициализацию от root из этого каталога. Она создаёт новый 32-байтный `session-key.bin` с правами 0600 и владельцем 1000, а также отдельную приватную резервную копию. Существующий ключ не заменяется. Не публикуйте ключ, резервную копию, `telegram.env` или базы.

Пользователь регистрируется с логином и паролем, сохраняет коды восстановления и подключает свой Telegram по серверному QR. Все MCP-клиенты используют одну серверную сессию. OAuth ведёт к входу в тот же кабинет, после чего пользователь явно разрешает клиенту доступ. Старые аккаунты сервиса удаляются при этом выпуске по указанию владельца.

## Ограничение ресурсов

Базовые настройки: 100 пользователей, 4 worker, 3 ГБ памяти, 1 CPU, 128 PID, 45 секунд на остановку. Перед развёртыванием скрипт измеряет `MemAvailable`: при запасе 6 ГБ использует 4 worker/3 ГБ, при запасе 2,5 ГБ — 2 worker/1,5 ГБ, при меньшем запасе прекращает развёртывание до остановки текущего сервиса. Лимиты выбранного релиза записываются в его `deployment.env`. Gateway ограничен 512 МБ JS heap; каждый worker — 256 МБ. При исчерпании ёмкости API возвращает 503 с `Retry-After`, health остаётся доступен.

## Релизы и откат

GitHub Actions выполняет только сборку и деплой: публикует неизменяемый образ GHCR и передаёт его digest ограниченной SSH-команде. Автоматические тесты и отдельные CI workflow отключены по решению владельца. Образ содержит версионированный Compose. Скрипт проверяет конфигурацию и доступ к ключу от имени runtime-пользователя до остановки сервиса; healthcheck и автоматический откат остаются частью деплоя.

Остановка завершается только после выхода worker. Скрипт проверяет, что контейнер больше не работает и вышел с кодом 0, затем копирует **весь** `data/auth`, включая SQLite/WAL SaaS и OAuth, вместе с текущими Compose, image env и указателями релизов. Ключ находится за пределами этого снимка. Изменение схемы откатывается восстановлением полного снимка с прежними конфигурацией и образом; отдельные базы разных поколений не смешиваются.

Если новый контейнер нездоров, он останавливается до восстановления. Если остановка не удалась, базы остаются нетронутыми и скрипт сообщает ошибку отката. Не копируйте базы поверх работающего сервиса. Каталоги повреждённого поколения и снимки сохраняются для диагностики; глобальная очистка Docker не выполняется.

После успешного запуска `current-release` указывает на конфигурацию с проверенным image digest, `previous-release` — на предыдущую. Архивы релизов и резервные копии требуют отдельной приватной политики хранения. Потеря master key делает сохранённые Telegram-сессии нечитаемыми.

## Проверка после публикации

Проверьте `/healthz`, страницу регистрации, discovery и 401 на неавторизованном `/mcp`. Зарегистрируйтесь, сохраните recovery-коды и подключите Telegram по QR; при необходимости введите облачный пароль Telegram. Кабинет должен показать один серверный аккаунт и данные MCP. Проверки на синтетических сессиях не подтверждают настоящий вход Telegram. Проверка не требует отправки сообщений.

## Recovery and storage bounds

Password recovery replaces all eight recovery codes atomically and displays the new set once. Save them before leaving the panel. Previous SaaS cookies, OAuth login sessions, pending consent, access grants and refresh tokens lose access; OAuth must authenticate with the recovered password.

MCP media downloads have a 20 MiB file limit, 100 MiB / 100 files per user and 500 MiB / 1000 files across the service. Admission reserves a full file before dispatch, retains that reservation until the worker physically settles, and leaves at least 256 MiB free on the media filesystem. Stored files count after restart. Quota errors refuse the download before writing; deleting a Telegram MCP account purges its media. Administrators can remove expired media during maintenance after stopping the target service. These bounds cover the application media volume, not disk growth from unrelated projects or logs.

`MCP_ALLOWED_ORIGINS` is a comma-separated list of exact HTTPS origins for browser MCP requests. It applies to `/mcp`; browser SaaS account mutations still require the application's own origin and CSRF token.



## Производительность MCP

MCP ограничен 120 запросами в минуту на авторизованный аккаунт. Аккаунты, подключённые через общий IP ChatGPT, имеют независимые лимиты; неавторизованные запросы ограничиваются отдельно по IP. Кабинет также имеет лимит 120 запросов в минуту на пользователя; его опросы не расходуют общий лимит анонимных запросов. Регистрация и вход сохраняют отдельные ограничения. Отзыв разрешения проверяется перед вызовом инструмента и после его завершения, прежде чем вернуть данные клиенту.

Соединение аккаунта сохраняется до 30 минут простоя (`MCP_SAAS_WORKER_IDLE_MS`, допустимо от 60 000 до 3 600 000 мс). При заполнении общего лимита новый аккаунт может вытеснить самый давно использованный свободный worker. Занятые, запускающиеся и завершающиеся процессы не вытесняются. Место освобождается только после фактического выхода процесса; лимит CPU и памяти не повышается.

На аккаунт выполняется одна операция. До четырёх следующих вызовов могут ждать в FIFO-очереди не больше пяти секунд. Ожидание, запуск и исполнение входят в общий срок 34 секунды; отдельный исполнитель сохраняет срок 28 секунд. Отмена не освобождает процесс или медиаквоту до завершения реальной операции. Чтение inbox и обогащение результатов поиска выполняются максимум по три одновременно, сохраняя порядок и дожидаясь завершения всех начатых обращений при ошибке.

Кеш содержит только метаданные внутри процесса конкретного аккаунта: до 2048 сущностей на пять минут и 1024 имён отправителей на минуту. Тексты сообщений и результаты чтения не кешируются. Повторные запросы имени одного отправителя объединяются; готовые сведения из Telegram-ответа используются без дополнительных запросов. Схемы MCP-инструментов создаются один раз, а права, обработчики и HTTP-транспорт остаются отдельными для каждого запроса.

В Docker-логе строки `[mcp-tool]` содержат имя инструмента, результат `ok/error`, `totalMs`, `admissionMs`, `queueMs`, `executionMs`, `connectionMs`, а также признаки холодного процесса (`cold`) и подключения (`connectionCold`). Аргументы, тексты сообщений, идентификаторы аккаунтов и токены не записываются. `Server-Timing` у MCP-ответа показывает время обработки сервером и создания каталога. Эти замеры не включают генерацию ответа моделью ChatGPT.

Для воспроизводимого сравнения без Telegram-сессий и сети: `node --import tsx scripts/benchmark-mcp.mts`. Переменная `MCP_BENCH_SOURCE` позволяет указать прежний checkout. Сценарий использует искусственные 20 мс на Telegram-запрос: измеряет поиск восьми групп, получение 100 сообщений и inbox восьми чатов. Результаты показывают изменения локального алгоритма, а не пропускную способность VPS или обещанное время ответа ChatGPT. Нагрузочные испытания общего VPS не выполняются автоматически.
# Optional Instagram integration

The image includes a pinned Python runtime for personal Instagram DMs.
Set `MCP_INSTAGRAM_ENABLED=1` in the Compose environment to enable it.
See [Instagram setup and verification](instagram.md) for connection and
permission controls. Instagram and Telegram share the worker capacity.
The additive schema-5 migration requires the matching auth/database snapshot
when rolling back to an older image; image-only rollback is insufficient.
