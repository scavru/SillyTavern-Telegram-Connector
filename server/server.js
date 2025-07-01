// server.js
const TelegramBot = require('node-telegram-bot-api');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

// 重启保护 - 防止循环重启
const RESTART_PROTECTION_FILE = path.join(__dirname, '.restart_protection');
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60000; // 1分钟

// 检查是否可能处于循环重启状态
function checkRestartProtection() {
    try {
        if (fs.existsSync(RESTART_PROTECTION_FILE)) {
            const data = JSON.parse(fs.readFileSync(RESTART_PROTECTION_FILE, 'utf8'));
            const now = Date.now();

            // 清理过期的重启记录
            data.restarts = data.restarts.filter(time => now - time < RESTART_WINDOW_MS);

            // 添加当前重启时间
            data.restarts.push(now);

            // 如果在时间窗口内重启次数过多，则退出
            if (data.restarts.length > MAX_RESTARTS) {
                console.error(`检测到可能的循环重启！在${RESTART_WINDOW_MS / 1000}秒内重启了${data.restarts.length}次。`);
                console.error('为防止资源耗尽，服务器将退出。请手动检查并修复问题后再启动。');

                // 如果有通知chatId，尝试发送错误消息
                if (process.env.RESTART_NOTIFY_CHATID) {
                    const chatId = parseInt(process.env.RESTART_NOTIFY_CHATID);
                    if (!isNaN(chatId)) {
                        // 创建临时bot发送错误消息
                        try {
                            const tempBot = new TelegramBot(require('./config').telegramToken, { polling: false });
                            tempBot.sendMessage(chatId, '检测到循环重启！服务器已停止以防止资源耗尽。请手动检查问题。')
                                .finally(() => process.exit(1));
                        } catch (e) {
                            process.exit(1);
                        }
                        return; // 等待消息发送后退出
                    }
                }

                process.exit(1);
            }

            // 保存更新后的重启记录
            fs.writeFileSync(RESTART_PROTECTION_FILE, JSON.stringify(data));
        } else {
            // 创建新的重启保护文件
            fs.writeFileSync(RESTART_PROTECTION_FILE, JSON.stringify({
                restarts: [Date.now()]
            }));
        }
    } catch (error) {
        console.error('重启保护检查失败:', error);
        // 出错时继续执行，不要阻止服务器启动
    }
}

// 启动时检查重启保护
checkRestartProtection();

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

// 存储bot的用户名和ID
let botUsername = '';
let botId = null;

// 获取bot信息
bot.getMe().then(me => {
    botUsername = me.username;
    botId = me.id;
    console.log(`Bot信息: @${botUsername} (ID: ${botId})`);
}).catch(error => {
    console.error('获取Bot信息失败:', error);
});

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

                // 创建一个干净的环境变量对象，只包含必要的系统环境变量
                const cleanEnv = {
                    PATH: process.env.PATH,
                    NODE_PATH: process.env.NODE_PATH,
                    // 可以根据需要添加其他必要的系统环境变量
                };

                // 只添加chatId作为通知用途
                if (chatId) {
                    cleanEnv.RESTART_NOTIFY_CHATID = chatId.toString();
                }

                const child = spawn(process.execPath, [serverPath], {
                    detached: true,
                    stdio: 'inherit',
                    env: cleanEnv
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

    // 设置强制退出定时器，确保在任何情况下服务器都会退出
    const forceExitTimeout = setTimeout(() => {
        console.error('退出操作超时，强制退出进程');
        process.exit(1);
    }, 10000); // 10秒后强制退出

    // 清理重启保护文件
    try {
        if (fs.existsSync(RESTART_PROTECTION_FILE)) {
            fs.unlinkSync(RESTART_PROTECTION_FILE);
            console.log('已清理重启保护文件');
        }
    } catch (error) {
        console.error('清理重启保护文件失败:', error);
    }

    // 定义最终退出函数
    const finalExit = () => {
        clearTimeout(forceExitTimeout);
        console.log('服务器端组件已成功关闭');
        process.exit(0);
    };

    // 关闭WebSocket服务器
    if (wss) {
        try {
            wss.close((err) => {
                if (err) {
                    console.error('关闭WebSocket服务器时出错:', err);
                } else {
                    console.log('WebSocket服务器已关闭');
                }

                // 无论成功与否，继续尝试停止Telegram Bot
                try {
                    bot.stopPolling()
                        .then(() => {
                            console.log('Telegram Bot已停止');
                            // 不再发送最终通知，直接退出
                            finalExit();
                        })
                        .catch(err => {
                            console.error('停止Telegram Bot时出错:', err);
                            finalExit();
                        });
                } catch (botError) {
                    console.error('调用bot.stopPolling时出错:', botError);
                    finalExit();
                }
            });
        } catch (wssError) {
            console.error('调用wss.close时出错:', wssError);

            // WebSocket关闭失败，继续尝试停止Telegram Bot
            try {
                bot.stopPolling()
                    .finally(() => {
                        // 不再发送错误通知，直接退出
                        finalExit();
                    });
            } catch (e) {
                finalExit();
            }
        }
    } else {
        // 如果WebSocket服务器不存在，直接停止Telegram Bot
        try {
            bot.stopPolling()
                .then(() => {
                    console.log('Telegram Bot已停止');
                    // 不再发送最终通知，直接退出
                    finalExit();
                })
                .catch(err => {
                    console.error('停止Telegram Bot时出错:', err);
                    finalExit();
                });
        } catch (e) {
            console.error('调用bot.stopPolling时出错:', e);
            finalExit();
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
            } else if (data.type === 'typing_action' && data.chatId) {
                // 处理"输入中"状态
                console.log(`显示"输入中"状态给Telegram用户 ${data.chatId}`);
                bot.sendChatAction(data.chatId, 'typing')
                    .catch(error => console.error('发送"输入中"状态失败:', error));
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
                .catch(err => console.error('发送重启通知失败:', err))
                .finally(() => {
                    // 清除环境变量，防止重复触发重启
                    delete process.env.RESTART_NOTIFY_CHATID;
                    console.log('已清除重启通知环境变量，防止循环重启');
                });
        }, 2000);
    }
}

