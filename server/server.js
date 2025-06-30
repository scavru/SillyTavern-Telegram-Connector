// server.js
const TelegramBot = require('node-telegram-bot-api');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

// 检查配置文件是否存在
const configPath = path.join(__dirname, './config.js');
if (!fs.existsSync(configPath)) {
    console.error('错误: 找不到配置文件 config.js！');
    console.error('请在server目录下复制 config.example.js 为 config.js，并设置您的Telegram Bot Token');
    process.exit(1); // 终止程序
}

const config = require('./config');

// --- 配置 ---
// 从配置文件中获取Telegram Bot Token和WebSocket端口
const token = config.telegramToken;
// WebSocket服务器端口
const wssPort = config.wssPort;

// 检查是否修改了默认token
if (token === 'TOKEN' || token === 'YOUR_TELEGRAM_BOT_TOKEN_HERE') {
    console.error('错误: 请先在config.js文件中设置你的Telegram Bot Token！');
    console.error('找到 telegramToken: \'YOUR_TELEGRAM_BOT_TOKEN_HERE\' 这一行并替换为你从BotFather获取的token');
    process.exit(1); // 终止程序
}

// 初始化Telegram Bot
const bot = new TelegramBot(token, { polling: true });
console.log('Telegram Bot已启动...');

// 初始化WebSocket服务器
const wss = new WebSocket.Server({ port: wssPort });
console.log(`WebSocket服务器正在监听端口 ${wssPort}...`);

let sillyTavernClient = null; // 用于存储连接的SillyTavern扩展客户端

// 系统命令处理函数
function handleSystemCommand(command, chatId) {
    console.log(`执行系统命令: ${command}`);

    switch (command) {
        case 'reload':
            // 重载服务器端组件
            console.log('正在重载服务器端组件...');
            reloadServer(chatId);
            break;

        case 'restart':
            // 重启服务器端组件
            console.log('正在重启服务器端组件...');
            restartServer(chatId);
            break;

        case 'exit':
            // 退出服务器端组件
            console.log('正在退出服务器端组件...');
            exitServer(chatId);
            break;

        default:
            console.warn(`未知的系统命令: ${command}`);
            if (chatId) {
                bot.sendMessage(chatId, `未知的系统命令: /${command}`);
            }
    }
}

// 重载服务器函数
function reloadServer(chatId) {
    // 在这里执行重载逻辑
    console.log('重载服务器端组件...');

    // 清除require缓存，这样可以重新加载模块
    Object.keys(require.cache).forEach(function (key) {
        if (key.indexOf('node_modules') === -1) { // 不清除node_modules中的模块
            delete require.cache[key];
        }
    });

    // 特别确保配置文件被重新加载
    try {
        // 清除配置文件的缓存
        delete require.cache[require.resolve('./config.js')];

        // 重新加载配置文件
        const newConfig = require('./config.js');

        // 更新配置
        Object.assign(config, newConfig);

        console.log('配置文件已重新加载');
    } catch (error) {
        console.error('重新加载配置文件时出错:', error);
        if (chatId) {
            bot.sendMessage(chatId, '重新加载配置文件时出错: ' + error.message);
        }
        return;
    }

    console.log('服务器端组件已重载');

    // 发送操作完成通知
    if (chatId) {
        bot.sendMessage(chatId, '服务器端组件已成功重载，配置文件已更新');
    }
}

// 重启服务器函数
function restartServer(chatId) {
    console.log('重启服务器端组件...');

    // 如果有chatId，先发送一条消息
    if (chatId) {
        bot.sendMessage(chatId, '正在重启服务器端组件，请稍候...');
    }

    // 关闭当前的WebSocket连接
    if (wss) {
        wss.close(() => {
            console.log('WebSocket服务器已关闭，准备重启...');

            // 使用setTimeout确保WebSocket完全关闭后再重启
            setTimeout(() => {
                // 使用child_process在新进程中重启服务器
                const { spawn } = require('child_process');
                const serverPath = path.join(__dirname, 'server.js');

                console.log(`重启服务器: ${serverPath}`);

                // 将chatId作为环境变量传递给新进程
                const env = Object.assign({}, process.env);
                if (chatId) {
                    env.RESTART_NOTIFY_CHATID = chatId.toString();
                }

                const child = spawn(process.execPath, [serverPath], {
                    detached: true,
                    stdio: 'inherit',
                    env: env
                });

                child.unref();
                process.exit(0); // 退出当前进程
            }, 1000);
        });
    }
}

// 退出服务器函数
function exitServer(chatId) {
    console.log('正在关闭服务器...');

    // 如果有chatId，先发送一条消息
    if (chatId) {
        bot.sendMessage(chatId, '正在关闭服务器端组件...');
    }

    // 关闭WebSocket服务器
    if (wss) {
        wss.close(() => {
            console.log('WebSocket服务器已关闭');

            // 停止Telegram Bot
            bot.stopPolling().then(() => {
                console.log('Telegram Bot已停止');

                // 发送最终通知（如果可能）
                if (chatId) {
                    bot.sendMessage(chatId, '服务器端组件已成功关闭')
                        .finally(() => {
                            console.log('服务器端组件已成功关闭');
                            process.exit(0);
                        });
                } else {
                    console.log('服务器端组件已成功关闭');
                    process.exit(0);
                }
            });
        });
    } else {
        // 如果WebSocket服务器不存在，直接退出
        if (chatId) {
            bot.sendMessage(chatId, '服务器端组件已成功关闭')
                .finally(() => process.exit(0));
        } else {
            process.exit(0);
        }
    }
}

wss.on('connection', ws => {
    console.log('SillyTavern扩展已连接！');
    sillyTavernClient = ws;

    ws.on('message', message => {
        // 从SillyTavern扩展收到的消息 (AI的回复)
        try {
            const data = JSON.parse(message);
            if (data.type === 'ai_reply' && data.chatId) {
                console.log(`收到AI回复，准备发送至Telegram用户 ${data.chatId}`);
                bot.sendMessage(data.chatId, data.text);
            } else if (data.type === 'system_command' && data.command) {
                // 处理系统命令
                handleSystemCommand(data.command, data.chatId);
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

// 检查是否需要发送重启完成通知
if (process.env.RESTART_NOTIFY_CHATID) {
    const chatId = parseInt(process.env.RESTART_NOTIFY_CHATID);
    if (!isNaN(chatId)) {
        // 等待一小段时间确保bot已经准备好
        setTimeout(() => {
            bot.sendMessage(chatId, '服务器端组件已成功重启并准备就绪')
                .catch(err => console.error('发送重启通知失败:', err));
        }, 2000);
    }
}

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

            payload = JSON.stringify({
                type: 'command_request',
                chatId: chatId,
                command: command,
                args: args
            });
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