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
            fs.writeFileSync(RESTART_PROTECTION_FILE, JSON.stringify({ restarts: [Date.now()] }));
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

// 初始化WebSocket服务器
const wss = new WebSocket.Server({ port: wssPort });
console.log(`WebSocket服务器正在监听端口 ${wssPort}...`);

let sillyTavernClient = null; // 用于存储连接的SillyTavern扩展客户端

// 用于存储正在进行的流式会话，调整会话结构，使用Promise来处理messageId
// 结构: { messagePromise: Promise<number> | null, lastText: String, timer: NodeJS.Timeout | null, isEditing: boolean }
const ongoingStreams = new Map();

// 重载服务器函数
function reloadServer(chatId) {
    console.log('重载服务器端组件...');
    Object.keys(require.cache).forEach(function (key) {
        if (key.indexOf('node_modules') === -1) {
            delete require.cache[key];
        }
    });
    try {
        delete require.cache[require.resolve('./config.js')];
        const newConfig = require('./config.js');
        Object.assign(config, newConfig);
        console.log('配置文件已重新加载');
    } catch (error) {
        console.error('重新加载配置文件时出错:', error);
        if (chatId) bot.sendMessage(chatId, '重新加载配置文件时出错: ' + error.message);
        return;
    }
    console.log('服务器端组件已重载');
    if (chatId) bot.sendMessage(chatId, '服务器端组件已成功重载。');
}

// 重启服务器函数
function restartServer(chatId) {
    console.log('重启服务器端组件...');
    if (wss) {
        wss.close(() => {
            console.log('WebSocket服务器已关闭，准备重启...');
            setTimeout(() => {
                const { spawn } = require('child_process');
                const serverPath = path.join(__dirname, 'server.js');
                console.log(`重启服务器: ${serverPath}`);
                const cleanEnv = { PATH: process.env.PATH, NODE_PATH: process.env.NODE_PATH };
                if (chatId) cleanEnv.RESTART_NOTIFY_CHATID = chatId.toString();
                const child = spawn(process.execPath, [serverPath], { detached: true, stdio: 'inherit', env: cleanEnv });
                child.unref();
                process.exit(0);
            }, 1000);
        });
    }
}

// 退出服务器函数
function exitServer() {
    console.log('正在关闭服务器...');
    const forceExitTimeout = setTimeout(() => {
        console.error('退出操作超时，强制退出进程');
        process.exit(1);
    }, 10000);
    try {
        if (fs.existsSync(RESTART_PROTECTION_FILE)) {
            fs.unlinkSync(RESTART_PROTECTION_FILE);
            console.log('已清理重启保护文件');
        }
    } catch (error) {
        console.error('清理重启保护文件失败:', error);
    }
    const finalExit = () => {
        clearTimeout(forceExitTimeout);
        console.log('服务器端组件已成功关闭');
        process.exit(0);
    };
    if (wss) {
        wss.close(() => {
            console.log('WebSocket服务器已关闭');
            bot.stopPolling().finally(finalExit);
        });
    } else {
        bot.stopPolling().finally(finalExit);
    }
}

function handleSystemCommand(command, chatId) {
    console.log(`执行系统命令: ${command}`);

    if (!sillyTavernClient || sillyTavernClient.readyState !== WebSocket.OPEN) {
        bot.sendMessage(chatId, `SillyTavern未连接，无法执行 ${command} 命令。`);
        return;
    }

    sillyTavernClient.commandToExecuteOnClose = { command, chatId };

    let responseMessage = '';
    switch (command) {
        case 'reload': responseMessage = '正在重载UI和服务器端组件...'; break;
        case 'restart': responseMessage = '正在重启服务器端组件... 请稍候。'; break;
        case 'exit': responseMessage = '正在关闭服务器端组件...'; break;
        default:
            console.warn(`未知的系统命令: ${command}`);
            bot.sendMessage(chatId, `未知的系统命令: /${command}`);
            delete sillyTavernClient.commandToExecuteOnClose;
            return;
    }

    bot.sendMessage(chatId, responseMessage);
    sillyTavernClient.send(JSON.stringify({ type: 'system_command', command: 'reload_ui_only', chatId }));
}