// 监听Telegram消息
bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (!text) return; // 忽略非文本消息

    // 检查是否被@提及
    const isBotMentioned = msg.entities && msg.entities.some(entity =>
        entity.type === 'mention' && text.substring(entity.offset, entity.offset + entity.length) === '@' + botUsername
    );

    // 检查消息是否是回复bot的消息
    const isReplyToBot = msg.reply_to_message && msg.reply_to_message.from && msg.reply_to_message.from.id === botId;

    // 检查是否是私聊消息
    const isPrivateChat = msg.chat.type === 'private';

    // 只处理以下情况的消息：
    // 1. 私聊消息
    // 2. 回复bot的消息
    // 3. @提及bot的消息
    // 4. 系统命令（以/开头）
    if (!isPrivateChat && !isReplyToBot && !isBotMentioned && !text.startsWith('/')) {
        return; // 忽略不满足条件的群聊消息
    }

    // 检查是否是系统命令
    if (text.startsWith('/')) {
        const parts = text.slice(1).trim().split(/\s+/); // 分割命令和参数
        const command = parts[0].toLowerCase();
        const args = parts.slice(1);

        // 直接处理系统命令
        if (command === 'reload' || command === 'restart' || command === 'exit') {
            console.log(`从Telegram用户 ${chatId} 收到系统命令: "${text}"`);

            // 先发送响应，然后再处理命令
            let responseMessage = '';
            switch (command) {
                case 'reload':
                    responseMessage = '正在重载服务器端组件...';
                    break;
                case 'restart':
                    responseMessage = '正在重启服务器端组件...';
                    break;
                case 'exit':
                    responseMessage = '正在关闭服务器端组件...';
                    break;
            }

            // 发送响应并等待发送完成后再执行命令
            bot.sendMessage(chatId, responseMessage)
                .then(() => {
                    console.log(`已向用户 ${chatId} 发送响应: "${responseMessage}"`);

                    // 如果是reload命令且ST连接正常，需要通知ST刷新页面
                    if (command === 'reload' && sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN) {
                        sillyTavernClient.send(JSON.stringify({
                            type: 'system_command',
                            command: 'reload_ui_only',
                            chatId: chatId
                        }));
                    }

                    // 延迟一小段时间再执行命令，确保消息已发送
                    setTimeout(() => {
                        // 直接在服务器端执行系统命令
                        handleSystemCommand(command, chatId);
                    }, 500);
                })
                .catch(error => {
                    console.error('发送响应消息失败:', error);
                    // 即使发送失败也执行命令
                    handleSystemCommand(command, chatId);
                });

            return; // 不再继续处理
        }
    }

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