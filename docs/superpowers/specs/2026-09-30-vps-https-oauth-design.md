# HTTPS MCP и автоматический деплой на VPS

Дата: 2026-09-30. Статус: спецификация для проверки пользователем.

## Цель и подтверждённые требования

Развернуть fork `terowoc/mcp-telegram` на предоставленном пользователем VPS,
подключить деплой к GitHub Actions, затем выполнить улучшения из аудита.
Пользователь выбрал Docker, указал домен `tg-mcp.azimboev.uz` и уточнил, что
нужен публичный HTTPS endpoint для всех совместимых MCP-клиентов, включая
ChatGPT, Claude и Codex. Существующие Docker-проекты на VPS должны продолжать
работать без изменений.

На сервере уже работают десять Compose-проектов. Порты 80/443 обслуживает
nginx. Docker 29.3.0 и Compose v5.1.0 установлены. Порт 18770 свободен.
Домен находится за Cloudflare. Telegram-сессии пока нет; API credentials
переданы пользователем и сохранены отдельно на VPS с правами 0600.
В этом документе и в Git секретов нет.

Успех первого этапа: доступный и защищённый HTTPS MCP, прошедший протокольные
проверки OAuth/MCP, работающий Telegram-аккаунт после сканирования QR,
сохранение авторизации после перезапуска, проверенный автоматический деплой
с откатом и отсутствие изменений существующих Compose-проектов.

## Выбор подхода

1. **Рекомендуется: встроенный HTTP gateway и готовая OAuth/OIDC-библиотека.**
   Один отдельный контейнер, существующий Telegram owner и IPC. OAuth
   реализует поддерживаемый `oidc-provider`, а приложение добавляет вход
   владельца, persistent storage и проверку доступа. Внешняя платная
   учётная запись не нужна.
2. **Отдельный self-hosted identity provider.** Keycloak или аналог даст
   развитое управление пользователями, но добавит сервисы, память и
   настройку. Для одного владельца Telegram это лишняя инфраструктура.
3. **Внешний identity provider.** Уменьшает объём auth-кода, но требует
   внешнего аккаунта и отдельной настройки пользователем.

Первый подход выбран для спецификации. Поддержка нескольких независимых
владельцев Telegram и публичная регистрация пользователей в него не входят.

## Архитектура и границы

```text
MCP-клиент
  -> HTTPS /mcp
  -> Cloudflare / nginx
  -> 127.0.0.1:18770
  -> Streamable HTTP gateway + проверка OAuth
  -> IPC
  -> единственный Telegram owner
  -> Telegram MTProto
```

Новый CLI-режим `http` запускает HTTP gateway и существующего owner в одном
контейнере. Для Telegram используется один `TelegramService`; каждая
HTTP-заявка получает MCP server с теми же схемами инструментов, но его
обработчики проксируют вызовы через существующий IPC. Закрытие HTTP-заявки
не закрывает Telegram-соединение.

HTTP transport — официальный Streamable HTTP SDK, stateless mode с JSON
ответами. Отдельные серверные HTTP sessions и хранилище SSE не нужны для
имеющихся конечных вызовов инструментов. Stdio и `serve` сохраняются.
Совместимость проверяется с реальным SDK client; наличие функции custom
MCP connector в каждом клиентском аккаунте отдельно не гарантируется.

## HTTPS и авторизация

Публичный resource: `https://tg-mcp.azimboev.uz/mcp`.
OAuth issuer: `https://tg-mcp.azimboev.uz/oauth`.

Публикуются Protected Resource Metadata и Authorization Server Metadata,
а также OIDC discovery. Метаданные содержат реальные endpoint URL и scope
`mcp:tools`. Без валидной авторизации запрос к /mcp возвращает 401 и
WWW-Authenticate с URL resource metadata.

Поддерживаются Authorization Code + PKCE S256, Dynamic Client Registration,
access tokens с ограниченным сроком жизни, refresh tokens и revocation.
Клиенты могут быть public либо использовать поддерживаемый client-secret
метод. Resource/audience строго соответствует /mcp. Implicit flow и
password grant отключены. CIMD не требуется для первой поставки;
совместимость клиентов, которым обязательно нужен CIMD, проверяется
отдельно и не объявляется без проверки.

OAuth протокол выполняет готовая библиотека. Учётная запись владельца
одна; самостоятельной регистрации пользователей нет. Пароль владельца
отдельный от SSH и Telegram; хранится только его scrypt hash. Вход и
consent защищены secure HttpOnly cookies, CSRF/interaction binding и
ограничением попыток. На consent отображаются клиент и предоставляемый
доступ к Telegram. Перед возвратом токена проверяются issuer, audience,
expiry, scope и отзыв. Авторизация выполняется на каждом MCP запросе.

SQLite adapter сохраняет OAuth grants, clients, sessions и refresh state
в отдельном volume. Signing keys и cookie secrets сохраняются при первом
запуске и не меняются при очередном деплое. Файлы доступны только UID
приложения. Секреты, коды, токены, пароли и тексты переписки не логируются.

## Минимальные ограничения перед публичным запуском

- HTTP body и ответы имеют предел размера; валидация схем применяется
  до выполнения инструментов. Есть ограничения частоты и числа запросов.
