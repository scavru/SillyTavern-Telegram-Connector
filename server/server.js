const TelegramBot = require('node-telegram-bot-api');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

// Store user language preferences
const userLanguages = new Map(); // chatId -> language ('ru' or 'en')

// Translations for bot messages
const translations = {
    ru: {
        access_denied: 'Извините, у вас нет доступа к этому боту.',
        no_connection: 'Нет соединения с SillyTavern. Убедитесь, что SillyTavern запущен и расширение Telegram включено.',
        unknown_command: 'Неизвестная команда: /{{command}}. Используйте /help для списка команд.',
        help: `Команды SillyTavern Telegram Bridge:\n\n` +
             `Управление чатом\n` +
             `/new - Начать новый чат с текущим персонажем.\n` +
             `/listchats - Показать все сохранённые чаты.\n` +
             `/switchchat <имя_чата> - Загрузить указанный чат.\n` +
             `/switchchat_<номер> - Загрузить чат по номеру.\n\n` +
             `Управление персонажами\n` +
             `/listchars - Показать всех доступных персонажей.\n` +
             `/switchchar <имя_персонажа> - Переключиться на указанного персонажа.\n` +
             `/switchchar_<номер> - Переключиться на персонажа по номеру.\n\n` +
             `Управление языком\n` +
             `/change_lng <ru|en> - Установить язык бота (ru или en).\n\n` +
             `Управление системой\n` +
             `/reload - Перезагрузить компоненты сервера и интерфейс SillyTavern.\n` +
             `/restart - Перезапустить компоненты сервера и интерфейс SillyTavern.\n` +
             `/exit - Завершить работу сервера.\n` +
             `/ping - Проверить статус соединения.\n\n` +
             `Помощь\n` +
             `/help - Показать эту справку.\n`,
        change_lng_invalid: 'Укажите язык: /change_lng ru или /change_lng en',
        change_lng_success: 'Язык установлен на {{lang}}.'
    },
    en: {
        access_denied: 'Sorry, you do not have access to this bot.',
        no_connection: 'No connection to SillyTavern. Ensure SillyTavern is running and the Telegram extension is enabled.',
        unknown_command: 'Unknown command: /{{command}}. Use /help for a list of commands.',
        help: `SillyTavern Telegram Bridge Commands:\n\n` +
              `Chat Management\n` +
              `/new - Start a new chat with the current character.\n` +
              `/listchats - Show all saved chats for the current chat.\n` +
              `/switchchat <chat_name> - Load the specified chat.\n` +
              `/switchchat_<number> - Load a chat by number.\n\n` +
              `Character Management\n` +
              `/listchars - Show all available characters.\n` +
              `/switchchar <character_name> - Switch to the specified character.\n` +
              `/switchchar_<number> - Switch to a character by number.\n\n` +
              `Language Management\n` +
              `/change_lng <ru|en> - Set bot language (ru or en).\n\n` +
              `System Management\n` +
              `/reload - Reload server components and refresh ST web interface.\n` +
              `/restart - Refresh ST web interface and restart server components.\n` +
              `/exit - Shut down server components.\n` +
              `/ping - Check connection status.\n\n` +
              `Help\n` +
              `/help - Show this help.\n`,
        change_lng_invalid: 'Specify language: /change_lng ru or /change_lng en',
        change_lng_success: 'Language set to {{lang}}.'
    }
};

// Function to get translated message
function getTranslatedMessage(language, key, params = {}) {
    const lang = language === 'ru' ? 'ru' : 'en';
    let message = translations[lang][key] || translations.en[key] || key;
    for (const [param, value] of Object.entries(params)) {
        message = message.replace(`{{${param}}}`, value);
    }
    return message;
}

