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
    saveChatDebounced
} from "../../../../script.js";

const MODULE_NAME = 'st-telegram-connector';
const DEFAULT_SETTINGS = {
    bridgeUrl: 'ws://192.168.31.194:2333',
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
        statusEl.textContent = `Status: ${message}`;
        statusEl.style.color = color;
    }
}

// 连接到WebSocket服务器
function connect() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        console.log('Telegram Bridge: Already connected.');
        return;
    }

    const settings = getSettings();
    if (!settings.bridgeUrl) {
        updateStatus('Bridge URL is not set!', 'red');
        return;
    }

    updateStatus('Connecting...', 'orange');
    console.log(`Telegram Bridge: Connecting to ${settings.bridgeUrl}...`);

    ws = new WebSocket(settings.bridgeUrl);

    ws.onopen = () => {
        console.log('Telegram Bridge: Connection successful!');
        updateStatus('Connected', 'green');
    };

    ws.onmessage = async (event) => {
        try {
            const data = JSON.parse(event.data);
            console.log('Telegram Bridge: Received message from bridge server.', data);

            if (data.type === 'user_message') {
                const context = SillyTavern.getContext();

                // --- 步骤 1: 处理用户消息 ---
                const userMessage = {
                    name: 'You',
                    is_user: true,
                    is_name: true,
                    send_date: Date.now(),
                    mes: data.text,
                };
                context.chat.push(userMessage);
                eventSource.emit(event_types.CHAT_CHANGED, context.chat);
                console.log('Telegram Bridge: Added user message to chat. Generating reply...');

                // --- 步骤 2: 生成AI回复 ---
                const aiReplyText = await generateQuietPrompt(null, false);

                // --- 步骤 3: 处理AI回复 ---
                const characterName = context.characters[context.characterId].name;
                const aiMessage = {
                    name: characterName,
                    is_user: false,
                    is_name: true,
                    send_date: Date.now(),
                    mes: aiReplyText,
                };
                context.chat.push(aiMessage);
                eventSource.emit(event_types.CHAT_CHANGED, context.chat);
                console.log(`Telegram Bridge: Added AI reply from "${characterName}" to chat.`);

                // --- 步骤 4: 将AI回复发送到Telegram ---
                if (ws && ws.readyState === WebSocket.OPEN) {
                    const payload = JSON.stringify({
                        type: 'ai_reply',
                        chatId: data.chatId,
                        text: aiReplyText,
                    });
                    ws.send(payload);
                    console.log('Telegram Bridge: Sent AI reply to Telegram.');
                }

                // --- 步骤 5: 保存聊天记录 (这是新增的关键步骤！) ---
                saveChatDebounced();
                console.log('Telegram Bridge: Chat save triggered.');
            }
        } catch (error) {
            console.error('Telegram Bridge: Error processing message or generating reply:', error);
        }
    };

    ws.onclose = () => {
        console.log('Telegram Bridge: Connection closed.');
        updateStatus('Disconnected', 'red');
        ws = null;
    };

    ws.onerror = (error) => {
        console.error('Telegram Bridge: WebSocket error:', error);
        updateStatus('Connection Error', 'red');
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
    console.log('Attempting to load Telegram Connector settings UI...');

    // 加载设置UI (已修正URL路径)
    try {
        const settingsHtml = await $.get(`/scripts/extensions/third-party/${MODULE_NAME}/settings.html`);
        $('#extensions_settings').append(settingsHtml);
        console.log('Telegram Connector settings UI should now be appended.');

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
        console.error('Failed to load Telegram Connector settings HTML.', error);
        // 在这里可以添加一些用户友好的错误提示到UI上
    }

    console.log('Telegram Connector extension loaded.');
});