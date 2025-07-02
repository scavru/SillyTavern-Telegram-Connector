// config.example.js
// Telegram Bot配置示例
// 使用方法: 复制此文件为config.js，然后修改下面的配置

module.exports = {
    // 替换成你自己的Telegram Bot Token
    telegramToken: 'YOUR_TELEGRAM_BOT_TOKEN_HERE',

    // WebSocket服务器端口
    wssPort: 2333,

    // 允许与机器人交互的Telegram用户ID白名单
    // 将你自己的Telegram User ID（以及其他你允许的用户的ID）添加到一个数组中。
    // 你可以通过与Telegram上的 @userinfobot 聊天来获取你的ID。
    // 如果留空数组 `[]`，则表示允许所有用户访问。
    // 示例: [123456789, 987654321]
    allowedUserIds: []
};