- Разрешены только ожидаемые Host и Origin; proxy trust ограничен nginx.
- Файловые инструменты gateway deployment работают только внутри
  `/data/files`, с проверкой канонического пути и лимитом размера.
  Session/auth storage находится вне этой директории. URL вместо локального
  пути запрещён. Запись не перезаписывает существующий файл по умолчанию.
- Для HTTP-вызовов используются существующие IPC owner lock и timeout.
  Недостатки общей очереди/retry из аудита остаются отдельными задачами
  второго этапа и не объявляются исправленными первым деплоем.
- Анонимный /healthz раскрывает только состояние HTTP/IPC, без аккаунта,
  сессии или переписки. Отсутствие первичной Telegram-авторизации отражается
  как setup required в защищённом статусе, без ложного утверждения готовности.

## Контейнер и изоляция VPS

Compose project: `mcp-telegram`. Каталог: `/opt/mcp-telegram`.
Приложение слушает порт 3000 внутри контейнера; наружу публикуется только
`127.0.0.1:18770:3000`. Node.js 24, production dependencies, непривилегированный
UID 1000, ограничение CPU/memory/pids, restart policy и healthcheck.

Отдельные persistent volumes для Telegram, OAuth и разрешённых файлов.
API credentials находятся в `/opt/mcp-telegram/telegram.env`, права 0600;
runtime secrets владельца — в отдельном файле с такими же правами.
Secrets не включаются в image или Docker build context.

Новый nginx vhost обслуживает только указанный домен. Проверка nginx -t
обязательна до reload. TLS-сертификат выпускается отдельно для этого домена;
nginx plugin certbot не должен переписывать другие vhosts. Proxy buffering
и cache отключены для MCP и auth. Существующие nginx-конфиги сохраняются.

Перед изменениями сохранены идентификаторы и StartedAt существующих
контейнеров. После первого деплоя сверяются их IDs/StartedAt. Изменения
состояния, вызванные их собственными supervisors, отмечаются отдельно.
Не используются global prune, массовый compose down, restart Docker
или изменение чужих volumes/networks.

## GitHub Actions и откат

Отдельный deployment workflow для `terowoc/mcp-telegram` запускает проверки,
строит image `ghcr.io/terowoc/mcp-telegram:<commit-sha>` и передаёт точный
digest на VPS. Deployment выполняется только для проверенного main или
явного workflow_dispatch на согласованном ref. PR-код не получает SSH secrets.

SSH deploy key создаётся отдельно от предоставленного пароля VPS.
Host key проверяется по заранее полученному fingerprint/known_hosts.
Workflow concurrency допускает только один deploy этого проекта за раз.
Секреты GitHub относятся только к этому деплою. Наследованный npm-пакет
`@overpod/mcp-telegram` и чужой MCP Registry namespace не публикуются.

Сначала image скачивается и валидируется, затем старый контейнер проекта
останавливается и запускается новый. Две версии с одной Telegram-сессией
одновременно не работают. Проверка ограничена по времени. При неуспехе
возвращается предыдущий digest и повторно проверяется здоровье. Volumes
не удаляются и credentials не перезаписываются. Перед миграцией auth
storage создаётся резервная копия для совместимого отката.

## Первичная Telegram-авторизация

После запуска пользователь сканирует QR, выданный login CLI внутри
контейнера через приватный SSH-канал. Авторизация сохраняется в Telegram
volume. Если требуется 2FA, пароль вводится через приватную серверную
конфигурацию и не включается в Git или логи. Затем проверяются status и
повторный статус после перезапуска только нового Compose-сервиса.

## Проверки и критерии приёмки

1. Исходные 615 тестов, typecheck, lint, build и docs build проходят.
2. OAuth tests: discovery, DCR, PKCE success/failure, code reuse rejection,
   redirect mismatch, resource mismatch, expiry, refresh, revocation,
   persistence after restart, owner login/consent и CSRF rejection.
3. MCP tests: unauthorized 401, initialize, tools/list, mocked tool call,
   отсутствие влияния disconnect клиента на owner, body limit rejection.
4. File-policy tests: traversal, symlink outside root, URL, sensitive paths,
   existing-file overwrite, size limits и permitted-file success.
5. Контейнер собирается в CI; smoke test выполняется без реальных секретов
   Telegram. Отдельно проверяется Compose configuration и deploy script.
6. На VPS проверяются TLS, metadata, отказ без токена и здоровый контейнер.
   После пользовательского QR — защищённый telegram-status и restart.
7. Проверяется безопасный откат и GitHub Actions deployment run.
8. Существующие Compose-проекты не перезапускаются этим деплоем.

## Следующий этап: улучшения из аудита

После рабочего деплоя: исправление session-path isolation, стабильные
randomId при retry, deadlines/cancellation и единый исполнитель для всех
transport, Unicode и frame bounds IPC, единый lifecycle соединения,
лимиты чтения и структурированные ответы, профили прав/allowlist чатов,
inbox и prepare-message, doctor/метрики, разбиение TelegramService,
dependency/release hardening и регрессионные сценарии. Эти изменения
оформляются отдельным планом; первый этап не подменяет их выполнение.

## Первичные источники

- MCP authorization: https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization
- OpenAI authentication: https://developers.openai.com/plugins/build/auth
- OAuth/OIDC provider: https://github.com/panva/node-oidc-provider
- Docker Compose production: https://docs.docker.com/compose/how-tos/production/
