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
import { generateQuietPrompt } from "../../../../script.js";

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
                // 获取官方推荐的SillyTavern上下文
                const context = SillyTavern.getContext();

                // 1. 创建用户消息对象
                const userMessage = {
                    name: context.getWho('user'), // 通过context获取用户名
                    is_user: true,
                    is_name: true,
                    send_date: Date.now(),
                    mes: data.text,
                };

                // 2. 将用户消息添加到聊天记录
                context.chat.push(userMessage);

                // 3. 更新UI和内部状态（非常重要！）
                // context.updateChat() 是更新聊天记录的官方推荐方式
                context.updateChat(context.chat);
                console.log('Telegram Bridge: Added user message to chat. Now generating reply...');

                // 4. 触发AI生成回复
                // 我们再次使用 generateQuietPrompt。
                // 关键点：我们传递一个空字符串 "" 或者 null 作为第一个参数。
                // 当 prompt 为空时，它会默认使用聊天记录的末尾作为上下文来生成回复。
                // 这就达到了我们想要的效果：基于刚刚添加的用户消息进行回复。
                const aiReply = await generateQuietPrompt(null, false);

                // 5. 将回复发送回桥接服务器
                if (ws && ws.readyState === WebSocket.OPEN) {
                    const payload = JSON.stringify({
                        type: 'ai_reply',
                        chatId: data.chatId,
                        text: aiReply,
                    });
                    ws.send(payload);
                    console.log('Telegram Bridge: Sent AI reply back to bridge server.');

                    // 6. (推荐) 保存聊天记录
                    context.saveChatDebounced();
                }
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