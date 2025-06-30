// server.js
const TelegramBot = require('node-telegram-bot-api');
const WebSocket = require('ws');

// --- 配置 ---
// 替换成你自己的Telegram Bot Token
const token = 'TOKEN';
// WebSocket服务器端口
const wssPort = 2333;

// 检查是否修改了默认token
if (token === 'TOKEN') {
    console.error('错误: 请先在server.js文件中设置你的Telegram Bot Token！');
    console.error('找到 const token = \'TOKEN\'; 这一行并替换为你从BotFather获取的token');
    process.exit(1); // 终止程序
}

// 初始化Telegram Bot
const bot = new TelegramBot(token, { polling: true });
console.log('Telegram Bot已启动...');

// 获取机器人信息
let botInfo = null;
bot.getMe().then(info => {
    botInfo = info;
    console.log(`机器人信息已获取: @${botInfo.username}`);
}).catch(error => {
    console.error('获取机器人信息失败:', error);
});

// 初始化WebSocket服务器
const wss = new WebSocket.Server({ port: wssPort });
console.log(`WebSocket服务器正在监听端口 ${wssPort}...`);

let sillyTavernClient = null; // 用于存储连接的SillyTavern扩展客户端

wss.on('connection', ws => {
    console.log('SillyTavern扩展已连接！');
    sillyTavernClient = ws;

    ws.on('message', message => {
        // 从SillyTavern扩展收到的消息 (AI的回复)
        try {
            const data = JSON.parse(message);
            if (data.type === 'ai_reply' && data.chatId) {
                console.log(`收到AI回复，准备发送至Telegram用户 ${data.chatId}`);
                // 使用parse_mode: 'HTML'以支持HTML格式的超链接
                bot.sendMessage(data.chatId, data.text, { parse_mode: 'HTML' });
            }
        } catch (error) {
            console.error('处理SillyTavern消息时出错:', error);
        }
    });

    ws.on('close', () => {
        console.log('SillyTavern扩展已断开连接。');
        sillyTavernClient = null;
    });

    ws.on('error', (error) => {
        console.error('WebSocket发生错误:', error);
        sillyTavernClient = null;
    });
});

// 监听Telegram消息
bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (!text) return; // 忽略非文本消息

    if (sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN) {
        let payload;
        if (text.startsWith('/')) {
            // --- 这是命令处理逻辑 ---
            console.log(`从Telegram用户 ${chatId} 收到命令: "${text}"`);
            const parts = text.slice(1).trim().split(/\s+/); // 分割命令和参数
            const command = parts[0].toLowerCase();
            const args = parts.slice(1);

            // 处理特殊的start命令，用于超链接点击
            if (command === 'start' && args.length > 0 && args[0].includes('_')) {
                const [actualCommand, ...paramParts] = args[0].split('_');
                const param = paramParts.join('_');
                
                if (actualCommand === 'switchchar' || actualCommand === 'switchchat') {
                    // 解码URI编码的参数
                    const decodedParam = decodeURIComponent(param);
                    console.log(`处理链接点击命令: /${actualCommand} ${decodedParam}`);
                    
                    payload = JSON.stringify({
                        type: 'command_request',
                        chatId: chatId,
                        command: actualCommand,
                        args: [decodedParam],
                        botUsername: botInfo ? botInfo.username : null
                    });
                } else {
                    // 处理普通的start命令
                    payload = JSON.stringify({
                        type: 'command_request',
                        chatId: chatId,
                        command: command,
                        args: args,
                        botUsername: botInfo ? botInfo.username : null
                    });
                }
            } else {
                // 处理普通命令
                payload = JSON.stringify({
                    type: 'command_request',
                    chatId: chatId,
                    command: command,
                    args: args,
                    botUsername: botInfo ? botInfo.username : null
                });
            }
        } else {
            // --- 这是普通消息处理逻辑 (保持不变) ---
            console.log(`从Telegram用户 ${chatId} 收到消息: "${text}"`);
            payload = JSON.stringify({
                type: 'user_message',
                chatId: chatId,
                text: text,
            });
        }
        sillyTavernClient.send(payload);
    } else {
        console.warn('收到Telegram消息，但SillyTavern扩展未连接。');
        bot.sendMessage(chatId, '抱歉，我现在无法连接到SillyTavern。请确保SillyTavern已打开并启用了Telegram扩展。');
    }
});