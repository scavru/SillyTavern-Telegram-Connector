// index.js

// 只解构 getContext() 返回的对象中确实存在的属性
const {
    extensionSettings,
    deleteLastMessage, // 导入删除最后一条消息的函数
} = SillyTavern.getContext();

// getContext 函数是全局 SillyTavern 对象的一部分，我们不需要从别处导入它
// 在需要时直接调用 SillyTavern.getContext() 即可

// 从 script.js 导入所有需要的公共API函数
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
};

let ws = null; // WebSocket实例
let lastProcessedChatId = null; // 用于存储最后处理过的Telegram chatId

// --- 工具函数 ---
function getSettings() {
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = { ...DEFAULT_SETTINGS };
    }
    return extensionSettings[MODULE_NAME];
}

function updateStatus(message, color) {
    const statusEl = document.getElementById('telegram_connection_status');
    if (statusEl) {
        statusEl.textContent = `状态： ${message}`;
        statusEl.style.color = color;
    }
}

function reloadPage() {
    window.location.reload();
}
// ---

// 连接到WebSocket服务器
function connect() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        console.log('Telegram Bridge: 已连接');
        return;
    }

    const settings = getSettings();
    if (!settings.bridgeUrl) {
        updateStatus('Telegram Bridge URL 未设置！', 'red');
        return;
    }

    updateStatus('连接中...', 'orange');
    console.log(`Telegram Bridge: 正在连接 ${settings.bridgeUrl}...`);

    ws = new WebSocket(settings.bridgeUrl);

    ws.onopen = () => {
        console.log('Telegram Bridge: 连接成功！');
        updateStatus('已连接', 'green');
    };

    ws.onmessage = async (event) => {
        let data;
        try {
            data = JSON.parse(event.data);

            // --- 用户消息处理（流式版本） ---
            if (data.type === 'user_message') {
                console.log('Telegram Bridge: 收到用户消息。', data);

                // 存储当前处理的chatId
                lastProcessedChatId = data.chatId;

                // 1. 立即向Telegram发送“输入中”状态（无论是否流式）
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'typing_action', chatId: data.chatId }));
                }

                // 2. 将用户消息添加到SillyTavern
                await sendMessageAsUser(data.text);

                // 3. 设置流式传输的回调
                const streamCallback = (cumulativeText) => {
                    // 将每个文本块通过WebSocket发送到服务端
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'stream_chunk',
                            chatId: data.chatId,
                            text: cumulativeText,
                        }));
                    }
                };
                eventSource.on(event_types.STREAM_TOKEN_RECEIVED, streamCallback);

                // 4. 定义一个清理函数
                const cleanup = () => {
                    eventSource.removeListener(event_types.STREAM_TOKEN_RECEIVED, streamCallback);
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        // 仅在没有错误的情况下发送stream_end
                        if (!data.error) {
                            ws.send(JSON.stringify({ type: 'stream_end', chatId: data.chatId }));
                        }
                    }
                };

                // 5. 监听生成结束事件，确保无论成功与否都执行清理
                // 注意: 我们现在使用once来确保这个监听器只执行一次，避免干扰后续的全局监听器
                eventSource.once(event_types.GENERATION_ENDED, cleanup);

                // 6. 触发SillyTavern的生成流程，并用try...catch包裹
                try {
                    const abortController = new AbortController();
                    setExternalAbortController(abortController);
                    await Generate('normal', { signal: abortController.signal });
                } catch (error) {
                    console.error("SillyTavern Generate() 错误:", error);

                    // a. 从SillyTavern聊天记录中删除导致错误的用户消息
                    await deleteLastMessage();
                    console.log('Telegram Bridge: 已删除导致错误的用户消息。');

                    // b. 准备并发送错误信息到服务端
                    const errorMessage = `抱歉，AI生成回复时遇到错误。\n您的上一条消息已被撤回，请重试或发送不同内容。\n\n错误详情: ${error.message || '未知错误'}`;
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'error_message',
                            chatId: data.chatId,
                            text: errorMessage,
                        }));
                    }

                    // c. 标记错误以便cleanup函数知道
                    data.error = true;
                    cleanup(); // 确保清理监听器
                }

                return;
            }

            // --- 系统命令处理 ---
            if (data.type === 'system_command') {
                console.log('Telegram Bridge: 收到系统命令', data);
                if (data.command === 'reload_ui_only') {
                    console.log('Telegram Bridge: 正在刷新UI...');
                    setTimeout(reloadPage, 500);
                }
                return;
            }

            // --- Telegram命令请求处理 ---
            if (data.type === 'command_request') {
                console.log('Telegram Bridge: 处理命令。', data);

                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'typing_action', chatId: data.chatId }));
                }

                let replyText = `未知命令: /${data.command}。 使用 /help 查看所有命令。`;

                // 直接调用全局的 SillyTavern.getContext()
                const context = SillyTavern.getContext();

                switch (data.command) {
                    case 'help':
                        replyText = `SillyTavern Telegram Bridge 命令：\n\n`;
                        replyText += `聊天管理\n`;
                        replyText += `/new - 开始与当前角色的新聊天。\n`;
                        replyText += `/listchats - 列出当前角色的所有已保存的聊天记录。\n`;
                        replyText += `/switchchat <chat_name> - 加载特定的聊天记录。\n`;
                        replyText += `/switchchat_<序号> - 通过序号加载聊天记录。\n\n`;
                        replyText += `角色管理\n`;
                        replyText += `/listchars - 列出所有可用角色。\n`;
                        replyText += `/switchchar <char_name> - 切换到指定角色。\n`;
                        replyText += `/switchchar_<序号> - 通过序号切换角色。\n\n`;
                        replyText += `系统管理\n`;
                        replyText += `/reload - 重载插件的服务器端组件并刷新ST网页。\n`;
                        replyText += `/restart - 刷新ST网页并重启插件的服务器端组件。\n`;
                        replyText += `/exit - 退出插件的服务器端组件。\n\n`;
                        replyText += `帮助\n`;
                        replyText += `/help - 显示此帮助信息。`;
                        break;
                    case 'new':
                        await doNewChat({ deleteCurrentChat: false });
                        replyText = '新的聊天已经开始。';
                        break;
                    case 'listchars': {
                        const characters = context.characters.slice(1);
                        if (characters.length > 0) {
                            replyText = '可用角色列表：\n\n';
                            characters.forEach((char, index) => {
                                replyText += `${index + 1}. /switchchar_${index + 1} - ${char.name}\n`;
                            });
                            replyText += '\n使用 /switchchar_数字 或 /switchchar 角色名称 来切换角色';
                        } else {
                            replyText = '没有找到可用角色。';
                        }
                        break;
                    }
                    case 'switchchar': {
                        if (data.args.length === 0) {
                            replyText = '请提供角色名称或序号。用法: /switchchar <角色名称> 或 /switchchar_数字';
                            break;
                        }
                        const targetName = data.args.join(' ');
                        const characters = context.characters;
                        const targetChar = characters.find(c => c.name === targetName);

                        if (targetChar) {
                            const charIndex = characters.indexOf(targetChar);
                            await selectCharacterById(charIndex);
                            replyText = `已成功切换到角色 "${targetName}"。`;
                        } else {
                            replyText = `角色 "${targetName}" 未找到。`;
                        }
                        break;
                    }
                    case 'listchats': {
                        if (context.characterId === undefined) {
                            replyText = '请先选择一个角色。';
                            break;
                        }
                        const chatFiles = await getPastCharacterChats(context.characterId);
                        if (chatFiles.length > 0) {
                            replyText = '当前角色的聊天记录：\n\n';
                            chatFiles.forEach((chat, index) => {
                                const chatName = chat.file_name.replace('.jsonl', '');
                                replyText += `${index + 1}. /switchchat_${index + 1} - ${chatName}\n`;
                            });
                            replyText += '\n使用 /switchchat_数字 或 /switchchat 聊天名称 来切换聊天';
                        } else {
                            replyText = '当前角色没有任何聊天记录。';
                        }
                        break;
                    }
                    case 'switchchat': {
                        if (data.args.length === 0) {
                            replyText = '请提供聊天记录名称。用法： /switchchat <聊天记录名称>';
                            break;
                        }
                        const targetChatFile = `${data.args.join(' ')}`;
                        try {
                            await openCharacterChat(targetChatFile);
                            replyText = `已加载聊天记录： ${targetChatFile}`;
                        } catch (err) {
                            console.error(err);
                            replyText = `加载聊天记录 "${targetChatFile}" 失败。请确认名称完全正确。`;
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
                                replyText = `已切换到角色 "${targetChar.name}"。`;
                            } else {
                                replyText = `无效的角色序号: ${index + 1}。请使用 /listchars 查看可用角色。`;
                            }
                            break;
                        }

                        const chatMatch = data.command.match(/^switchchat_(\d+)$/);
                        if (chatMatch) {
                            if (context.characterId === undefined) {
                                replyText = '请先选择一个角色。';
                                break;
                            }
                            const index = parseInt(chatMatch[1]) - 1;
                            const chatFiles = await getPastCharacterChats(context.characterId);

                            if (index >= 0 && index < chatFiles.length) {
                                const targetChat = chatFiles[index];
                                const chatName = targetChat.file_name.replace('.jsonl', '');
                                try {
                                    await openCharacterChat(chatName);
                                    replyText = `已加载聊天记录： ${chatName}`;
                                } catch (err) {
                                    console.error(err);
                                    replyText = `加载聊天记录失败。`;
                                }
                            } else {
                                replyText = `无效的聊天记录序号: ${index + 1}。请使用 /listchats 查看可用聊天记录。`;
                            }
                            break;
                        }
                    }
                }

                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'ai_reply', chatId: data.chatId, text: replyText }));
                }
            }
        } catch (error) {
            console.error('Telegram Bridge: 处理请求时发生错误：', error);
            if (data && data.chatId && ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'error_message', chatId: data.chatId, text: '处理您的请求时发生了一个内部错误。' }));
            }
        }
    };

    ws.onclose = () => {
        console.log('Telegram Bridge: 连接已关闭。');
        updateStatus('连接已断开', 'red');
        ws = null;
    };

    ws.onerror = (error) => {
        console.error('Telegram Bridge: WebSocket 错误：', error);
        updateStatus('连接错误', 'red');
        ws = null;
    };
}