// --- WebSocket服务器逻辑 ---
wss.on('connection', ws => {
    console.log('SillyTavern扩展已连接！');
    sillyTavernClient = ws;

    ws.on('message', async (message) => { // 将整个回调设为async
        let data; // 在 try 块外部声明 data
        try {
            data = JSON.parse(message);

            // --- 处理流式文本块 ---
            if (data.type === 'stream_chunk' && data.chatId) {
                let session = ongoingStreams.get(data.chatId);

                // 1. 如果会话不存在，立即同步创建一个占位会话，创建会话和messagePromise
                if (!session) {
                    // 使用let声明，以便在Promise内部访问
                    let resolveMessagePromise;
                    const messagePromise = new Promise(resolve => {
                        resolveMessagePromise = resolve;
                    });

                    session = {
                        messagePromise: messagePromise,
                        lastText: data.text,
                        timer: null,
                        isEditing: false, // 新增状态锁
                    };
                    ongoingStreams.set(data.chatId, session);

                    // 异步发送第一条消息并更新 session
                    bot.sendMessage(data.chatId, '正在思考...')
                        .then(sentMessage => {
                            // 当消息发送成功时，解析Promise并传入messageId
                            resolveMessagePromise(sentMessage.message_id);
                        }).catch(err => {
                            console.error('发送初始Telegram消息失败:', err);
                            ongoingStreams.delete(data.chatId); // 出错时清理
                        });
                } else {
                    // 2. 如果会话存在，只更新最新文本
                    session.lastText = data.text;
                }

                // 3. 尝试触发一次编辑（节流保护）
                // 确保 messageId 已经获取到，并且当前没有正在进行的编辑或定时器
                // 使用 await messagePromise 来确保messageId可用
                const messageId = await session.messagePromise;

                if (messageId && !session.isEditing && !session.timer) {
                    session.timer = setTimeout(async () => { // 定时器回调也设为async
                        const currentSession = ongoingStreams.get(data.chatId);
                        if (currentSession) {
                            const currentMessageId = await currentSession.messagePromise;
                            if (currentMessageId) {
                                currentSession.isEditing = true;
                                bot.editMessageText(currentSession.lastText + ' ...', {
                                    chat_id: data.chatId,
                                    message_id: currentMessageId,
                                }).catch(err => {
                                    if (!err.message.includes('message is not modified')) console.error('编辑Telegram消息失败:', err.message);
                                }).finally(() => {
                                    if (ongoingStreams.has(data.chatId)) ongoingStreams.get(data.chatId).isEditing = false;
                                });
                            }
                            currentSession.timer = null;
                        }
                    }, 2000);
                }
                return;
            }

            // --- 处理流式结束信号 ---
            if (data.type === 'stream_end' && data.chatId) {
                const session = ongoingStreams.get(data.chatId);
                if (session) {
                    if (session.timer) {
                        clearTimeout(session.timer);
                        session.timer = null;
                    }
                    // 使用 await messagePromise
                    const messageId = await session.messagePromise;
                    if (messageId && session.lastText && session.lastText.trim() !== '') {
                        await bot.editMessageText(session.lastText, {
                            chat_id: data.chatId,
                            message_id: messageId,
                        }).catch(err => {
                            if (!err.message.includes('message is not modified')) console.error('编辑最终Telegram消息失败:', err.message);
                        });
                    }
                }
                console.log(`Telegram Bridge: ChatID ${data.chatId} 的流式传输准最终更新已发送。`);
                return;
            }

            // --- 处理最终渲染后的消息更新 ---
            if (data.type === 'final_message_update' && data.chatId) {
                const session = ongoingStreams.get(data.chatId);

                // 如果会话存在，说明是流式传输的最终更新
                if (session) {
                    // 使用 await messagePromise
                    const messageId = await session.messagePromise;
                    if (messageId) {
                        console.log(`Telegram Bridge: 收到流式最终渲染文本，更新消息 ${messageId}`);
                        await bot.editMessageText(data.text, {
                            chat_id: data.chatId,
                            message_id: messageId,
                            // 可选：在这里指定 parse_mode: 'MarkdownV2' 或 'HTML'
                            // parse_mode: 'HTML',
                        }).catch(err => {
                            if (!err.message.includes('message is not modified')) console.error('编辑最终格式化Telegram消息失败:', err.message);
                        });
                    } else {
                        console.warn(`Telegram Bridge: 收到final_message_update，但流式会话的messageId未能获取。`);
                    }
                    // 清理流式会话
                    ongoingStreams.delete(data.chatId);
                    console.log(`Telegram Bridge: ChatID ${data.chatId} 的流式会话已完成并清理。`);
                }
                // 如果会话不存在，说明这是一个完整的非流式回复
                else {
                    console.log(`Telegram Bridge: 收到非流式完整回复，直接发送新消息到 ChatID ${data.chatId}`);
                    await bot.sendMessage(data.chatId, data.text, {
                        // 可选：在这里指定 parse_mode
                    }).catch(err => {
                        console.error('发送非流式完整回复失败:', err.message);
                    });
                }
                return;
            }

            // --- 其他消息处理逻辑 ---
            if (data.type === 'error_message' && data.chatId) {
                console.error(`收到SillyTavern的错误报告，将发送至Telegram用户 ${data.chatId}: ${data.text}`);
                bot.sendMessage(data.chatId, data.text);
            } else if (data.type === 'ai_reply' && data.chatId) {
                console.log(`收到非流式AI回复，发送至Telegram用户 ${data.chatId}`);
                bot.sendMessage(data.chatId, data.text);
            } else if (data.type === 'typing_action' && data.chatId) {
                console.log(`显示"输入中"状态给Telegram用户 ${data.chatId}`);
                bot.sendChatAction(data.chatId, 'typing').catch(error => console.error('发送"输入中"状态失败:', error));
            }
        } catch (error) {
            console.error('处理SillyTavern消息时出错:', error);
            // 确保即使在解析JSON失败时也能清理
            if (data && data.chatId) {
                ongoingStreams.delete(data.chatId);
            }
        }
    });

    ws.on('close', () => {
        console.log('SillyTavern扩展已断开连接。');
        if (ws.commandToExecuteOnClose) {
            const { command, chatId } = ws.commandToExecuteOnClose;
            console.log(`客户端断开连接，现在执行预定命令: ${command}`);
            if (command === 'reload') reloadServer(chatId);
            if (command === 'restart') restartServer(chatId);
            if (command === 'exit') exitServer(chatId);
        }
        sillyTavernClient = null;
        ongoingStreams.clear();
    });

    ws.on('error', (error) => {
        console.error('WebSocket发生错误:', error);
        if (sillyTavernClient) {
            sillyTavernClient.commandToExecuteOnClose = null; // 清除标记，防止意外执行
        }
        sillyTavernClient = null;
        ongoingStreams.clear();
    });
});

