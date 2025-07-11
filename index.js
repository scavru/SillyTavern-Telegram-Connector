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
    language: 'ru', // Default to Russian for consistency
};

// Translations for command responses
const translations = {
    ru: {
        new_success: 'Новая беседа начата.',
        listchars_empty: 'Персонажи не найдены.',
        listchars_list: 'Список доступных персонажей:\n\n',
        listchars_instruction: '\nИспользуйте /switchchar_номер или /switchchar имя_персонажа для переключения',
        switchchar_no_args: 'Укажите имя или номер персонажа. Использование: /switchchar <имя_персонажа> или /switchchar_номер',
        switchchar_success: 'Переключено на персонажа "{{name}}".',
        switchchar_not_found: 'Персонаж "{{name}}" не найден.',
        listchats_no_character: 'Сначала выберите персонажа.',
        listchats_empty: 'У текущего персонажа нет истории бесед.',
        listchats_list: 'История бесед текущего персонажа:\n\n',
        listchats_instruction: '\nИспользуйте /switchchat_номер или /switchchat имя_беседы для переключения',
        switchchat_no_args: 'Укажите имя беседы. Использование: /switchchat <имя_беседы>',
        switchchat_success: 'Загружена беседа: {{name}}',
        switchchat_failed: 'Не удалось загрузить беседу "{{name}}". Проверьте правильность имени.',
        switchchar_invalid_number: 'Неверный номер персонажа: {{number}}. Используйте /listchars для просмотра доступных персонажей.',
        switchchat_invalid_number: 'Неверный номер беседы: {{number}}. Используйте /listchats для просмотра доступных бесед.',
        unknown_command: 'Неизвестная команда: /{{command}}. Используйте /help для просмотра всех команд.',
        error: 'Ошибка при выполнении команды: {{error}}',
        new_chat_error: 'Новая беседа создана, но элемент первого сообщения не найден в DOM.',
        new_chat_empty: 'Новая беседа создана, но первое сообщение пустое.',
        internal_error: 'Произошла внутренняя ошибка при обработке вашего запроса.'
    },
    en: {
        new_success: 'New chat started.',
        listchars_empty: 'No characters found.',
        listchars_list: 'List of available characters:\n\n',
        listchars_instruction: '\nUse /switchchar_number or /switchchar character_name to switch',
        switchchar_no_args: 'Specify a character name or number. Usage: /switchchar <character_name> or /switchchar_number',
        switchchar_success: 'Switched to character "{{name}}".',
        switchchar_not_found: 'Character "{{name}}" not found.',
        listchats_no_character: 'Select a character first.',
        listchats_empty: 'No chat history for the current character.',
        listchats_list: 'Chat history for the current character:\n\n',
        listchats_instruction: '\nUse /switchchat_number or /switchchat chat_name to switch',
        switchchat_no_args: 'Specify a chat name. Usage: /switchchat <chat_name>',
        switchchat_success: 'Loaded chat: {{name}}',
        switchchat_failed: 'Failed to load chat "{{name}}". Check the name.',
        switchchar_invalid_number: 'Invalid character number: {{number}}. Use /listchars to view available characters.',
        switchchat_invalid_number: 'Invalid chat number: {{number}}. Use /listchats to view available chats.',
        unknown_command: 'Unknown command: /{{command}}. Use /help for a list of commands.',
        error: 'Error executing command: {{error}}',
        new_chat_error: 'New chat created, but the first message element was not found in the DOM.',
        new_chat_empty: 'New chat created, but the first message is empty.',
        internal_error: 'An internal error occurred while processing your request.'
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

let ws = null;
let lastProcessedChatId = null;
let isStreamingMode = false;

function getSettings() {
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = { ...DEFAULT_SETTINGS };
    }
    return extensionSettings[MODULE_NAME];
}

function updateStatus(message, color) {
    const statusEl = document.getElementById('telegram_connection_status');
    if (statusEl) {
        const translatedMessages = {
            'URL 未设置！': getTranslatedMessage('ru', 'url_not_set') || 'URL не указан!',
            '连接中...': getTranslatedMessage('ru', 'connecting') || 'Подключение...',
            '已连接': getTranslatedMessage('ru', 'connected') || 'Подключено',
            '连接已断开': getTranslatedMessage('ru', 'disconnected') || 'Соединение разорвано',
            '连接错误': getTranslatedMessage('ru', 'connection_error') || 'Ошибка подключения'
        };
        statusEl.textContent = `Статус: ${translatedMessages[message] || message}`;
        statusEl.style.color = color;
    }
}

function reloadPage() {
    window.location.reload();
}

async function translateText(text, language) {
    const response = await fetch(`http://127.0.0.1:4990/translate?text=${encodeURIComponent(text)}&from_lang=en&to_lang=${language}`);
    const data = await response.json();
    return data.result || text;
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
            // Ensure language is set from settings if not provided
            const language = data.language || getSettings().language || 'ru';
            data.language = language;

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
                            enableTranslation: getSettings().enableTranslation,
                            language: language
                        }));
                    }
                };
                eventSource.on(event_types.STREAM_TOKEN_RECEIVED, streamCallback);

                const cleanup = () => {
                    eventSource.removeListener(event_types.STREAM_TOKEN_RECEIVED, streamCallback);
                    if (ws && ws.readyState === WebSocket.OPEN && isStreamingMode) {
                        if (!data.error) {
                            ws.send(JSON.stringify({ 
                                type: 'stream_end', 
                                chatId: data.chatId,
                                enableTranslation: getSettings().enableTranslation,
                                language: language
                            }));
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
                    const errorMessage = getTranslatedMessage(language, 'error', { error: error.message || 'Неизвестная ошибка' });
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'error_message',
                            chatId: data.chatId,
                            text: errorMessage,
                            enableTranslation: getSettings().enableTranslation,
                            language: language
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
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'typing_action', chatId: data.chatId }));
                }

                let replyText = getTranslatedMessage(data.language, 'unknown_command', { command: data.command });
                let commandSuccess = false;
                const context = SillyTavern.getContext();

                try {
                    switch (data.command) {
                        case 'new':
                            await doNewChat({ deleteCurrentChat: false });
                            replyText = getTranslatedMessage(data.language, 'new_success');
                            commandSuccess = true;
                            setTimeout(() => {
                                console.log('[Telegram Bridge] Проверяем DOM для первого сообщения...');
                                const chatContainer = document.querySelector("#chat > div");
                                if (!chatContainer) {
                                    console.log('[Telegram Bridge] Контейнер чата (#chat > div) не найден.');
                                    if (ws && ws.readyState === WebSocket.OPEN) {
                                        ws.send(JSON.stringify({
                                            type: 'error_message',
                                            chatId: data.chatId,
                                            text: getTranslatedMessage(data.language, 'new_chat_error'),
                                            enableTranslation: getSettings().enableTranslation,
                                            language: language
                                        }));
                                    }
                                    return;
                                }

                                const messageElement = document.querySelector("#chat > div > div.mes_block > div.mes_text");
                                if (messageElement) {
                                    let renderedText = messageElement.innerHTML
                                        .replace(/<br\s*\/?>/gi, '\n')
                                        .replace(/<\/p>\s*<p>/gi, '\n\n');
                                    const tempDiv = document.createElement('div');
                                    tempDiv.innerHTML = renderedText;
                                    renderedText = tempDiv.textContent || tempDiv.innerText || '';

                                    if (renderedText.trim()) {
                                        console.log(`[Telegram Bridge] Извлечено первое сообщение нового чата для chatId: ${data.chatId}: "${renderedText.slice(0, 100)}${renderedText.length > 100 ? '...' : ''}"`);
                                        if (ws && ws.readyState === WebSocket.OPEN) {
                                            ws.send(JSON.stringify({
                                                type: 'new_chat_message',
                                                chatId: data.chatId,
                                                text: renderedText,
                                                enableTranslation: getSettings().enableTranslation,
                                                language: language
                                            }));
                                        }
                                    } else {
                                        console.log('[Telegram Bridge] Первое сообщение пустое.');
                                        if (ws && ws.readyState === WebSocket.OPEN) {
                                            ws.send(JSON.stringify({
                                                type: 'error_message',
                                                chatId: data.chatId,
                                                text: getTranslatedMessage(data.language, 'new_chat_empty'),
                                                enableTranslation: getSettings().enableTranslation,
                                                language: language
                                            }));
                                        }
                                    }
                                } else {
                                    console.log('[Telegram Bridge] Элемент первого сообщения (#chat > div > div.mes_block > div.mes_text) не найден в DOM.');
                                    if (ws && ws.readyState === WebSocket.OPEN) {
                                        ws.send(JSON.stringify({
                                            type: 'error_message',
                                            chatId: data.chatId,
                                            text: getTranslatedMessage(data.language, 'new_chat_error'),
                                            enableTranslation: getSettings().enableTranslation,
                                            language: language
                                        }));
                                    }
                                }
                            }, 1000);
                            break;
                        case 'listchars': {
                            const characters = context.characters && Array.isArray(context.characters) ? context.characters.slice(1) : [];
                            if (characters.length > 0) {
                                replyText = getTranslatedMessage(data.language, 'listchars_list');
                                characters.forEach((char, index) => {
                                    const charName = char.name || `Character ${index + 1}`;
                                    replyText += `${index + 1}. /switchchar_${index + 1} - ${charName}\n`;
                                });
                                replyText += getTranslatedMessage(data.language, 'listchars_instruction');
                            } else {
                                replyText = getTranslatedMessage(data.language, 'listchars_empty');
                            }
                            commandSuccess = true;
                            break;
                        }
                        case 'switchchar': {
                            if (!data.args || data.args.length === 0) {
                                replyText = getTranslatedMessage(data.language, 'switchchar_no_args');
                                break;
                            }
                            const targetName = data.args.join(' ');
                            const characters = context.characters && Array.isArray(context.characters) ? context.characters : [];
                            const targetChar = characters.find(c => c.name === targetName);

                            if (targetChar) {
                                const charIndex = characters.indexOf(targetChar);
                                await selectCharacterById(charIndex);
                                replyText = getTranslatedMessage(data.language, 'switchchar_success', { name: targetName });
                                commandSuccess = true;
                            } else {
                                replyText = getTranslatedMessage(data.language, 'switchchar_not_found', { name: targetName });
                            }
                            break;
                        }
                        case 'listchats': {
                            if (context.characterId === undefined || context.characterId === null) {
                                replyText = getTranslatedMessage(data.language, 'listchats_no_character');
                                break;
                            }
                            const chatFiles = await getPastCharacterChats(context.characterId) || [];
                            if (chatFiles.length > 0) {
                                replyText = getTranslatedMessage(data.language, 'listchats_list');
                                chatFiles.forEach((chat, index) => {
                                    const chatName = chat.file_name ? chat.file_name.replace('.jsonl', '') : `Chat ${index + 1}`;
                                    replyText += `${index + 1}. /switchchat_${index + 1} - ${chatName}\n`;
                                });
                                replyText += getTranslatedMessage(data.language, 'listchats_instruction');
                            } else {
                                replyText = getTranslatedMessage(data.language, 'listchats_empty');
                            }
                            commandSuccess = true;
                            break;
                        }
                        case 'switchchat': {
                            if (!data.args || data.args.length === 0) {
                                replyText = getTranslatedMessage(data.language, 'switchchat_no_args');
                                break;
                            }
                            const targetChatFile = `${data.args.join(' ')}`;
                            try {
                                await openCharacterChat(targetChatFile);
                                replyText = getTranslatedMessage(data.language, 'switchchat_success', { name: targetChatFile });
                                commandSuccess = true;
                            } catch (err) {
                                console.error(err);
                                replyText = getTranslatedMessage(data.language, 'switchchat_failed', { name: targetChatFile });
                            }
                            break;
                        }
                        default: {
                            const charMatch = data.command.match(/^switchchar_(\d+)$/);
                            if (charMatch) {
                                const index = parseInt(charMatch[1]) - 1;
                                const characters = context.characters && Array.isArray(context.characters) ? context.characters.slice(1) : [];
                                if (index >= 0 && index < characters.length) {
                                    const targetChar = characters[index];
                                    const charIndex = context.characters.indexOf(targetChar);
                                    await selectCharacterById(charIndex);
                                    replyText = getTranslatedMessage(data.language, 'switchchar_success', { name: targetChar.name || `Character ${index + 1}` });
                                    commandSuccess = true;
                                } else {
                                    replyText = getTranslatedMessage(data.language, 'switchchar_invalid_number', { number: index + 1 });
                                }
                                break;
                            }

                            const chatMatch = data.command.match(/^switchchat_(\d+)$/);
                            if (chatMatch) {
                                if (context.characterId === undefined || context.characterId === null) {
                                    replyText = getTranslatedMessage(data.language, 'listchats_no_character');
                                    break;
                                }
                                const index = parseInt(chatMatch[1]) - 1;
                                const chatFiles = await getPastCharacterChats(context.characterId) || [];
                                if (index >= 0 && index < chatFiles.length) {
                                    const targetChat = chatFiles[index];
                                    const chatName = targetChat.file_name ? targetChat.file_name.replace('.jsonl', '') : `Chat ${index + 1}`;
                                    try {
                                        await openCharacterChat(chatName);
                                        replyText = getTranslatedMessage(data.language, 'switchchat_success', { name: chatName });
                                        commandSuccess = true;
                                    } catch (err) {
                                        console.error(err);
                                        replyText = getTranslatedMessage(data.language, 'switchchat_failed', { name: chatName });
                                    }
                                } else {
                                    replyText = getTranslatedMessage(data.language, 'switchchat_invalid_number', { number: index + 1 });
                                }
                                break;
                            }

                            replyText = getTranslatedMessage(data.language, 'unknown_command', { command: data.command });
                        }
                    }
                } catch (error) {
                    console.error('[Telegram Bridge] Ошибка при выполнении команды:', error);
                    replyText = getTranslatedMessage(data.language, 'error', { error: error.message || 'Неизвестная ошибка' });
                }

                if (ws && ws.readyState === WebSocket.OPEN) {
                    const translationEnabled = ['listchars', 'switchchar'].includes(data.command) || /^switchchar_\d+$/.test(data.command) ? false : getSettings().enableTranslation;
                    ws.send(JSON.stringify({
                        type: 'command_executed',
                        command: data.command,
                        success: commandSuccess,
                        message: replyText,
                        enableTranslation: translationEnabled,
                        language: language
                    }));
                }

                return;
            }
        } catch (error) {
            console.error('[Telegram Bridge] Ошибка при обработке запроса:', error);
            if (data && data.chatId && ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ 
                    type: 'error_message', 
                    chatId: data.chatId, 
                    text: getTranslatedMessage(data.language, 'internal_error'),
                    enableTranslation: getSettings().enableTranslation,
                    language: language
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
    console.log('[Telegram Bridge] Попытка загрузки интерфейса настроек...');
    try {
        const settingsHtml = await $.get(`/scripts/extensions/third-party/${MODULE_NAME}/settings.html`);
        $('#extensions_settings').append(settingsHtml);
        console.log('[Telegram Bridge] Интерфейс настроек добавлен.');

        const settings = getSettings();
        $('#telegram_bridge_url').val(settings.bridgeUrl);
        $('#telegram_auto_connect').prop('checked', settings.autoConnect);
        $('#telegram_enable_translation').prop('checked', settings.enableTranslation);
        $('#telegram_language_select').val(settings.language);

        $('#telegram_bridge_url').on('input', () => {
            const settings = getSettings();
            settings.bridgeUrl = $('#telegram_bridge_url').val();
            saveSettingsDebounced();
        });

        $('#telegram_auto_connect').on('change', function () {
            const settings = getSettings();
            settings.autoConnect = $(this).prop('checked');
            console.log(`[Telegram Bridge] Автоматическое подключение изменено на: ${settings.autoConnect}`);
            saveSettingsDebounced();
        });

        $('#telegram_enable_translation').on('change', function () {
            const settings = getSettings();
            settings.enableTranslation = $(this).prop('checked');
            console.log(`[Telegram Bridge] Перевод сообщений изменён на: ${settings.enableTranslation}`);
            saveSettingsDebounced();
        });

        $('#telegram_language_select').on('change', function () {
            const settings = getSettings();
            settings.language = $(this).val();
            console.log(`[Telegram Bridge] Язык изменён на: ${settings.language}`);
            saveSettingsDebounced();
        });

        $('#telegram_connect_button').on('click', connect);
        $('#telegram_disconnect_button').on('click', disconnect);

        if (settings.autoConnect) {
            console.log('[Telegram Bridge] Автоматическое подключение включено, подключаемся...');
            connect();
        }
    } catch (error) {
        console.error('[Telegram Bridge] Не удалось загрузить HTML настроек.', error);
    }
    console.log('[Telegram Bridge] Расширение загружено.');
});

