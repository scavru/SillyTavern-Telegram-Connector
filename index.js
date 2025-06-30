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

const MODULE_NAME = 'telegram-connector';
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
                // 核心：收到用户消息，开始生成回复
                // generateQuietPrompt 会在后台运行，不会在UI上显示"..."
                // 它会使用当前所有的上下文、角色、格式等设置
                const aiReply = await generateQuietPrompt(data.text, false);

                // 将回复发送回桥接服务器
                if (ws && ws.readyState === WebSocket.OPEN) {
                    const payload = JSON.stringify({
                        type: 'ai_reply',
                        chatId: data.chatId,
                        text: aiReply,
                    });
                    ws.send(payload);
                    console.log('Telegram Bridge: Sent AI reply back to bridge server.');
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
    // 加载设置UI
    const settingsHtml = await $.get(`/extensions/third-party/${MODULE_NAME}/settings.html`);
    $('#extensions_settings').append(settingsHtml);

    const settings = getSettings();
    $('#telegram_bridge_url').val(settings.bridgeUrl);

    // 绑定事件
    $('#telegram_bridge_url').on('input', () => {
        settings.bridgeUrl = $('#telegram_bridge_url').val();
        saveSettingsDebounced();
    });
    
    $('#telegram_connect_button').on('click', connect);
    $('#telegram_disconnect_button').on('click', disconnect);

    console.log('Telegram Connector extension loaded.');
});