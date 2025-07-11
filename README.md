

# Коннектор SillyTavern для Telegram русский форк

SillyTavern Telegram Connector — это расширение для SillyTavern, которое позволяет пользователям взаимодействовать с ИИ-персонажами SillyTavern через Telegram. Расширение создает мост между SillyTavern и Telegram-ботом, позволяя общаться с любимыми ИИ-персонажами на мобильных устройствах в любое время и в любом месте.  
[![License](https://img.shields.io/github/license/qiqi20020612/SillyTavern-Telegram-Connector)](https://github.com/qiqi20020612/SillyTavern-Telegram-Connector/blob/main/LICENSE)
[![stars](https://img.shields.io/github/stars/qiqi20020612/SillyTavern-Telegram-Connector)](https://github.com/qiqi20020612/SillyTavern-Telegram-Connector)

## Основные функции

- **Интеграция с Telegram**: Общение с ИИ-персонажами SillyTavern через приложение Telegram.
- **Синхронизация в реальном времени**: Чаты в Telegram синхронизируются с интерфейсом SillyTavern и наоборот.
- **Поддержка команд**: Доступны различные команды Telegram для управления чатами и персонажами:
  - `/help` — Показать все доступные команды.
  - `/new` — Начать новый чат.
  - `/listchars` — Список всех доступных персонажей.
  - `/switchchar <имя персонажа>` — Переключиться на указанного персонажа.
  - `/listchats` — Список всех чатов текущего персонажа.
  - `/switchchat <имя чата>` — Переключиться на указанный чат.
- **Простая настройка**: Подключение через WebSocket, простое в установке и использовании.

## Установка и использование

### Установка расширения

1. В SillyTavern перейдите на вкладку "Extensions".
2. Нажмите "Install Extension".
3. Введите следующий URL: `https://github.com/scavru/SillyTavern-Telegram-Connector`.
4. Нажмите кнопку "Install".
5. После установки перезапустите SillyTavern.

### Настройка сервера

1. Склонируйте или скачайте этот репозиторий на свой компьютер.
2. Перейдите в директорию `SillyTavern\data\default-user\extensions\SillyTavern-Telegram-Connector\server\`.
3. запустите cmd
4. Установите зависимости:
   ```
   npm install node-telegram-bot-api ws
   ```
5. Скопируйте файл `config.example.js` в `config.js`:
   ```
   cp config.example.js config.js
   ```
   или в Windows:
   ```
   copy config.example.js config.js
   ```
6. Отредактируйте файл `config.js`, заменив `YOUR_TELEGRAM_BOT_TOKEN_HERE` на ваш Telegram Bot Token
   (его можно получить через [@BotFather](https://t.me/BotFather) в Telegram).
7. Запустите сервер:
   ```
   node server.js
   ```

### Настройка подключения

1. В SillyTavern перейдите на вкладку "Extensions".
2. Найдите раздел "Telegram Connector".
3. В поле "Bridge сервер WebSocket URL" введите адрес WebSocket-сервера
   (по умолчанию `ws://127.0.0.1:2333`).
4. Нажмите кнопку "Подключить".
5. После появления статуса "Подключено" вы можете начать использование.

### Использование в Telegram

1. В Telegram найдите и начните диалог с созданным ботом.
2. Отправьте любое сообщение, чтобы начать чат.
3. Ваши сообщения будут отправлены в SillyTavern, а ответы ИИ автоматически вернутся в Telegram.
4. Используйте команду `/help`, чтобы просмотреть все доступные команды.

### Настройка перевода (OneRingTranslator)

1. запустите OneRingTranslator с выбранным плагином  http://127.0.0.1:4990
2.  Чтобы ваш текст из телеги переводился включите перевод через Chat Translation переводить ваши сообщения.
3. **Включение/отключение переводчика**:
   - Чтобы включить переводчик/отключить, нажмите галочку в расширении

## Системные требования

- Node.js 14.0 или выше.
- Запущенный экземпляр SillyTavern в браузере ОБЯЗАТЕЛЬНО.
- Подключение к интернету (для Telegram API).