// Function to send long messages with splitting
async function sendLongMessage(bot, chatId, text, language) {
    const MAX_MESSAGE_LENGTH = 4096;
    if (text.length <= MAX_MESSAGE_LENGTH) {
        try {
            await bot.sendMessage(chatId, text);
        } catch (err) {
            logWithTimestamp('error', `Error sending message to Telegram: ${err.message}`);
            if (err.response && err.response.statusCode === 429) {
                const retryAfter = err.response.body.parameters.retry_after || 3;
                logWithTimestamp('warn', `Rate limit hit, retrying after ${retryAfter} seconds`);
                await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
                await bot.sendMessage(chatId, text);
            }
        }
    } else {
        const parts = [];
        for (let i = 0; i < text.length; i += MAX_MESSAGE_LENGTH) {
            parts.push(text.slice(i, i + MAX_MESSAGE_LENGTH));
        }
        for (const part of parts) {
            try {
                await bot.sendMessage(chatId, part);
                await new Promise(resolve => setTimeout(resolve, 500));
            } catch (err) {
                logWithTimestamp('error', `Error sending message part to Telegram: ${err.message}`);
                if (err.response && err.response.statusCode === 429) {
                    const retryAfter = err.response.body.parameters.retry_after || 3;
                    logWithTimestamp('warn', `Rate limit hit, retrying after ${retryAfter} seconds`);
                    await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
                    await bot.sendMessage(chatId, part);
                }
            }
        }
    }
}

// Function to detect Cyrillic text
function isCyrillic(text) {
    return /[\u0400-\u04FF]/.test(text);
}

// Function to translate text using OneRingTranslator
async function translateText(text, language, isUserMessage = false) {
    // Ensure language is valid
    const targetLanguage = language === 'ru' ? 'ru' : 'en';
    
    // Skip translation if text is already in the target language
    if ((targetLanguage === 'ru' && isCyrillic(text)) || (targetLanguage === 'en' && !isCyrillic(text))) {
        logWithTimestamp('log', `Skipping translation, text is already in target language (${targetLanguage}): "${text.slice(0, 100)}${text.length > 100 ? '...' : ''}"`);
        return text;
    }

    // Determine source language for user messages
    const from_lang = isUserMessage ? (isCyrillic(text) ? 'ru' : 'en') : 'en';
    const to_lang = targetLanguage;

    try {
        logWithTimestamp('log', `Sending text for translation: "${text.slice(0, 100)}${text.length > 100 ? '...' : ''}" from ${from_lang} to ${to_lang}`);
        const response = await axios.get('http://127.0.0.1:4990/translate', {
            params: {
                text: text,
                from_lang: from_lang,
                to_lang: to_lang
            }
        });
        const translatedText = response.data.result || text;
        logWithTimestamp('log', `Received translated text: "${translatedText.slice(0, 100)}${translatedText.length > 100 ? '...' : ''}"`);
        return translatedText;
    } catch (error) {
        logWithTimestamp('error', `Error translating text: ${error.message}`);
        return text; // Return original text on error
    }
}

// Logging function with timestamp
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

