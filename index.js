// index.js

// Только деконструируем свойства, которые действительно существуют в объекте, возвращаемом getContext()
const {
    extensionSettings,
    deleteLastMessage, // Импорт функции удаления последнего сообщения
    saveSettingsDebounced, // Импорт функции сохранения настроек
} = SillyTavern.getContext();

// Функция getContext является частью глобального объекта SillyTavern, ее не нужно импортировать
// Вызываем SillyTavern.getContext() напрямую, когда это необходимо

// Импорт всех необходимых функций публичного API из script.js
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
    enableTranslation: true, // Добавляем новую настройку
};

let ws = null; // Экземпляр WebSocket
let lastProcessedChatId = null; // Хранит ID последнего обработанного чата Telegram

// Глобальная переменная для отслеживания режима потоковой передачи
let isStreamingMode = false;

// --- Вспомогательные функции ---
function getSettings() {
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = { ...DEFAULT_SETTINGS };
    }
    return extensionSettings[MODULE_NAME];
}

function updateStatus(message, color) {
    const statusEl = document.getElementById('telegram_connection_status');
    if (statusEl) {
        // Перевод статусных сообщений
        const translatedMessages = {
            'URL 未设置！': 'URL не указан!',
            '连接中...': 'Подключение...',
            '已连接': 'Подключено',
            '连接已断开': 'Соединение разорвано',
            '连接错误': 'Ошибка подключения'
        };
        statusEl.textContent = `Статус: ${translatedMessages[message] || message}`;
        statusEl.style.color = color;
    }
}

function reloadPage() {
    window.location.reload();
}
// ---

