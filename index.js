const {
    extensionSettings,
    deleteLastMessage,
    saveSettingsDebounced,
} = SillyTavern.getContext();

import {
    eventSource,
    event_types,
    getPastCharacterChats,
    sendMessageAsUser,
    doNewChat,
    selectCharacterById,
    openCharacterChat,
    Generate,
    setExternalAbortController,
} from "../../../../script.js";

const MODULE_NAME = 'SillyTavern-Telegram-Connector';
const DEFAULT_SETTINGS = {
    bridgeUrl: 'ws://127.0.0.1:2333',
    autoConnect: true,
    enableTranslation: true,
};

let ws = null;
let lastProcessedChatId = null;
let isStreamingMode = false;

function getSettings() {
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = { ...DEFAULT_SETTINGS };
    }
    return extensionSettings[MODULE_NAME];
}

async function translateText(text) {
    try {
        console.log(`[Telegram Bridge] Sending text for translation: "${text.slice(0, 100)}${text.length > 100 ? '...' : ''}"`);
        const params = new URLSearchParams({
            text: text,
            from_lang: 'en',
            to_lang: 'ru'
        });
        const response = await fetch(`http://127.0.0.1:4990/translate?${params.toString()}`, {
            method: 'GET'
        });
        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }
        const data = await response.json();
        const translatedText = data.result || text;
        console.log(`[Telegram Bridge] Received translated text: "${translatedText.slice(0, 100)}${translatedText.length > 100 ? '...' : ''}"`);
        return translatedText;
    } catch (error) {
        console.error('[Telegram Bridge] Translation error:', error);
        return text; // Return original text on error
    }
}

function updateStatus(message, color) {
    const statusEl = document.getElementById('telegram_connection_status');
    if (statusEl) {
        const translatedMessages = {
            'URL 未设置！': 'URL не указан!',
            '连接中...': 'Подключение...',
            '已连接': 'Подключено',
            '连接已断开': 'Соединение разорвано',
            '连接 ошибки': 'Ошибка подключения'
        };
        statusEl.textContent = `Статус: ${translatedMessages[message] || message}`;
        statusEl.style.color = color;
    } else {
        console.error('[Telegram Bridge] Status element not found in settings HTML');
    }
}

function reloadPage() {
    window.location.reload();
}

