// index.js

// 导入SillyTavern的上下文和核心函数
const {
    getContext,
    getApiUrl, // 虽然此项目不用API，但这是个好习惯
    extensionSettings,
    saveSettingsDebounced,
} = SillyTavern.getContext();

// 我们需要从更深层级导入生成函数
// 警告：这种直接导入方式可能在SillyTavern更新后失效，但目前是最高效的方式
import {
    generateQuietPrompt,
    eventSource,
    event_types,
    saveChatDebounced,
    getPastCharacterChats // <-- 从TopInfoBar学到的，用于获取聊天列表
} from "../../../../script.js";

const MODULE_NAME = 'SillyTavern-Telegram-Connector';
const DEFAULT_SETTINGS = {
    bridgeUrl: 'ws://127.0.0.1:2333',
};

let ws = null; // WebSocket实例

// 获取或初始化设置
function getSettings() {
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = { ...DEFAULT_SETTINGS };
    }
    return extensionSettings[MODULE_NAME];
}

// 更新连接状态显示
function updateStatus(message, color) {
    const statusEl = document.getElementById('telegram_connection_status');
    if (statusEl) {
        statusEl.textContent = `状态： ${message}`;
        statusEl.style.color = color;
    }
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
        try {
            const data = JSON.parse(event.data);
            const context = SillyTavern.getContext();

            if (data.type === 'user_message') {
                // ... (普通聊天逻辑，保持不变) ...
                console.log('Telegram Bridge: 收到用户消息。', data);

                const userMessage = { name: 'You', is_user: true, is_name: true, send_date: Date.now(), mes: data.text };
                context.chat.push(userMessage);
                eventSource.emit(event_types.CHAT_CHANGED, context.chat);
                console.log('Telegram Bridge: 添加用户消息。正在生成回复...');

                const aiReplyText = await generateQuietPrompt(null, false);

                const characterName = context.characters[context.characterId].name;
                const aiMessage = { name: characterName, is_user: false, is_name: true, send_date: Date.now(), mes: aiReplyText };
                context.chat.push(aiMessage);
                eventSource.emit(event_types.CHAT_CHANGED, context.chat);
                console.log(`Telegram Bridge: 为 "${characterName}" 添加AI回复。`);

                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ type: 'ai_reply', chatId: data.chatId, text: aiReplyText }));
                }
                saveChatDebounced();
                return;
            }

            if (data.type === 'command_request') {
                console.log('Telegram Bridge: 处理命令。', data);
                let replyText = `未知命令: /${data.command}。 使用 /help 查看所有命令。`; // 更新了未知命令的提示
                const { executeSlashCommandsWithOptions, openCharacterChat } = context;

                switch (data.command) {
                    // --- 新增的 /help 命令 ---
                    case 'help':
                        replyText = `SillyTavern Telegram Bridge 命令：\n\n`;
                        replyText += `聊天管理\n`;
                        replyText += `  /new - 开始与当前角色的新聊天。\n`;
                        replyText += `  /listchats - 列出当前角色的所有已保存的聊天记录。\n`;
                        replyText += `  /switchchat <chat_name> - 加载特定的聊天记录。\n\n`;
                        replyText += `角色管理\n`;
                        replyText += `  /listchars - 列出所有可用角色。\n`;
                        replyText += `  /switchchar <char_name> - 切换到不同的角色。\n\n`;
                        replyText += `帮助\n`;
                        replyText += `  /help - 显示此帮助信息。`;
                        break;
                    // --- 现有命令保持不变 ---
                    case 'new':
                        await executeSlashCommandsWithOptions('/newchat');
                        replyText = '新的聊天已经开始。';
                        break;

                    case 'listchars': {
                        const characters = context.characters.slice(1);
                        replyText = '可用角色列表：\n\n' + characters.map(c => `- ${c.name}`).join('\n');
                        break;
                    }

                    case 'switchchar': {
                        if (data.args.length === 0) {
                            replyText = '请提供角色名称。用法: /switchchar <角色名称>';
                            break;
                        }
                        const targetName = data.args.join(' ');
                        const result = await executeSlashCommandsWithOptions(`/char "${targetName}"`);

                        if (result && typeof result === 'string') {
                            replyText = result;
                        } else {
                            replyText = `已尝试切换到角色 "${targetName}"。`;
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
                            replyText = '当前角色的聊天记录：\n\n' + chatFiles.map(f => `- ${f.file_name.replace('.jsonl', '')}`).join('\n');
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
                }

                // 将命令执行结果回复给用户
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
    // 调试信息，确认代码块被执行
    console.log('正在尝试加载 Telegram Connector 设置 UI...');

    // 加载设置UI (已修正URL路径)
    try {
        const settingsHtml = await $.get(`/scripts/extensions/third-party/${MODULE_NAME}/settings.html`);
        $('#extensions_settings').append(settingsHtml);
        console.log('Telegram Connector 设置 UI 应该已经被添加。');

        const settings = getSettings();
        $('#telegram_bridge_url').val(settings.bridgeUrl);

        // 绑定事件
        $('#telegram_bridge_url').on('input', () => {
            settings.bridgeUrl = $('#telegram_bridge_url').val();
            saveSettingsDebounced();
        });

        $('#telegram_connect_button').on('click', connect);
        $('#telegram_disconnect_button').on('click', disconnect);

    } catch (error) {
        console.error('加载 Telegram Connector 设置 HTML 失败。', error);
        // 在这里可以添加一些用户友好的错误提示到UI上
    }

    console.log('Telegram Connector 扩展已加载。');
});