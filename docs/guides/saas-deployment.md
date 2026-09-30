# Развёртывание бесплатного SaaS

Приложение обслуживает Telegram Web A, личный кабинет и защищённый MCP endpoint на одном HTTPS-домене. Docker Compose использует только проект `mcp-telegram`, сервис `mcp` и порт `127.0.0.1:18770`. Nginx проксирует этот порт; другие проекты не участвуют в развёртывании.

## Реквизиты и первое включение

В GitHub Actions задайте публичные переменные `WEB_TELEGRAM_API_ID` и `WEB_TELEGRAM_API_HASH` отдельного браузерного приложения Telegram. Они попадут в JS-сборку. Сборка без них завершается ошибкой. Приватные серверные `TELEGRAM_API_ID/HASH` находятся только в `telegram.env` на VPS. Значения 2FA не задаются в окружении SaaS: пользователь вводит пароль в конкретной попытке QR-входа.

Установите проверенные `scripts/deploy-vps.sh` и `scripts/initialize-saas.sh` в приватный `/opt/mcp-telegram`, сохранив существующий forced SSH command и права root. Выполните инициализацию от root из этого каталога. Она создаёт новый 32-байтный `session-key.bin` с правами 0600 и владельцем 1000, а также отдельную приватную резервную копию. Существующий ключ не заменяется. Не публикуйте ключ, резервную копию, `telegram.env` или базы.

Старые owner-only OAuth разрешения остаются в старом каталоге для отката. Пользователи SaaS выполняют новую регистрацию, OAuth-согласие и отдельный QR-вход Telegram. Браузерный вход не переносит ключи на сервер.

## Ограничение ресурсов

Базовые настройки: 100 пользователей, 4 worker, 3 ГБ памяти, 1 CPU, 128 PID, 45 секунд на остановку. Перед развёртыванием скрипт измеряет `MemAvailable`: при запасе 6 ГБ использует 4 worker/3 ГБ, при запасе 2,5 ГБ — 2 worker/1,5 ГБ, при меньшем запасе прекращает развёртывание до остановки текущего сервиса. Лимиты выбранного релиза записываются в его `deployment.env`. Gateway ограничен 512 МБ JS heap; каждый worker — 256 МБ. При исчерпании ёмкости API возвращает 503 с `Retry-After`, health остаётся доступен.

## Релизы и откат

GitHub Actions сначала выполняет проверки, затем публикует неизменяемый образ GHCR и передаёт его digest ограниченной SSH-команде. Образ содержит версионированный Compose. Скрипт проверяет конфигурацию и доступ к ключу от имени runtime-пользователя до остановки сервиса.

Остановка завершается только после выхода worker. Скрипт проверяет, что контейнер больше не работает и вышел с кодом 0, затем копирует **весь** `data/auth`, включая SQLite/WAL SaaS и OAuth, вместе с текущими Compose, image env и указателями релизов. Ключ находится за пределами этого снимка. Изменение схемы откатывается восстановлением полного снимка с прежними конфигурацией и образом; отдельные базы разных поколений не смешиваются.

Если новый контейнер нездоров, он останавливается до восстановления. Если остановка не удалась, базы остаются нетронутыми и скрипт сообщает ошибку отката. Не копируйте базы поверх работающего сервиса. Каталоги повреждённого поколения и снимки сохраняются для диагностики; глобальная очистка Docker не выполняется.

После успешного запуска `current-release` указывает на конфигурацию с проверенным image digest, `previous-release` — на предыдущую. Архивы релизов и резервные копии требуют отдельной приватной политики хранения. Потеря master key делает сохранённые Telegram-сессии нечитаемыми.

## Проверка после публикации

Проверьте `/healthz`, корневой интерфейс, `/source/LICENSE.txt`, discovery и 401 на неавторизованном `/mcp`. Зарегистрируйте изолированный тестовый аккаунт, сохраните коды восстановления, войдите в Telegram в браузере и отдельно отсканируйте QR для MCP. Убедитесь, что кабинет показывает правильный аккаунт и сохраняет MCP-сессию после перезапуска только этого сервиса. Проверка не требует отправки настоящих сообщений.

## Recovery and storage bounds

Password recovery replaces all eight recovery codes atomically and displays the new set once. Save them before leaving the panel. Previous SaaS cookies, OAuth login sessions, pending consent, access grants and refresh tokens lose access; OAuth must authenticate with the recovered password.

MCP media downloads have a 20 MiB file limit, 100 MiB / 100 files per user and 500 MiB / 1000 files across the service. Admission reserves a full file before dispatch, retains that reservation until the worker physically settles, and leaves at least 256 MiB free on the media filesystem. Stored files count after restart. Quota errors refuse the download before writing; deleting a TG Bridge account purges its media. Administrators can remove expired media during maintenance after stopping the target service. These bounds cover the application media volume, not disk growth from unrelated projects or logs.

`MCP_ALLOWED_ORIGINS` is a comma-separated list of exact HTTPS origins for browser MCP requests. It applies to `/mcp`; browser SaaS account mutations still require the application's own origin and CSRF token.