function connect() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        console.log('[Telegram Bridge] Уже подключено');
        return;
    }

    const settings = getSettings();
    if (!settings.bridgeUrl) {
        updateStatus('URL не указан!', 'red');
        return;
    }

    updateStatus('Подключение...', 'orange');
    console.log(`[Telegram Bridge] Подключение к ${settings.bridgeUrl}...`);

    ws = new WebSocket(settings.bridgeUrl);

    ws.onopen = () => {
        console.log('[Telegram Bridge] Подключение успешно!');
        updateStatus('Подключено', 'green');
    };

    ws.onmessage = async (event) => {
        let data;
        try {
            data = JSON.parse(event.data);

            if (data.type === 'user_message') {
                console.log('[Telegram Bridge] Получено пользовательское сообщение.', data);
                lastProcessedChatId = data.chatId;
                isStreamingMode = false;

                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'typing_action', chatId: data.chatId }));
                }

                await sendMessageAsUser(data.text);

                const streamCallback = (cumulativeText) => {
                    isStreamingMode = true;
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'stream_chunk',
                            chatId: data.chatId,
                            text: cumulativeText,
                            translate: getSettings().enableTranslation
                        }));
                    }
                };
                eventSource.on(event_types.STREAM_TOKEN_RECEIVED, streamCallback);

                const cleanup = () => {
                    eventSource.removeListener(event_types.STREAM_TOKEN_RECEIVED, streamCallback);
                    if (ws && ws.readyState === WebSocket.OPEN && isStreamingMode) {
                        if (!data.error) {
                            ws.send(JSON.stringify({ type: 'stream_end', chatId: data.chatId }));
                        }
                    }
                };

                eventSource.once(event_types.GENERATION_ENDED, cleanup);
                eventSource.once(event_types.GENERATION_STOPPED, cleanup);

                try {
                    const abortController = new AbortController();
                    setExternalAbortController(abortController);
                    await Generate('normal', { signal: abortController.signal });
                } catch (error) {
                    console.error("[Telegram Bridge] Ошибка в Generate():", error);
                    await deleteLastMessage();
                    console.log('[Telegram Bridge] Удалено пользовательское сообщение, вызвавшее ошибку.');

                    const errorMessage = `Извините, произошла ошибка при генерации ответа AI.\nВаше последнее сообщение было удалено, пожалуйста, попробуйте снова или отправьте другое сообщение.\n\nДетали ошибки: ${error.message || 'Неизвестная ошибка'}`;
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'error_message',
                            chatId: data.chatId,
                            text: errorMessage,
                            translate: getSettings().enableTranslation
                        }));
                    }
                    data.error = true;
                    cleanup();
                }
                return;
            }

            if (data.type === 'system_command') {
                console.log('[Telegram Bridge] Получена системная команда', data);
                if (data.command === 'reload_ui_only') {
                    console.log('[Telegram Bridge] Перезагрузка интерфейса...');
                    setTimeout(reloadPage, 500);
                }
                return;
            }

            if (data.type === 'execute_command') {
                console.log('[Telegram Bridge] Выполнение команды', data);
                if (ws && ws.readyState === WebSocket.OPEN && data.chatId) {
                    ws.send(JSON.stringify({ type: 'typing_action', chatId: data.chatId }));
                }

                let replyText = 'Не удалось выполнить команду, попробуйте позже.';
                const context = SillyTavern.getContext();
                let commandSuccess = false;
                const noTranslateCommands = ['listchars', 'listchats', 'switchchar'];
                const isNoTranslateCommand = noTranslateCommands.includes(data.command) || 
                                            data.command.match(/^switchchar_\d+$/) || 
                                            data.command.match(/^switchchat_\d+$/);

                try {
                    switch (data.command) {
                        case 'new': {
                            await doNewChat({ deleteCurrentChat: false });
                            replyText = 'Новая беседа начата.';
                            commandSuccess = true;

                            // Capture the first message after creating a new chat
                            setTimeout(async () => {
                                console.log('[Telegram Bridge] Attempting to capture first message after /new');
                                const messageElement = document.querySelector('#chat > div > div.mes_block > div.mes_text');
                                if (messageElement) {
                                    let firstMessageText = messageElement.innerHTML
                                        .replace(/<br\s*\/?>/gi, '\n')
                                        .replace(/<\/p>\s*<p>/gi, '\n\n')
                                        .replace(/ /g, ' ')
                                        .replace(/&/g, '&')
                                        .replace(/</g, '<')
                                        .replace(/>/g, '>');
                                    const tempDiv = document.createElement('div');
                                    tempDiv.innerHTML = firstMessageText;
                                    firstMessageText = tempDiv.textContent.trim();
                                    console.log(`[Telegram Bridge] Captured first message: "${firstMessageText.slice(0, 100)}${firstMessageText.length > 100 ? '...' : ''}"`);

                                    if (firstMessageText && ws && ws.readyState === WebSocket.OPEN) {
                                        console.log(`[Telegram Bridge] Sending ai_reply for chatId: ${data.chatId}, translate: ${getSettings().enableTranslation}`);
                                        ws.send(JSON.stringify({
                                            type: 'ai_reply',
                                            chatId: data.chatId,
                                            text: firstMessageText,
                                            translate: getSettings().enableTranslation
                                        }));
                                    } else {
                                        console.error('[Telegram Bridge] No first message found or WebSocket not open', {
                                            hasMessage: !!firstMessageText,
                                            wsState: ws?.readyState
                                        });
                                    }
                                } else {
                                    console.error('[Telegram Bridge] Message element not found for new chat');
                                }
                            }, 1000); // Delay to ensure DOM update
                            break;
                        }
                        case 'listchars': {
                            const characters = context.characters.slice(1);
                            if (characters.length > 0) {
                                replyText = 'Список доступных персонажей:\n\n';
                                characters.forEach((char, index) => {
                                    replyText += `${index + 1}. /switchchar_${index + 1} - ${char.name}\n`;
                                });
                                replyText += '\nИспользуйте /switchchar_номер или /switchchar имя_персонажа для переключения';
                            } else {
                                replyText = 'Персонажи не найдены.';
                            }
                            commandSuccess = true;
                            break;
                        }
                        case 'switchchar': {
                            if (!data.args || data.args.length === 0) {
                                replyText = 'Укажите имя или номер персонажа. Использование: /switchchar <имя_персонажа> или /switchchar_номер';
                                break;
                            }
                            const targetName = data.args.join(' ');
                            const characters = context.characters;
                            const targetChar = characters.find(c => c.name === targetName);

                            if (targetChar) {
                                const charIndex = characters.indexOf(targetChar);
                                await selectCharacterById(charIndex);
                                replyText = `Переключено на персонажа "${targetName}".`;
                                commandSuccess = true;
                            } else {
                                replyText = `Персонаж "${targetName}" не найден.`;
                            }
                            break;
                        }
                        case 'listchats': {
                            if (context.characterId === undefined) {
                                replyText = 'Сначала выберите персонажа.';
                                break;
                            }
                            const chatFiles = await getPastCharacterChats(context.characterId);
                            if (chatFiles.length > 0) {
                                replyText = 'История бесед текущего персонажа:\n\n';
                                chatFiles.forEach((chat, index) => {
                                    const chatName = chat.file_name.replace('.jsonl', '');
                                    replyText += `${index + 1}. /switchchat_${index + 1} - ${chatName}\n`;
                                });
                                replyText += '\nИспользуйте /switchchat_номер или /switchchat имя_беседы для переключения';
                            } else {
                                replyText = 'У текущего персонажа нет истории бесед.';
                            }
                            commandSuccess = true;
                            break;
                        }
                        case 'switchchat': {
                            if (!data.args || data.args.length === 0) {
                                replyText = 'Укажите имя беседы. Использование: /switchchat <имя_беседы>';
                                break;
                            }
                            const targetChatFile = `${data.args.join(' ')}`;
                            try {
                                await openCharacterChat(targetChatFile);
                                replyText = `Загружена беседа: ${targetChatFile}`;
                                commandSuccess = true;
                            } catch (err) {
                                console.error(err);
                                replyText = `Не удалось загрузить беседу "${targetChatFile}". Проверьте правильность имени.`;
                            }
                            break;
                        }
                        default: {
                            const charMatch = data.command.match(/^switchchar_(\d+)$/);
                            if (charMatch) {
                                const index = parseInt(charMatch[1]) - 1;
                                const characters = context.characters.slice(1);
                                if (index >= 0 && index < characters.length) {
                                    const targetChar = characters[index];
                                    const charIndex = context.characters.indexOf(targetChar);
                                    await selectCharacterById(charIndex);
                                    replyText = `Переключено на персонажа "${targetChar.name}".`;
                                    commandSuccess = true;
                                } else {
                                    replyText = `Неверный номер персонажа: ${index + 1}. Используйте /listchars для просмотра доступных персонажей.`;
                                }
                                break;
                            }

                            const chatMatch = data.command.match(/^switchchat_(\d+)$/);
                            if (chatMatch) {
                                if (context.characterId === undefined) {
                                    replyText = 'Сначала выберите персонажа.';
                                    break;
                                }
                                const index = parseInt(chatMatch[1]) - 1;
                                const chatFiles = await getPastCharacterChats(context.characterId);

                                if (index >= 0 && index < chatFiles.length) {
                                    const targetChat = chatFiles[index];
                                    const chatName = targetChat.file_name.replace('.jsonl', '');
                                    try {
                                        await openCharacterChat(chatName);
                                        replyText = `Загружена беседа: ${chatName}`;
                                        commandSuccess = true;
                                    } catch (err) {
                                        console.error(err);
                                        replyText = `Не удалось загрузить беседу.`;
                                    }
                                } else {
                                    replyText = `Неверный номер беседы: ${index + 1}. Используйте /listchats для просмотра доступных бесед.`;
                                }
                                break;
                            }

                            replyText = `Неизвестная команда: /${data.command}. Используйте /help для просмотра всех команд.`;
                        }
                    }
                } catch (error) {
                    console.error('[Telegram Bridge] Ошибка при выполнении команды:', error);
                    replyText = `Ошибка при выполнении команды: ${error.message || 'Неизвестная ошибка'}`;
                }

                if (ws && ws.readyState === WebSocket.OPEN && data.chatId) {
                    ws.send(JSON.stringify({ 
                        type: 'ai_reply', 
                        chatId: data.chatId, 
                        text: replyText, 
                        translate: isNoTranslateCommand ? false : getSettings().enableTranslation 
                    }));
                } else {
                    console.error('[Telegram Bridge] Не удалось отправить ответ: WebSocket не активен или chatId отсутствует', { wsState: ws?.readyState, chatId: data.chatId });
                }

                return;
            }
        } catch (error) {
            console.error('[Telegram Bridge] Ошибка при обработке запроса:', error);
            if (data && data.chatId && ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ 
                    type: 'error_message', 
                    chatId: data.chatId, 
                    text: 'Произошла внутренняя ошибка при обработке вашего запроса.', 
                    translate: getSettings().enableTranslation 
                }));
            }
        }
    };

    ws.onclose = () => {
        console.log('[Telegram Bridge] Соединение закрыто.');
        updateStatus('Соединение разорвано', 'red');
        ws = null;
    };

    ws.onerror = (error) => {
        console.error('[Telegram Bridge] Ошибка WebSocket:', error);
        updateStatus('Ошибка подключения', 'red');
        ws = null;
    };
}