function disconnect() {
    if (ws) {
        ws.close();
    }
}

// 扩展加载时执行的函数
jQuery(async () => {
    console.log('正在尝试加载 Telegram Connector 设置 UI...');
    try {
        const settingsHtml = await $.get(`/scripts/extensions/third-party/${MODULE_NAME}/settings.html`);
        $('#extensions_settings').append(settingsHtml);
        console.log('Telegram Connector 设置 UI 应该已经被添加。');

        const settings = getSettings();
        $('#telegram_bridge_url').val(settings.bridgeUrl);
        $('#telegram_auto_connect').prop('checked', settings.autoConnect);

        $('#telegram_bridge_url').on('input', () => {
            const settings = getSettings();
            settings.bridgeUrl = $('#telegram_bridge_url').val();
            // SillyTavern的saveSettingsDebounced将自动处理保存操作
        });

        $('#telegram_auto_connect').on('change', function () {
            const settings = getSettings();
            settings.autoConnect = $(this).prop('checked');
            // SillyTavern的saveSettingsDebounced将自动处理保存操作
        });

        $('#telegram_connect_button').on('click', connect);
        $('#telegram_disconnect_button').on('click', disconnect);

        if (settings.autoConnect) {
            console.log('Telegram Bridge: 自动连接已启用，正在连接...');
            connect();
        }

    } catch (error) {
        console.error('加载 Telegram Connector 设置 HTML 失败。', error);
    }
    console.log('Telegram Connector 扩展已加载。');
});

