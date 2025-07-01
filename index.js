// index.js

// 【修改】: 只从 getContext() 解构出稳定且已确认存在的函数和对象
const {
    extensionSettings,
    saveSettingsDebounced,
} = SillyTavern.getContext();

// 【修改】: 将 getPastCharacterChats 添加到直接导入列表
import {
    generateQuietPrompt,
    saveChatDebounced,
    eventSource,
    event_types,
    getPastCharacterChats, // <-- 从这里导入
} from "../../../../script.js";

const MODULE_NAME = 'SillyTavern-Telegram-Connector';
const DEFAULT_SETTINGS = {
    bridgeUrl: 'ws://127.0.0.1:2333',
    autoConnect: true,
};

let ws = null; // WebSocket实例

// ... (getSettings, updateStatus, reloadPage 函数保持不变) ...

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
            let context = SillyTavern.getContext();

            if (data.type === 'user_message') {
                console.log('Telegram Bridge: 收到用户消息。', data);

                const userMessage = {
                    name: 'You',
                    is_user: true,
                    is_name: true,
                    send_date: Date.now(),
                    mes: data.text
                };
                context.chat.push(userMessage);
                SillyTavern.getContext().addOneMessage(userMessage);

                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'typing_action', chatId: data.chatId }));
                }

                const aiReplyText = await generateQuietPrompt(data.text, false, false);

                if (aiReplyText) {
                    context = SillyTavern.getContext();
                    const characterName = context.characters[context.characterId].name;
                    const aiMessage = {
                        name: characterName,
                        is_user: false,
                        is_name: true,
                        send_date: Date.now(),
                        mes: aiReplyText
                    };
                    context.chat.push(aiMessage);
                    SillyTavern.getContext().addOneMessage(aiMessage);

                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'ai_reply', chatId: data.chatId, text: aiReplyText }));
                    }

                    saveChatDebounced();
                } else {
                    console.error("Telegram Bridge: AI回复为空，不发送。");
                }
                return;
            }

            if (data.type === 'system_command') {
                console.log('Telegram Bridge: 收到系统命令', data);
                if (data.command === 'reload_ui_only') {
                    console.log('Telegram Bridge: 正在刷新UI...');
                    setTimeout(reloadPage, 500);
                }
                return;
            }

            if (data.type === 'command_request') {
                console.log('Telegram Bridge: 处理命令。', data);

                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'typing_action', chatId: data.chatId }));
                }

                let replyText = `未知命令: /${data.command}。 使用 /help 查看所有命令。`;
                const { executeSlashCommandsWithOptions, openCharacterChat } = SillyTavern.getContext();

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
                        await executeSlashCommandsWithOptions('/newchat');
                        replyText = '新的聊天已经开始。';
                        break;
                    case 'listchars': {
                        const characters = SillyTavern.getContext().characters.slice(1);
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
                        await executeSlashCommandsWithOptions(`/char "${targetName}"`);

                        await new Promise(resolve => setTimeout(resolve, 200));
                        const newContext = SillyTavern.getContext();
                        const currentCharacter = newContext.characters[newContext.characterId];
                        if (currentCharacter && currentCharacter.name === targetName) {
                            replyText = `已成功切换到角色 "${targetName}"。`;
                        } else {
                            replyText = `已发送切换到角色 "${targetName}" 的命令。`;
                        }
                        break;
                    }
                    case 'listchats': {
                        // 【修改】: 直接调用导入的 getPastCharacterChats
                        const currentContext = SillyTavern.getContext();
                        if (currentContext.characterId === undefined) {
                            replyText = '请先选择一个角色。';
                            break;
                        }
                        const chatFiles = await getPastCharacterChats(currentContext.characterId);
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
                            replyText = `已加载聊天记录： ${data.args.join(' ')}`;
                        } catch (err) {
                            console.error(err);
                            replyText = `加载聊天记录 "${data.args.join(' ')}" 失败。请确认名称完全正确。`;
                        }
                        break;
                    }
                    default: {
                        const charMatch = data.command.match(/^switchchar_(\d+)$/);
                        if (charMatch) {
                            const index = parseInt(charMatch[1]) - 1;
                            const characters = SillyTavern.getContext().characters.slice(1);
                            if (index >= 0 && index < characters.length) {
                                const targetChar = characters[index];
                                await executeSlashCommandsWithOptions(`/char "${targetChar.name}"`);

                                await new Promise(resolve => setTimeout(resolve, 200));
                                const newContext = SillyTavern.getContext();
                                const currentCharacter = newContext.characters[newContext.characterId];

                                if (currentCharacter && currentCharacter.name === targetChar.name) {
                                    replyText = `已切换到角色 "${targetChar.name}"。`;
                                } else {
                                    replyText = `尝试切换到角色 "${targetChar.name}" 失败。`;
                                }
                            } else {
                                replyText = `无效的角色序号: ${index + 1}。请使用 /listchars 查看可用角色。`;
                            }
                            break;
                        }

                        const chatMatch = data.command.match(/^switchchat_(\d+)$/);
                        if (chatMatch) {
                            const currentContext = SillyTavern.getContext();
                            if (currentContext.characterId === undefined) {
                                replyText = '请先选择一个角色。';
                                break;
                            }
                            const index = parseInt(chatMatch[1]) - 1;
                            // 【修改】: 直接调用导入的 getPastCharacterChats
                            const chatFiles = await getPastCharacterChats(currentContext.characterId);

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
                ws.send(JSON.stringify({ type: 'ai_reply', chatId: data.chatId, text: '处理您的请求时发生了一个内部错误。' }));
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
            settings.bridgeUrl = $('#telegram_bridge_url').val();
            saveSettingsDebounced();
        });

        $('#telegram_auto_connect').on('change', function () {
            settings.autoConnect = $(this).prop('checked');
            saveSettingsDebounced();
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