// Restart protection
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
                logWithTimestamp('error', `Detected potential restart loop! ${data.restarts.length} restarts in ${RESTART_WINDOW_MS / 1000} seconds.`);
                logWithTimestamp('error', 'Server will be stopped to prevent resource exhaustion. Check and fix the issue manually.');
                if (process.env.RESTART_NOTIFY_CHATID) {
                    const chatId = parseInt(process.env.RESTART_NOTIFY_CHATID);
                    if (!isNaN(chatId)) {
                        try {
                            const tempBot = new TelegramBot(require('./config').telegramToken, { polling: false });
                            tempBot.sendMessage(chatId, getTranslatedMessage('ru', 'restart_loop'))
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
        logWithTimestamp('error', 'Error checking restart protection:', error);
    }
}

checkRestartProtection();

const configPath = path.join(__dirname, './config.js');
if (!fs.existsSync(configPath)) {
    logWithTimestamp('error', 'Error: Config file config.js not found!');
    logWithTimestamp('error', 'Copy config.example.js to config.js in the server directory and set your Telegram Bot Token.');
    process.exit(1);
}

const config = require('./config');
const token = config.telegramToken;
const wssPort = config.wssPort;

if (token === 'TOKEN' || token === 'YOUR_TELEGRAM_BOT_TOKEN_HERE') {
    logWithTimestamp('error', 'Error: Configure your Telegram Bot Token in config.js!');
    logWithTimestamp('error', 'Replace telegramToken: \'YOUR_TELEGRAM_BOT_TOKEN_HERE\' with the token from BotFather.');
    process.exit(1);
}

const bot = new TelegramBot(token, { polling: false });
logWithTimestamp('log', 'Initializing Telegram Bot...');

(async function clearAndStartPolling() {
    try {
        logWithTimestamp('log', 'Clearing Telegram message queue...');
        const isRestart = process.env.TELEGRAM_CLEAR_UPDATES === '1';
        if (isRestart) {
            logWithTimestamp('log', 'Restart detected, performing thorough queue cleanup...');
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
                    logWithTimestamp('log', `Cleared ${updates.length} messages, current offset: ${lastUpdateId}`);
                }
            } while (updates && updates.length > 0);
            delete process.env.TELEGRAM_CLEAR_UPDATES;
            logWithTimestamp('log', 'Queue cleanup completed');
        } else {
            const updates = await bot.getUpdates({ limit: 100, timeout: 0 });
            if (updates && updates.length > 0) {
                const lastUpdateId = updates[updates.length - 1].update_id;
                await bot.getUpdates({ offset: lastUpdateId + 1, limit: 1, timeout: 0 });
                logWithTimestamp('log', `Cleared ${updates.length} pending messages`);
            } else {
                logWithTimestamp('log', 'No pending messages to clear');
            }
        }
        bot.startPolling({
            restart: true,
            clean: true
        });
        logWithTimestamp('log', 'Telegram Bot polling started');
    } catch (error) {
        logWithTimestamp('error', 'Error during queue cleanup or polling start:', error);
        bot.startPolling({ restart: true, clean: true });
        logWithTimestamp('log', 'Telegram Bot polling started (after cleanup error)');
    }
})();

const wss = new WebSocket.Server({ port: wssPort });
logWithTimestamp('log', `WebSocket server listening on port ${wssPort}...`);

let sillyTavernClient = null;

function reloadServer(chatId, language) {
    logWithTimestamp('log', 'Reloading server components...');
    Object.keys(require.cache).forEach(function (key) {
        if (key.indexOf('node_modules') === -1) {
            delete require.cache[key];
        }
    });
    try {
        delete require.cache[require.resolve('./config.js')];
        const newConfig = require('./config.js');
        Object.assign(config, newConfig);
        logWithTimestamp('log', 'Configuration file reloaded');
    } catch (error) {
        logWithTimestamp('error', 'Error reloading configuration:', error);
        if (chatId) {
            const errorMsg = getTranslatedMessage(language, 'reload_error', { error: error.message });
            bot.sendMessage(chatId, errorMsg);
        }
        return;
    }
    logWithTimestamp('log', 'Server components reloaded');
    if (chatId) {
        const successMsg = getTranslatedMessage(language, 'reload_success');
        bot.sendMessage(chatId, successMsg);
    }
}