function disconnect() {
    if (ws) {
        ws.close();
    }
}

jQuery(async () => {
    console.log('[Telegram Bridge] Attempting to load settings UI...');
    try {
        const settingsPath = `/scripts/extensions/third-party/${MODULE_NAME}/settings.html`;
        console.log(`[Telegram Bridge] Fetching settings from: ${settingsPath}`);
        const settingsHtml = await $.get(settingsPath);
        const extensionsSettings = $('#extensions_settings');
        if (extensionsSettings.length === 0) {
            console.error('[Telegram Bridge] Extensions settings container (#extensions_settings) not found in DOM');
            return;
        }
        extensionsSettings.append(settingsHtml);
        console.log('[Telegram Bridge] Settings UI appended successfully.');

        const settings = getSettings();
        const bridgeUrlInput = $('#telegram_bridge_url');
        const autoConnectCheckbox = $('#telegram_auto_connect_checkbox');
        const translationCheckbox = $('#telegram_enable_translation');

        if (bridgeUrlInput.length === 0 || autoConnectCheckbox.length === 0 || translationCheckbox.length === 0) {
            console.error('[Telegram Bridge] One or more settings elements not found:', {
                bridgeUrl: !!bridgeUrlInput.length,
                autoConnect: !!autoConnectCheckbox.length,
                translation: !!translationCheckbox.length
            });
            return;
        }

        bridgeUrlInput.val(settings.bridgeUrl);
        autoConnectCheckbox.prop('checked', settings.autoConnect);
        translationCheckbox.prop('checked', settings.enableTranslation);

        bridgeUrlInput.on('input', () => {
            const settings = getSettings();
            settings.bridgeUrl = bridgeUrlInput.val();
            console.log(`[Telegram Bridge] Bridge URL updated to: ${settings.bridgeUrl}`);
            saveSettingsDebounced();
        });

        autoConnectCheckbox.on('change', function () {
            const settings = getSettings();
            settings.autoConnect = $(this).prop('checked');
            console.log(`[Telegram Bridge] Auto-connect changed to: ${settings.autoConnect}`);
            saveSettingsDebounced();
        });

        translationCheckbox.on('change', function () {
            const settings = getSettings();
            settings.enableTranslation = $(this).prop('checked');
            console.log(`[Telegram Bridge] Translation changed to: ${settings.enableTranslation}`);
            saveSettingsDebounced();
        });

        $('#telegram_connect_button').on('click', connect);
        $('#telegram_disconnect_button').on('click', disconnect);

        if (settings.autoConnect) {
            console.log('[Telegram Bridge] Auto-connect enabled, connecting...');
            connect();
        }

    } catch (error) {
        console.error('[Telegram Bridge] Failed to load settings HTML:', error);
    }
    console.log('[Telegram Bridge] Extension loaded.');
});

