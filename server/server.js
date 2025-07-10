// server.js
const TelegramBot = require('node-telegram-bot-api');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Функция для отправки длинных сообщений с разбиением
async function sendLongMessage(bot, chatId, text) {
    const MAX_MESSAGE_LENGTH = 4096;
    if (text.length <= MAX_MESSAGE_LENGTH) {
        await bot.sendMessage(chatId, text).catch(err => {
            logWithTimestamp('error', `Ошибка отправки сообщения в Telegram: ${err.message}`);
        });
    } else {
        const parts = [];
        for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
            parts.push(text.slice(i, i + MAX_MESSAGE_LENGTH));
        }
        for (const part of parts) {
            await bot.sendMessage(chatId, part).catch(err => {
                logWithTimestamp('error', `Ошибка отправки части сообщения в Telegram: ${err.message}`);
            });
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
}

// Функция для перевода текста через OneRingTranslator
async function translateText(text) {
    try {
        logWithTimestamp('log', `Отправка текста на перевод: "${text.slice(0, 100)}${text.length > 100 ? '...' : ''}"`);
        const response = await axios.get('http://127.0.0.1:4990/translate', {
            params: {
                text: text,
                from_lang: 'en',
                to_lang: 'ru'
            }
        });
        const translatedText = response.data.result || text;
        logWithTimestamp('log', `Получен переведённый текст: "${translatedText.slice(0, 100)}${translatedText.length > 100 ? '...' : ''}"`);
        return translatedText;
    } catch (error) {
        logWithTimestamp('error', `Ошибка перевода текста: ${error.message}`);
        return text; // Возвращаем оригинальный текст при ошибке
    }
}

// Добавление функции логирования с временной меткой
function logWithTimestamp(level, ...args) {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const timestamp = `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    const prefix = `[${timestamp}]`;
    switch (level) {
        case 'error':
            console.error(prefix, ...args);
            break;
        case 'warn':
            console.warn(prefix, ...args);
            break;
        default:
            console.log(prefix, ...args);
    }
}

// Защита от циклических перезапусков
const RESTART_PROTECTION_FILE = path.join(__dirname, '.restart_protection');
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60000;

function checkRestartProtection() {
    try {
        if (fs.existsSync(RESTART_PROTECTION_FILE)) {
            const data = JSON.parse(fs.readFileSync(RESTART_PROTECTION_FILE, 'utf8'));
            const now = Date.now();
            data.restarts = data.restarts.filter(time => now - time < RESTART_WINDOW_MS);
            data.restarts.push(now);
            if (data.restarts.length > MAX_RESTARTS) {
                logWithTimestamp('error', `Обнаружен возможный циклический перезапуск! ${data.restarts.length} перезапусков за ${RESTART_WINDOW_MS / 1000} секунд.`);
                logWithTimestamp('error', 'Сервер будет остановлен для предотвращения исчерпания ресурсов. Проверьте и устраните проблему вручную.');
                if (process.env.RESTART_NOTIFY_CHATID) {
                    const chatId = parseInt(process.env.RESTART_NOTIFY_CHATID);
                    if (!isNaN(chatId)) {
                        try {
                            const tempBot = new TelegramBot(require('./config').telegramToken, { polling: false });
                            tempBot.sendMessage(chatId, 'Обнаружен циклический перезапуск! Сервер остановлен. Проверьте проблему вручную.')
                                .finally(() => process.exit(1));
                        } catch (e) {
                            process.exit(1);
                        }
                        return;
                    }
                }
                process.exit(1);
            }
            fs.writeFileSync(RESTART_PROTECTION_FILE, JSON.stringify(data));
        } else {
            fs.writeFileSync(RESTART_PROTECTION_FILE, JSON.stringify({ restarts: [Date.now()] }));
        }
    } catch (error) {
        logWithTimestamp('error', 'Ошибка проверки защиты от перезапуска:', error);
    }
}

checkRestartProtection();

const configPath = path.join(__dirname, './config.js');
if (!fs.existsSync(configPath)) {
    logWithTimestamp('error', 'Ошибка: Файл конфигурации config.js не найден!');
    logWithTimestamp('error', 'Скопируйте config.example.js в config.js в директории server и настройте ваш Telegram Bot Token.');
    process.exit(1);
}

const config = require('./config');
const token = config.telegramToken;
const wssPort = config.wssPort;

if (token === 'TOKEN' || token === 'YOUR_TELEGRAM_BOT_TOKEN_HERE') {
    logWithTimestamp('error', 'Ошибка: Настройте ваш Telegram Bot Token в файле config.js!');
    logWithTimestamp('error', 'Замените telegramToken: \'YOUR_TELEGRAM_BOT_TOKEN_HERE\' на токен, полученный от BotFather.');
    process.exit(1);
}

const bot = new TelegramBot(token, { polling: false });
logWithTimestamp('log', 'Инициализация Telegram Bot...');

(async function clearAndStartPolling() {
    try {
        logWithTimestamp('log', 'Очистка очереди сообщений Telegram...');
        const isRestart = process.env.TELEGRAM_CLEAR_UPDATES === '1';
        if (isRestart) {
            logWithTimestamp('log', 'Обнаружен перезапуск, выполняется тщательная очистка очереди...');
            let updates;
            let lastUpdateId = 0;
            do {
                updates = await bot.getUpdates({
                    offset: lastUpdateId,
                    limit: 100,
                    timeout: 0
                });
                if (updates && updates.length > 0) {
                    lastUpdateId = updates[updates.length - 1].update_id + 1;
                    logWithTimestamp('log', `Очищено ${updates.length} сообщений, текущий offset: ${lastUpdateId}`);
                }
            } while (updates && updates.length > 0);
            delete process.env.TELEGRAM_CLEAR_UPDATES;
            logWithTimestamp('log', 'Очистка очереди завершена');
        } else {
            const updates = await bot.getUpdates({ limit: 100, timeout: 0 });
            if (updates && updates.length > 0) {
                const lastUpdateId = updates[updates.length - 1].update_id;
                await bot.getUpdates({ offset: lastUpdateId + 1, limit: 1, timeout: 0 });
                logWithTimestamp('log', `Очищено ${updates.length} ожидающих сообщений`);
            } else {
                logWithTimestamp('log', 'Нет ожидающих сообщений для очистки');
            }
        }
        bot.startPolling({
            restart: true,
            clean: true
        });
        logWithTimestamp('log', 'Поллинг Telegram Bot запущен');
    } catch (error) {
        logWithTimestamp('error', 'Ошибка при очистке очереди или запуске поллинга:', error);
        bot.startPolling({ restart: true, clean: true });
        logWithTimestamp('log', 'Поллинг Telegram Bot запущен (после ошибки очистки)');
    }
})();

const wss = new WebSocket.Server({ port: wssPort });
logWithTimestamp('log', `WebSocket сервер слушает порт ${wssPort}...`);

let sillyTavernClient = null;

function reloadServer(chatId) {
    logWithTimestamp('log', 'Перезагрузка серверных компонентов...');
    Object.keys(require.cache).forEach(function (key) {
        if (key.indexOf('node_modules') === -1) {
            delete require.cache[key];
        }
    });
    try {
        delete require.cache[require.resolve('./config.js')];
        const newConfig = require('./config.js');
        Object.assign(config, newConfig);
        logWithTimestamp('log', 'Файл конфигурации перезагружен');
    } catch (error) {
        logWithTimestamp('error', 'Ошибка перезагрузки конфигурации:', error);
        if (chatId) bot.sendMessage(chatId, 'Ошибка перезагрузки конфигурации: ' + error.message);
        return;
    }
    logWithTimestamp('log', 'Серверные компоненты перезагружены');
    if (chatId) bot.sendMessage(chatId, 'Серверные компоненты успешно перезагружены.');
}

function restartServer(chatId) {
    logWithTimestamp('log', 'Перезапуск серверных компонентов...');
    bot.stopPolling().then(() => {
        logWithTimestamp('log', 'Поллинг Telegram Bot остановлен');
        if (wss) {
            wss.close(() => {
                logWithTimestamp('log', 'WebSocket сервер закрыт, подготовка к перезапуску...');
                setTimeout(() => {
                    const { spawn } = require('child_process');
                    const serverPath = path.join(__dirname, 'server.js');
                    logWithTimestamp('log', `Перезапуск сервера: ${serverPath}`);
                    const cleanEnv = {
                        PATH: process.env.PATH,
                        NODE_PATH: process.env.NODE_PATH,
                        TELEGRAM_CLEAR_UPDATES: '1'
                    };
                    if (chatId) cleanEnv.RESTART_NOTIFY_CHATID = chatId.toString();
                    const child = spawn(process.execPath, [serverPath], { detached: true, stdio: 'inherit', env: cleanEnv });
                    child.unref();
                    process.exit(0);
                }, 1000);
            });
        } else {
            setTimeout(() => {
                const { spawn } = require('child_process');
                const serverPath = path.join(__dirname, 'server.js');
                logWithTimestamp('log', `Перезапуск сервера: ${serverPath}`);
                const cleanEnv = {
                    PATH: process.env.PATH,
                    NODE_PATH: process.env.NODE_PATH,
                    TELEGRAM_CLEAR_UPDATES: '1'
                };
                if (chatId) cleanEnv.RESTART_NOTIFY_CHATID = chatId.toString();
                const child = spawn(process.execPath, [serverPath], { detached: true, stdio: 'inherit', env: cleanEnv });
                child.unref();
                process.exit(0);
            }, 1000);
        }
    }).catch(err => {
        logWithTimestamp('error', 'Ошибка остановки поллинга Telegram Bot:', err);
        if (wss) {
            wss.close(() => {
                setTimeout(() => {
                    const { spawn } = require('child_process');
                    const serverPath = path.join(__dirname, 'server.js');
                    logWithTimestamp('log', `Перезапуск сервера: ${serverPath}`);
                    const cleanEnv = {
                        PATH: process.env.PATH,
                        NODE_PATH: process.env.NODE_PATH,
                        TELEGRAM_CLEAR_UPDATES: '1'
                    };
                    if (chatId) cleanEnv.RESTART_NOTIFY_CHATID = chatId.toString();
                    const child = spawn(process.execPath, [serverPath], { detached: true, stdio: 'inherit', env: cleanEnv });
                    child.unref();
                    process.exit(0);
                }, 1000);
            });
        } else {
            setTimeout(() => {
                const { spawn } = require('child_process');
                const serverPath = path.join(__dirname, 'server.js');
                logWithTimestamp('log', `Перезапуск сервера: ${serverPath}`);
                const cleanEnv = {
                    PATH: process.env.PATH,
                    NODE_PATH: process.env.NODE_PATH,
                    TELEGRAM_CLEAR_UPDATES: '1'
                };
                if (chatId) cleanEnv.RESTART_NOTIFY_CHATID = chatId.toString();
                const child = spawn(process.execPath, [serverPath], { detached: true, stdio: 'inherit', env: cleanEnv });
                child.unref();
                process.exit(0);
            }, 1000);
        }
    });
}

function exitServer() {
    logWithTimestamp('log', 'Закрытие сервера...');
    const forceExitTimeout = setTimeout(() => {
        logWithTimestamp('error', 'Тайм-аут операции выхода, принудительное завершение процесса');
        process.exit(1);
    }, 10000);
    try {
        if (fs.existsSync(RESTART_PROTECTION_FILE)) {
            fs.unlinkSync(RESTART_PROTECTION_FILE);
            logWithTimestamp('log', 'Файл защиты от перезапуска очищен');
        }
    } catch (error) {
        logWithTimestamp('error', 'Ошибка очистки файла защиты от перезапуска:', error);
    }
    const finalExit = () => {
        clearTimeout(forceExitTimeout);
        logWithTimestamp('log', 'Серверные компоненты успешно закрыты');
        process.exit(0);
    };
    if (wss) {
        wss.close(() => {
            logWithTimestamp('log', 'WebSocket сервер закрыт');
            bot.stopPolling().finally(finalExit);
        });
    } else {
        bot.stopPolling().finally(finalExit);
    }
}

function handleSystemCommand(command, chatId) {
    logWithTimestamp('log', `Выполнение системной команды: ${command}`);
    if (command === 'ping') {
        const bridgeStatus = 'Статус моста: Подключено ✅';
        const stStatus = sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN ?
            'Статус SillyTavern: Подключено ✅' :
            'Статус SillyTavern: Не подключено ❌';
        bot.sendMessage(chatId, `${bridgeStatus}\n${stStatus}`);
        return;
    }
    let responseMessage = '';
    switch (command) {
        case 'reload':
            responseMessage = 'Перезагрузка серверных компонентов...';
            if (sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN) {
                sillyTavernClient.commandToExecuteOnClose = { command, chatId };
                sillyTavernClient.send(JSON.stringify({ type: 'system_command', command: 'reload_ui_only', chatId }));
            } else {
                bot.sendMessage(chatId, responseMessage);
                reloadServer(chatId);
            }
            break;
        case 'restart':
            responseMessage = 'Перезапуск серверных компонентов...';
            if (sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN) {
                sillyTavernClient.commandToExecuteOnClose = { command, chatId };
                sillyTavernClient.send(JSON.stringify({ type: 'system_command', command: 'reload_ui_only', chatId }));
            } else {
                bot.sendMessage(chatId, responseMessage);
                restartServer(chatId);
            }
            break;
        case 'exit':
            responseMessage = 'Закрытие серверных компонентов...';
            if (sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN) {
                sillyTavernClient.commandToExecuteOnClose = { command, chatId };
                sillyTavernClient.send(JSON.stringify({ type: 'system_command', command: 'reload_ui_only', chatId }));
            } else {
                bot.sendMessage(chatId, responseMessage);
                exitServer();
            }
            break;
        default:
            logWithTimestamp('warn', `Неизвестная системная команда: ${command}`);
            bot.sendMessage(chatId, `Неизвестная команда: /${command}`);
            return;
    }
    if (sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN) {
        bot.sendMessage(chatId, responseMessage);
    }
}

async function handleTelegramCommand(command, args, chatId) {
    logWithTimestamp('log', `Обработка команды Telegram: /${command} ${args.join(' ')}`);
    bot.sendChatAction(chatId, 'typing').catch(error =>
        logWithTimestamp('error', 'Ошибка отправки статуса "печатает":', error));
    let replyText = `Неизвестная команда: /${command}. Используйте /help для списка команд.`;
    if (command === 'help') {
        replyText = `Команды SillyTavern Telegram Bridge:\n\n`;
        replyText += `Управление чатами\n`;
        replyText += `/new - Начать новый чат с текущим персонажем.\n`;
        replyText += `/listchats - Показать все сохранённые чаты текущего персонажа.\n`;
        replyText += `/switchchat <имя_чата> - Загрузить указанный чат.\n`;
        replyText += `/switchchat_<номер> - Загрузить чат по номеру.\n\n`;
        replyText += `Управление персонажами\n`;
        replyText += `/listchars - Показать всех доступных персонажей.\n`;
        replyText += `/switchchar <имя_персонажа> - Переключиться на указанного персонажа.\n`;
        replyText += `/switchchar_<номер> - Переключиться на персонажа по номеру.\n\n`;
        replyText += `Системное управление\n`;
        replyText += `/reload - Перезагрузить серверные компоненты и обновить веб-интерфейс ST.\n`;
        replyText += `/restart - Обновить веб-интерфейс ST и перезапустить серверные компоненты.\n`;
        replyText += `/exit - Завершить работу серверных компонентов.\n`;
        replyText += `/ping - Проверить статус подключения.\n\n`;
        replyText += `Помощь\n`;
        replyText += `/help - Показать эту справку.`;
        await sendLongMessage(bot, chatId, replyText);
        return;
    }
    if (!sillyTavernClient || sillyTavernClient.readyState !== WebSocket.OPEN) {
        await sendLongMessage(bot, chatId, 'SillyTavern не подключён. Невозможно выполнить команды, связанные с персонажами и чатами. Убедитесь, что SillyTavern запущен и расширение Telegram включено.');
        return;
    }
    switch (command) {
        case 'new':
            sillyTavernClient.send(JSON.stringify({
                type: 'execute_command',
                command: 'new',
                chatId: chatId
            }));
            return;
        case 'listchars':
            sillyTavernClient.send(JSON.stringify({
                type: 'execute_command',
                command: 'listchars',
                chatId: chatId
            }));
            return;
        case 'switchchar':
            if (args.length === 0) {
                replyText = 'Укажите имя персонажа или номер. Использование: /switchchar <имя_персонажа> или /switchchar_номер';
            } else {
                sillyTavernClient.send(JSON.stringify({
                    type: 'execute_command',
                    command: 'switchchar',
                    args: args,
                    chatId: chatId
                }));
                return;
            }
            break;
        case 'listchats':
            sillyTavernClient.send(JSON.stringify({
                type: 'execute_command',
                command: 'listchats',
                chatId: chatId
            }));
            return;
        case 'switchchat':
            if (args.length === 0) {
                replyText = 'Укажите имя чата. Использование: /switchchat <имя_чата>';
            } else {
                sillyTavernClient.send(JSON.stringify({
                    type: 'execute_command',
                    command: 'switchchat',
                    args: args,
                    chatId: chatId
                }));
                return;
            }
            break;
        default:
            const charMatch = command.match(/^switchchar_(\d+)$/);
            if (charMatch) {
                sillyTavernClient.send(JSON.stringify({
                    type: 'execute_command',
                    command: command,
                    chatId: chatId
                }));
                return;
            }
            const chatMatch = command.match(/^switchchat_(\d+)$/);
            if (chatMatch) {
                sillyTavernClient.send(JSON.stringify({
                    type: 'execute_command',
                    command: command,
                    chatId: chatId
                }));
                return;
            }
    }
    await sendLongMessage(bot, chatId, replyText);
}

wss.on('connection', ws => {
    logWithTimestamp('log', 'Расширение SillyTavern подключено!');
    sillyTavernClient = ws;

    ws.on('message', async (message) => {
        let data;
        try {
            data = JSON.parse(message);

            // Игнорируем потоковые сообщения
            if (data.type === 'stream_chunk' || data.type === 'stream_end') {
                return;
            }

            // Обработка финального сообщения
            if (data.type === 'final_message_update' && data.chatId) {
                logWithTimestamp('log', `Получен финальный текст для ChatID ${data.chatId}`);
                const translatedText = await translateText(data.text);
                await sendLongMessage(bot, data.chatId, translatedText);
                return;
            }

            // Обработка других типов сообщений
            if (data.type === 'error_message' && data.chatId) {
                logWithTimestamp('error', `Ошибка от SillyTavern, отправка пользователю Telegram ${data.chatId}: ${data.text}`);
                const translatedText = await translateText(data.text);
                await sendLongMessage(bot, data.chatId, translatedText);
            } else if (data.type === 'ai_reply' && data.chatId) {
                logWithTimestamp('log', `Получен ответ AI, отправка пользователю Telegram ${data.chatId}`);
                const translatedText = await translateText(data.text);
                await sendLongMessage(bot, data.chatId, translatedText);
            } else if (data.type === 'typing_action' && data.chatId) {
                logWithTimestamp('log', `Отправка статуса "печатает" пользователю Telegram ${data.chatId}`);
                bot.sendChatAction(data.chatId, 'typing').catch(error =>
                    logWithTimestamp('error', 'Ошибка отправки статуса "печатает":', error));
            } else if (data.type === 'command_executed') {
                logWithTimestamp('log', `Команда ${data.command} выполнена, результат: ${data.success ? 'успех' : 'ошибка'}`);
                if (data.message) {
                    logWithTimestamp('log', `Сообщение выполнения команды: ${data.message}`);
                    const translatedMessage = await translateText(data.message);
                    await sendLongMessage(bot, data.chatId, translatedMessage);
                }
            }
        } catch (error) {
            logWithTimestamp('error', 'Ошибка обработки сообщения от SillyTavern:', error);
        }
    });

    ws.on('close', () => {
        logWithTimestamp('log', 'Расширение SillyTavern отключено.');
        if (ws.commandToExecuteOnClose) {
            const { command, chatId } = ws.commandToExecuteOnClose;
            logWithTimestamp('log', `Клиент отключён, выполнение запланированной команды: ${command}`);
            if (command === 'reload') reloadServer(chatId);
            if (command === 'restart') restartServer(chatId);
            if (command === 'exit') exitServer(chatId);
        }
        sillyTavernClient = null;
    });

    ws.on('error', (error) => {
        logWithTimestamp('error', 'Ошибка WebSocket:', error);
        if (sillyTavernClient) {
            sillyTavernClient.commandToExecuteOnClose = null;
        }
        sillyTavernClient = null;
    });
});

if (process.env.RESTART_NOTIFY_CHATID) {
    const chatId = parseInt(process.env.RESTART_NOTIFY_CHATID);
    if (!isNaN(chatId)) {
        setTimeout(() => {
            bot.sendMessage(chatId, 'Серверные компоненты успешно перезапущены и готовы к работе.')
                .catch(err => logWithTimestamp('error', 'Ошибка отправки уведомления о перезапуске:', err))
                .finally(() => {
                    delete process.env.RESTART_NOTIFY_CHATID;
                });
        }, 2000);
    }
}

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    const userId = msg.from.id;
    const username = msg.from.username || 'N/A';
    if (config.allowedUserIds && config.allowedUserIds.length > 0) {
        if (!config.allowedUserIds.includes(userId)) {
            logWithTimestamp('log', `Отказ в доступе для пользователя вне белого списка:\n  - User ID: ${userId}\n  - Username: @${username}\n  - Chat ID: ${chatId}\n  - Message: "${text}"`);
            await sendLongMessage(bot, chatId, 'Извините, у вас нет доступа к этому боту.');
            return;
        }
    }
    if (!text) return;
    if (text.startsWith('/')) {
        const parts = text.slice(1).trim().split(/\s+/);
        const command = parts[0].toLowerCase();
        const args = parts.slice(1);
        if (['reload', 'restart', 'exit', 'ping'].includes(command)) {
            handleSystemCommand(command, chatId);
            return;
        }
        await handleTelegramCommand(command, args, chatId);
        return;
    }
    if (sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN) {
        logWithTimestamp('log', `Получено сообщение от пользователя Telegram ${chatId}: "${text}"`);
        const payload = JSON.stringify({ type: 'user_message', chatId, text });
        sillyTavernClient.send(payload);
    } else {
        logWithTimestamp('warn', 'Получено сообщение Telegram, но расширение SillyTavern не подключено.');
        await sendLongMessage(bot, chatId, 'Извините, сейчас нет подключения к SillyTavern. Убедитесь, что SillyTavern запущен и расширение Telegram включено.');
    }
});