function restartServer(chatId, language) {
    logWithTimestamp('log', 'Restarting server components...');
    bot.stopPolling().then(() => {
        logWithTimestamp('log', 'Telegram Bot polling stopped');
        if (wss) {
            wss.close(() => {
                logWithTimestamp('log', 'WebSocket server closed, preparing to restart...');
                setTimeout(() => {
                    const { spawn } = require('child_process');
                    const serverPath = path.join(__dirname, 'server.js');
                    logWithTimestamp('log', `Restarting server: ${serverPath}`);
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
                logWithTimestamp('log', `Restarting server: ${serverPath}`);
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
        logWithTimestamp('error', 'Error stopping Telegram Bot polling:', err);
        if (wss) {
            wss.close(() => {
                setTimeout(() => {
                    const { spawn } = require('child_process');
                    const serverPath = path.join(__dirname, 'server.js');
                    logWithTimestamp('log', `Restarting server: ${serverPath}`);
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
                logWithTimestamp('log', `Restarting server: ${serverPath}`);
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
    logWithTimestamp('log', 'Shutting down server...');
    const forceExitTimeout = setTimeout(() => {
        logWithTimestamp('error', 'Timeout during exit operation, forcing process termination');
        process.exit(1);
    }, 10000);
    try {
        if (fs.existsSync(RESTART_PROTECTION_FILE)) {
            fs.unlinkSync(RESTART_PROTECTION_FILE);
            logWithTimestamp('log', 'Restart protection file cleared');
        }
    } catch (error) {
        logWithTimestamp('error', 'Error clearing restart protection file:', error);
    }
    const finalExit = () => {
        clearTimeout(forceExitTimeout);
        logWithTimestamp('log', 'Server components successfully closed');
        process.exit(0);
    };
    if (wss) {
        wss.close(() => {
            logWithTimestamp('log', 'WebSocket server closed');
            bot.stopPolling().finally(finalExit);
        });
    } else {
        bot.stopPolling().finally(finalExit);
    }
}

function handleSystemCommand(command, chatId, language) {
    logWithTimestamp('log', `Executing system command: ${command}`);
    if (command === 'ping') {
        const bridgeStatus = getTranslatedMessage(language, 'ping_bridge');
        const stStatus = sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN ?
            getTranslatedMessage(language, 'ping_st_connected') :
            getTranslatedMessage(language, 'ping_st_disconnected');
        bot.sendMessage(chatId, `${bridgeStatus}\n${stStatus}`);
        return;
    }
    let responseMessage = '';
    switch (command) {
        case 'reload':
            responseMessage = getTranslatedMessage(language, 'reload');
            if (sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN) {
                sillyTavernClient.commandToExecuteOnClose = { command, chatId, language };
                sillyTavernClient.send(JSON.stringify({ type: 'system_command', command: 'reload_ui_only', chatId }));
            } else {
                bot.sendMessage(chatId, responseMessage);
                reloadServer(chatId, language);
            }
            break;
        case 'restart':
            responseMessage = getTranslatedMessage(language, 'restart');
            if (sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN) {
                sillyTavernClient.commandToExecuteOnClose = { command, chatId, language };
                sillyTavernClient.send(JSON.stringify({ type: 'system_command', command: 'reload_ui_only', chatId }));
            } else {
                bot.sendMessage(chatId, responseMessage);
                restartServer(chatId, language);
            }
            break;
        case 'exit':
            responseMessage = getTranslatedMessage(language, 'exit');
            if (sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN) {
                sillyTavernClient.commandToExecuteOnClose = { command, chatId, language };
                sillyTavernClient.send(JSON.stringify({ type: 'system_command', command: 'reload_ui_only', chatId }));
            } else {
                bot.sendMessage(chatId, responseMessage);
                exitServer();
            }
            break;
        default:
            logWithTimestamp('warn', `Unknown system command: ${command}`);
            const errorMsg = getTranslatedMessage(language, 'unknown_command', { command });
            bot.sendMessage(chatId, errorMsg);
            return;
    }
    if (sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN) {
        bot.sendMessage(chatId, responseMessage);
    }
}

async function handleTelegramCommand(command, args, chatId, language) {
    logWithTimestamp('log', `Processing Telegram command: /${command} ${args.join(' ')}`);
    bot.sendChatAction(chatId, 'typing').catch(error =>
        logWithTimestamp('error', 'Error sending typing status:', error));
    let replyText = getTranslatedMessage(language, 'unknown_command', { command });
    if (command === 'help') {
        replyText = getTranslatedMessage(language, 'help');
        await sendLongMessage(bot, chatId, replyText, language);
        return;
    }
    if (command === 'change_lng') {
        if (args.length === 0 || !['ru', 'en'].includes(args[0].toLowerCase())) {
            replyText = getTranslatedMessage(language, 'change_lng_invalid');
        } else {
            const newLang = args[0].toLowerCase();
            userLanguages.set(chatId, newLang);
            replyText = getTranslatedMessage(language, 'change_lng_success', { lang: newLang === 'ru' ? 'русский' : 'English' });
        }
        await sendLongMessage(bot, chatId, replyText, language);
        return;
    }
    if (!sillyTavernClient || sillyTavernClient.readyState !== WebSocket.OPEN) {
        replyText = getTranslatedMessage(language, 'no_connection');
        await sendLongMessage(bot, chatId, replyText, language);
        return;
    }
    switch (command) {
        case 'new':
        case 'listchars':
        case 'listchats':
            sillyTavernClient.send(JSON.stringify({
                type: 'execute_command',
                command: command,
                chatId: chatId,
                language: language
            }));
            return;
        case 'switchchar':
            if (args.length === 0) {
                replyText = getTranslatedMessage(language, 'switchchar_no_args');
            } else {
                sillyTavernClient.send(JSON.stringify({
                    type: 'execute_command',
                    command: 'switchchar',
                    args: args,
                    chatId: chatId,
                    language: language
                }));
                return;
            }
            break;
        case 'switchchat':
            if (args.length === 0) {
                replyText = getTranslatedMessage(language, 'switchchat_no_args');
            } else {
                sillyTavernClient.send(JSON.stringify({
                    type: 'execute_command',
                    command: 'switchchat',
                    args: args,
                    chatId: chatId,
                    language: language
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
                    chatId: chatId,
                    language: language
                }));
                return;
            }
            const chatMatch = command.match(/^switchchat_(\d+)$/);
            if (chatMatch) {
                sillyTavernClient.send(JSON.stringify({
                    type: 'execute_command',
                    command: command,
                    chatId: chatId,
                    language: language
                }));
                return;
            }
    }
    await sendLongMessage(bot, chatId, replyText, language);
}

wss.on('connection', ws => {
    logWithTimestamp('log', 'SillyTavern extension connected!');
    sillyTavernClient = ws;

    ws.on('message', async (message) => {
        let data;
        try {
            data = JSON.parse(message);

            // Ensure language is set
            const language = data.language || userLanguages.get(data.chatId) || 'en';
            data.language = language; // Update data.language to ensure consistency

            // Ignore stream messages
            if (data.type === 'stream_chunk' || data.type === 'stream_end') {
                logWithTimestamp('log', `Ignoring ${data.type} for ChatID ${data.chatId}`);
                return;
            }

            // Handle first message of new chat
            if (data.type === 'new_chat_message' && data.chatId) {
                logWithTimestamp('log', `Received first message of new chat for ChatID ${data.chatId}: "${data.text.slice(0, 100)}${data.text.length > 100 ? '...' : ''}"`);
                const textToSend = data.enableTranslation && !isCyrillic(data.text) ? await translateText(data.text, language) : data.text;
                await sendLongMessage(bot, data.chatId, textToSend, language);
                return;
            }

            // Handle final message
            if (data.type === 'final_message_update' && data.chatId) {
                logWithTimestamp('log', `Received final text for ChatID ${data.chatId}`);
                const textToSend = data.enableTranslation && !isCyrillic(data.text) ? await translateText(data.text, language) : data.text;
                await sendLongMessage(bot, data.chatId, textToSend, language);
                return;
            }

            // Handle command execution
            if (data.type === 'command_executed' && data.chatId) {
                logWithTimestamp('log', `Command ${data.command} executed, result: ${data.success ? 'success' : 'error'}`);
                if (data.message) {
                    logWithTimestamp('log', `Command execution message: "${data.message.slice(0, 100)}${data.message.length > 100 ? '...' : ''}"`);
                    // Skip translation for switchchar and listchars commands
                    const noTranslateCommands = ['listchars', 'switchchar', /^switchchar_\d+$/];
                    const needsTranslation = data.enableTranslation && !noTranslateCommands.some(cmd => typeof cmd === 'string' ? cmd === data.command : cmd.test(data.command));
                    const textToSend = needsTranslation && !isCyrillic(data.message) ? await translateText(data.message, language) : data.message;
                    await sendLongMessage(bot, data.chatId, textToSend, language);
                }
                return;
            }

            // Handle other message types
            if (data.type === 'error_message' && data.chatId) {
                logWithTimestamp('error', `Error from SillyTavern, sending to Telegram user ${data.chatId}: ${data.text}`);
                const textToSend = data.enableTranslation && !isCyrillic(data.text) ? await translateText(data.text, language) : data.text;
                await sendLongMessage(bot, data.chatId, textToSend, language);
            } else if (data.type === 'ai_reply' && data.chatId) {
                logWithTimestamp('log', `Received AI reply, sending to Telegram user ${data.chatId}`);
                const textToSend = data.enableTranslation && !isCyrillic(data.text) ? await translateText(data.text, language) : data.text;
                await sendLongMessage(bot, data.chatId, textToSend, language);
            } else if (data.type === 'typing_action' && data.chatId) {
                logWithTimestamp('log', `Sending typing status to Telegram user ${data.chatId}`);
                bot.sendChatAction(data.chatId, 'typing').catch(error =>
                    logWithTimestamp('error', 'Error sending typing status:', error));
            } else if (data.type === 'user_message' && data.chatId) {
                logWithTimestamp('log', `Received user message for ChatID ${data.chatId}: "${data.text.slice(0, 100)}${data.text.length > 100 ? '...' : ''}"`);
                // Translate user message if necessary (e.g., if user sends in Russian but language is 'en')
                const textToSend = data.enableTranslation && data.language === 'en' && isCyrillic(data.text) ? await translateText(data.text, language, true) : data.text;
                if (sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN) {
                    sillyTavernClient.send(JSON.stringify({
                        type: 'user_message',
                        chatId: data.chatId,
                        text: textToSend,
                        language: language
                    }));
                }
            }
        } catch (error) {
            logWithTimestamp('error', 'Error processing message from SillyTavern:', error);
        }
    });

    ws.on('close', () => {
        logWithTimestamp('log', 'SillyTavern extension disconnected.');
        if (ws.commandToExecuteOnClose) {
            const { command, chatId, language } = ws.commandToExecuteOnClose;
            logWithTimestamp('log', `Client disconnected, executing scheduled command: ${command}`);
            if (command === 'reload') reloadServer(chatId, language);
            else if (command === 'restart') restartServer(chatId, language);
            else if (command === 'exit') exitServer();
        }
        sillyTavernClient = null;
    });

    ws.on('error', (error) => {
        logWithTimestamp('error', 'WebSocket error:', error);
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
            const language = userLanguages.get(chatId) || 'en';
            const message = getTranslatedMessage(language, 'restart_notification');
            bot.sendMessage(chatId, message)
                .catch(err => logWithTimestamp('error', 'Error sending restart notification:', err.message))
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
    const language = userLanguages.get(chatId) || (msg.from.language_code && msg.from.language_code.startsWith('ru') ? 'ru' : 'en');
    if (config.allowedUserIds && config.allowedUserIds.length > 0) {
        if (!config.allowedUserIds.includes(userId)) {
            logWithTimestamp('log', `Access denied for non-whitelisted user:\n  - User ID: ${userId}\n  - Username: @${username}\n  - Chat ID: ${chatId}\n  - Message: "${text}"`);
            const errorMsg = getTranslatedMessage(language, 'access_denied');
            await sendLongMessage(bot, chatId, errorMsg, language);
            return;
        }
    }
    if (!text) return;
    if (text.startsWith('/')) {
        const parts = text.slice(1).trim().split(/\s+/);
        const command = parts[0].toLowerCase();
        const args = parts.slice(1);
        if (['reload', 'restart', 'exit', 'ping'].includes(command)) {
            handleSystemCommand(command, chatId, language);
            return;
        }
        await handleTelegramCommand(command, args, chatId, language);
        return;
    }
    if (sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN) {
        logWithTimestamp('log', `Received message from Telegram user ${chatId}: "${text}"`);
        // Translate user message if necessary (e.g., if user sends in Russian but language is 'en')
        const textToSend = language === 'en' && isCyrillic(text) ? await translateText(text, language, true) : text;
        const payload = JSON.stringify({ type: 'user_message', chatId, text: textToSend, language });
        sillyTavernClient.send(payload);
    } else {
        logWithTimestamp('warn', 'Received Telegram message, but SillyTavern extension is not connected.');
        const errorMsg = getTranslatedMessage(language, 'no_connection');
        await sendLongMessage(bot, chatId, errorMsg, language);
    }
});