function handleFinalMessage(lastMessageIdInChatArray) {
    if (!ws || ws.readyState !== WebSocket.OPEN || !lastProcessedChatId) {
        return;
    }

    const lastMessageIndex = lastMessageIdInChatArray - 1;
    if (lastMessageIndex < 0) return;

    setTimeout(() => {
        const context = SillyTavern.getContext();
        const lastMessage = context.chat && Array.isArray(context.chat) && context.chat[lastMessageIndex];

        if (lastMessage && !lastMessage.is_user && !lastMessage.is_system) {
            const messageElement = $(`#chat .mes[mesid="${lastMessageIndex}"]`);

            if (messageElement.length > 0) {
                const messageTextElement = messageElement.find('.mes_text');
                let renderedText = messageTextElement.html()
                    .replace(/<br\s*\/?>/gi, '\n')
                    .replace(/<\/p>\s*<p>/gi, '\n\n');
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = renderedText;
                renderedText = tempDiv.textContent;

                console.log(`[Telegram Bridge] Захвачен финальный текст, отправка обновления для chatId: ${lastProcessedChatId}`);

                if (isStreamingMode) {
                    ws.send(JSON.stringify({
                        type: 'final_message_update',
                        chatId: lastProcessedChatId,
                        text: renderedText,
                        enableTranslation: getSettings().enableTranslation,
                        language: getSettings().language || 'ru'
                    }));
                    isStreamingMode = false;
                } else {
                    ws.send(JSON.stringify({
                        type: 'ai_reply',
                        chatId: lastProcessedChatId,
                        text: renderedText,
                        enableTranslation: getSettings().enableTranslation,
                        language: getSettings().language || 'ru'
                    }));
                }

                lastProcessedChatId = null;
            }
        }
    }, 100);
}

eventSource.on(event_types.GENERATION_ENDED, handleFinalMessage);
eventSource.on(event_types.GENERATION_STOPPED, handleFinalMessage);