// 检查是否需要发送重启完成通知
if (process.env.RESTART_NOTIFY_CHATID) {
    const chatId = parseInt(process.env.RESTART_NOTIFY_CHATID);
    if (!isNaN(chatId)) {
        setTimeout(() => {
            bot.sendMessage(chatId, '服务器端组件已成功重启并准备就绪')
                .catch(err => console.error('发送重启通知失败:', err))
                .finally(() => {
                    delete process.env.RESTART_NOTIFY_CHATID;
                });
        }, 2000);
    }
}

// 监听Telegram消息
bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    const userId = msg.from.id;
    const username = msg.from.username || 'N/A';

    // 检查白名单是否已配置且不为空
    if (config.allowedUserIds && config.allowedUserIds.length > 0) {
        // 如果当前用户的ID不在白名单中
        if (!config.allowedUserIds.includes(userId)) {
            console.log(`拒绝了来自非白名单用户的访问：\n  - User ID: ${userId}\n  - Username: @${username}\n  - Chat ID: ${chatId}\n  - Message: "${text}"`);
            // 向该用户发送一条拒绝消息
            bot.sendMessage(chatId, '抱歉，您无权使用此机器人。').catch(err => {
                console.error(`向 ${chatId} 发送拒绝消息失败:`, err.message);
            });
            // 终止后续处理
            return;
        }
    }

    if (!text) return;

    if (text.startsWith('/')) {
        const parts = text.slice(1).trim().split(/\s+/);
        const command = parts[0].toLowerCase();

        if (['reload', 'restart', 'exit'].includes(command)) {
            handleSystemCommand(command, chatId);
            return;
        }
    }

    if (sillyTavernClient && sillyTavernClient.readyState === WebSocket.OPEN) {
        let payload;
        if (text.startsWith('/')) {
            console.log(`从Telegram用户 ${chatId} 收到命令: "${text}"`);
            const parts = text.slice(1).trim().split(/\s+/);
            const command = parts[0].toLowerCase();
            const args = parts.slice(1);
            payload = JSON.stringify({ type: 'command_request', chatId, command, args });
        } else {
            console.log(`从Telegram用户 ${chatId} 收到消息: "${text}"`);
            payload = JSON.stringify({ type: 'user_message', chatId, text });
        }
        sillyTavernClient.send(payload);
    } else {
        console.warn('收到Telegram消息，但SillyTavern扩展未连接。');
        bot.sendMessage(chatId, '抱歉，我现在无法连接到SillyTavern。请确保SillyTavern已打开并启用了Telegram扩展。');
    }
});