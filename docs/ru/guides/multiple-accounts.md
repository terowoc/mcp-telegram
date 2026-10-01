# Несколько аккаунтов

## Кабинет для ChatGPT и Claude.ai

В одном кабинете можно добавить до **пяти Telegram-аккаунтов**, включая основной и аккаунты, ожидающие подключения или удаления.

1. Нажмите «Добавить Telegram-аккаунт» и задайте название, например «Работа».
2. Отсканируйте QR-код нужным аккаунтом: Telegram → Настройки → Устройства → Подключить устройство. При необходимости введите облачный пароль Telegram.
3. Выберите аккаунт в кабинете, чтобы управлять его подключением и правами.
4. После добавления, удаления или изменения прав повторно подтвердите OAuth-доступ в AI-клиенте.
5. Попросите AI вызвать `telegram-list-accounts` и передавать ID нужного подключения в `telegramAccountId` при каждом действии.

Без `telegramAccountId` AI всегда использует **основной аккаунт**. Выбор в кабинете не меняет отправителя AI. При загрузке и отправке файла нужен один и тот же ID: файлы и сессии аккаунтов изолированы. ID подключения — UUID, он отличается от числового ID пользователя Telegram.

Дополнительный аккаунт можно переименовать, отключить или удалить вместе с его файлами. Основной аккаунт удаляется только вместе с кабинетом. Если очистка не завершилась, аккаунт сразу отключается от доступа и остаётся доступным для повторного удаления. Сервер также повторяет запрошенную очистку после перезапуска и каждые пять минут.

## Локальные MCP-серверы


Запускайте несколько аккаунтов Telegram параллельно, используя разные пути к сессиям.

## Вход в каждый аккаунт

```bash
# Рабочий аккаунт
TELEGRAM_API_ID=ID1 TELEGRAM_API_HASH=HASH1 \
  TELEGRAM_SESSION_PATH=~/.mcp-telegram/session-work \
  npx @overpod/mcp-telegram login

# Личный аккаунт
TELEGRAM_API_ID=ID2 TELEGRAM_API_HASH=HASH2 \
  TELEGRAM_SESSION_PATH=~/.mcp-telegram/session-personal \
  npx @overpod/mcp-telegram login
```

## Добавить как отдельные MCP-серверы

### Claude Code

```bash
claude mcp add telegram-work -s user \
  -e TELEGRAM_API_ID=ID1 \
  -e TELEGRAM_API_HASH=HASH1 \
  -e TELEGRAM_SESSION_PATH=~/.mcp-telegram/session-work \
  -- npx @overpod/mcp-telegram

claude mcp add telegram-personal -s user \
  -e TELEGRAM_API_ID=ID2 \
  -e TELEGRAM_API_HASH=HASH2 \
  -e TELEGRAM_SESSION_PATH=~/.mcp-telegram/session-personal \
  -- npx @overpod/mcp-telegram
```

### Claude Desktop

```json
{
  "mcpServers": {
    "telegram-work": {
      "command": "npx",
      "args": ["@overpod/mcp-telegram"],
      "env": {
        "TELEGRAM_API_ID": "ID1",
        "TELEGRAM_API_HASH": "HASH1",
        "TELEGRAM_SESSION_PATH": "~/.mcp-telegram/session-work"
      }
    },
    "telegram-personal": {
      "command": "npx",
      "args": ["@overpod/mcp-telegram"],
      "env": {
        "TELEGRAM_API_ID": "ID2",
        "TELEGRAM_API_HASH": "HASH2",
        "TELEGRAM_SESSION_PATH": "~/.mcp-telegram/session-personal"
      }
    }
  }
}
```

Каждый аккаунт получает свой файл сессии — без конфликтов.

::: warning
Сессия может использоваться только **одним процессом одновременно**. Использование одного файла сессии в нескольких процессах вызывает ошибку `AUTH_KEY_DUPLICATED`.
:::