// Подключение к серверу WebSocket
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

            // --- Обработка пользовательских сообщений ---
            if (data.type === 'user_message') {
                console.log('[Telegram Bridge] Получено пользовательское сообщение.', data);

                // Сохранение текущего chatId
                lastProcessedChatId = data.chatId;

                // По умолчанию предполагаем, что это не потоковый режим
                isStreamingMode = false;

                // 1. Отправка статуса "печатает" в Telegram (независимо от режима)
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'typing_action', chatId: data.chatId }));
                }

                // 2. Добавление пользовательского сообщения в SillyTavern
                await sendMessageAsUser(data.text);

                // 3. Настройка обратного вызова для потоковой передачи
                const streamCallback = (cumulativeText) => {
                    // Установка флага потокового режима
                    isStreamingMode = true;
                    // Отправка каждого текстового фрагмента через WebSocket на сервер
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'stream_chunk',
                            chatId: data.chatId,
                            text: cumulativeText,
                            enableTranslation: getSettings().enableTranslation // Добавляем флаг перевода
                        }));
                    }
                };
                eventSource.on(event_types.STREAM_TOKEN_RECEIVED, streamCallback);

                // 4. Определение функции очистки
                const cleanup = () => {
                    eventSource.removeListener(event_types.STREAM_TOKEN_RECEIVED, streamCallback);
                    if (ws && ws.readyState === WebSocket.OPEN && isStreamingMode) {
                        // Отправка stream_end только если нет ошибок и режим потоковый
                        if (!data.error) {
                            ws.send(JSON.stringify({ 
                                type: 'stream_end', 
                                chatId: data.chatId,
                                enableTranslation: getSettings().enableTranslation // Добавляем флаг перевода
                            }));
                        }
                    }
                    // Не сбрасываем isStreamingMode здесь, это сделает handleFinalMessage
                };

                // 5. Слушатель завершения генерации, срабатывает один раз
                eventSource.once(event_types.GENERATION_ENDED, cleanup);
                // Слушатель остановки генерации
                eventSource.once(event_types.GENERATION_STOPPED, cleanup);

                // 6. Запаривание процесса генерации в SillyTavern
                try {
                    const abortController = new AbortController();
                    setExternalAbortController(abortController);
                    await Generate('normal', { signal: abortController.signal });
                } catch (error) {
                    console.error("[Telegram Bridge] Ошибка в Generate():", error);

                    // a. Удаление сообщения пользователя, вызвавшего ошибку
                    await deleteLastMessage();
                    console.log('[Telegram Bridge] Удалено пользовательское сообщение, вызвавшее ошибку.');

                    // b. Подготовка и отправка сообщения об ошибке
                    const errorMessage = `Извините, произошла ошибка при генерации ответа AI.\nВаше последнее сообщение было удалено, пожалуйста, попробуйте снова или отправьте другое сообщение.\n\nДетали ошибки: ${error.message || 'Неизвестная ошибка'}`;
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'error_message',
                            chatId: data.chatId,
                            text: errorMessage,
                            enableTranslation: getSettings().enableTranslation // Добавляем флаг перевода
                        }));
                    }

                    // c. Пометка ошибки для функции очистки
                    data.error = true;
                    cleanup(); // Очистка слушателей
                }

                return;
            }

            // --- Обработка системных команд ---
            if (data.type === 'system_command') {
                console.log('[Telegram Bridge] Получена системная команда', data);
                if (data.command === 'reload_ui_only') {
                    console.log('[Telegram Bridge] Перезагрузка интерфейса...');
                    setTimeout(reloadPage, 500);
                }
                return;
            }

            // --- Обработка выполнения команд ---
            if (data.type === 'execute_command') {
                console.log('[Telegram Bridge] Выполнение команды', data);

                // Отправка статуса "печатает"
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'typing_action', chatId: data.chatId }));
                }

                let replyText = 'Не удалось выполнить команду, попробуйте позже.';

                // Вызов глобального SillyTavern.getContext()
                const context = SillyTavern.getContext();
                let commandSuccess = false;

                try {
                    switch (data.command) {
                        case 'new':
                            await doNewChat({ deleteCurrentChat: false });
                            replyText = 'Новая беседа начата.';
                            commandSuccess = true;
                            break;
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
                            // Обработка специальных команд, таких как switchchar_1, switchchat_2
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

                // Отправка результата выполнения команды
                if (ws && ws.readyState === WebSocket.OPEN) {
                    // Отправка результата в Telegram
                    ws.send(JSON.stringify({ 
                        type: 'ai_reply', 
                        chatId: data.chatId, 
                        text: replyText,
                        enableTranslation: getSettings().enableTranslation // Добавляем флаг перевода
                    }));

                    // Отправка статуса выполнения команды на сервер
                    ws.send(JSON.stringify({
                        type: 'command_executed',
                        command: data.command,
                        success: commandSuccess,
                        message: replyText,
                        enableTranslation: getSettings().enableTranslation // Добавляем флаг перевода
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
                    text: 'Произошла внутренняя ошибка при обработке вашего запроса.',
                    enableTranslation: getSettings().enableTranslation // Добавляем флаг перевода
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

// Выполняется при загрузке расширения
jQuery(async () => {
    console.log('[Telegram Bridge] Попытка загрузки интерфейса настроек...');
    try {
        const settingsHtml = await $.get(`/scripts/extensions/third-party/${MODULE_NAME}/settings.html`);
        $('#extensions_settings').append(settingsHtml);
        console.log('[Telegram Bridge] Интерфейс настроек добавлен.');

        const settings = getSettings();
        $('#telegram_bridge_url').val(settings.bridgeUrl);
        $('#telegram_auto_connect').prop('checked', settings.autoConnect);
        $('#telegram_enable_translation').prop('checked', settings.enableTranslation); // Инициализация галочки перевода

        $('#telegram_bridge_url').on('input', () => {
            const settings = getSettings();
            settings.bridgeUrl = $('#telegram_bridge_url').val();
            // Сохранение настроек через saveSettingsDebounced
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

// Глобальный слушатель для обработки финального сообщения
function handleFinalMessage(lastMessageIdInChatArray) {
    // Проверка подключения WebSocket и наличия chatId
    if (!ws || ws.readyState !== WebSocket.OPEN || !lastProcessedChatId) {
        return;
    }

    const lastMessageIndex = lastMessageIdInChatArray - 1;
    if (lastMessageIndex < 0) return;

    // Задержка для завершения обновления DOM
    setTimeout(() => {
        // Вызов глобального SillyTavern.getContext()
        const context = SillyTavern.getContext();
        const lastMessage = context.chat[lastMessageIndex];

        // Проверка, что это ответ AI, вызванный через Telegram
        if (lastMessage && !lastMessage.is_user && !lastMessage.is_system) {
            const messageElement = $(`#chat .mes[mesid="${lastMessageIndex}"]`);

            if (messageElement.length > 0) {
                // Получение текстового элемента сообщения
                const messageTextElement = messageElement.find('.mes_text');

                // Получение HTML-содержимого и замена тегов на переносы строк
                let renderedText = messageTextElement.html()
                    .replace(/<br\s*\/?>/gi, '\n')
                    .replace(/<\/p>\s*<p>/gi, '\n\n')

                // Декодирование HTML-сущностей
                const tempDiv = document.createElement('div');
                tempDiv.innerHTML = renderedText;
                renderedText = tempDiv.textContent;

                console.log(`[Telegram Bridge] Захвачен финальный текст, отправка обновления для chatId: ${lastProcessedChatId}`);

                // Определение режима (потоковый или нет)
                if (isStreamingMode) {
                    // Потоковый режим - отправка final_message_update
                    ws.send(JSON.stringify({
                        type: 'final_message_update',
                        chatId: lastProcessedChatId,
                        text: renderedText,
                        enableTranslation: getSettings().enableTranslation // Добавляем флаг перевода
                    }));
                    // Сброс флага потокового режима
                    isStreamingMode = false;
                } else {
                    // Непотоковый режим - отправка ai_reply
                    ws.send(JSON.stringify({
                        type: 'ai_reply',
                        chatId: lastProcessedChatId,
                        text: renderedText,
                        enableTranslation: getSettings().enableTranslation // Добавляем флаг перевода
                    }));
                }

                // Сброс chatId для предотвращения ошибочных обновлений
                lastProcessedChatId = null;
            }
        }
    }, 100);
}

// Глобальные слушатели событий
eventSource.on(event_types.GENERATION_ENDED, handleFinalMessage);
eventSource.on(event_types.GENERATION_STOPPED, handleFinalMessage);