function handleFinalMessage(lastMessageIdInChatArray) {
    if (!ws || ws.readyState !== WebSocket.OPEN || !lastProcessedChatId) {
        return;
    }

    const lastMessageIndex = lastMessageIdInChatArray - 1;
    if (lastMessageIndex < 0) return;

    setTimeout(() => {
        const context = SillyTavern.getContext();
        const lastMessage = context.chat[lastMessageIndex];

        if (lastMessage && !lastMessage.is_user && !lastMessage.is_system) {
            const messageElement = $(`#chat .mes[mesid="${lastMessageIndex}"]`);

            if (messageElement.length > 0) {
                const messageTextElement = messageElement.find('.mes_text');
                let renderedText = messageTextElement.html()
                    .replace(/<br\s*\/?>/gi, '\n')
                    .replace(/<\/p>\s*<p>/gi, '\n\n')
                    .replace(/ /g, ' ')
                    .replace(/&/g, '&')
                    .replace(/</g, '<')
                    .replace(/>/g, '>');

                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = renderedText;
                renderedText = tempDiv.textContent.trim();

                console.log(`[Telegram Bridge] Captured final text, sending update for chatId: ${lastProcessedChatId}`);

                if (isStreamingMode) {
                    ws.send(JSON.stringify({
                        type: 'final_message_update',
                        chatId: lastProcessedChatId,
                        text: renderedText,
                        translate: getSettings().enableTranslation
                    }));
                    isStreamingMode = false;
                } else {
                    ws.send(JSON.stringify({
                        type: 'ai_reply',
                        chatId: lastProcessedChatId,
                        text: renderedText,
                        translate: getSettings().enableTranslation
                    }));
                }

                lastProcessedChatId = null;
            }
        }
    }, 100);
}

eventSource.on(event_types.GENERATION_ENDED, handleFinalMessage);
eventSource.on(event_types.GENERATION_STOPPED, handleFinalMessage);