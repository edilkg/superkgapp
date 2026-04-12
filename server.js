require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const bot = new Telegraf(process.env.BOT_TOKEN);
const WEBAPP_URL = 'https://superkgapp.vercel.app';

bot.start((ctx) => {
    ctx.reply(
        `Привет! 👋\nВыбери нужный раздел:`,
        Markup.inlineKeyboard([
            [Markup.button.webApp('🍕 ЗАКАЗАТЬ ЕДУ (ONLINE)', WEBAPP_URL)],
            [Markup.button.webApp('🚀 ОФОРМИТЬ ДОСТАВКУ', `${WEBAPP_URL}/taxi.html`)],
            [Markup.button.callback('👤 МОЙ ПРОФИЛЬ', 'user_profile')],
            [Markup.button.callback('📞 КОНТАКТЫ И ПОДДЕРЖКА', 'our_contacts')]
        ])
    );
});

bot.action('our_contacts', (ctx) => {
    ctx.reply('📞 Наш телефон: +996 (XXX) XX-XX-XX\n📍 Адрес: г. Бишкек');
});

bot.action('user_profile', (ctx) => {
    ctx.reply(`👤 Профиль пользователя:\nИмя: ${ctx.from.first_name}\nID: ${ctx.from.id}`);
});

app.post('/web-data', async (req, res) => {
    const { queryId, products, totalPrice, address } = req.body;
    try {
        if (queryId) {
            await bot.answerWebAppQuery(queryId, {
                type: 'article',
                id: queryId,
                title: 'Заказ принят',
                input_message_content: {
                    message_text: `✅ ЗАКАЗ ОФОРМЛЕН!\n📍 Адрес: ${address}\n💰 Сумма: ${totalPrice} сом`,
                    parse_mode: 'HTML'
                }
            });
        }
        return res.status(200).json({ success: true });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Сервер на порту ${PORT}`));
bot.launch();