// 全局事件监听器，用于最终消息更新
eventSource.on(event_types.GENERATION_ENDED, (lastMessageIdInChatArray) => {
    // 确保WebSocket已连接，并且我们有一个有效的chatId来发送更新
    if (!ws || ws.readyState !== WebSocket.OPEN || !lastProcessedChatId) {
        return;
    }

    const lastMessageIndex = lastMessageIdInChatArray - 1;
    if (lastMessageIndex < 0) return;

    // 延迟以确保DOM更新完成
    setTimeout(() => {
        // 直接调用全局的 SillyTavern.getContext()
        const context = SillyTavern.getContext();
        const lastMessage = context.chat[lastMessageIndex];

        // 确认这是我们刚刚通过Telegram触发的AI回复
        if (lastMessage && !lastMessage.is_user && !lastMessage.is_system) {
            const messageElement = $(`#chat .mes[mesid="${lastMessageIndex}"]`);

            if (messageElement.length > 0) {
                // 使用 .html() 而不是 .text() 来保留换行等格式
                const renderedText = messageElement.find('.mes_text').text();

                console.log(`Telegram Bridge: 捕获到最终渲染文本，准备发送更新到 chatId: ${lastProcessedChatId}`);

                ws.send(JSON.stringify({
                    type: 'final_message_update',
                    chatId: lastProcessedChatId,
                    text: renderedText,
                }));

                // 重置chatId，避免意外更新其他用户的消息
                lastProcessedChatId = null;
            }
        }
    }, 100);
});