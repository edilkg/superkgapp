require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const bot = new Telegraf(process.env.BOT_TOKEN);
const WEBAPP_URL = 'https://superkgapp.vercel.app';

// Главное меню с правильными кнопками (как в Икеда)
bot.start((ctx) => {
    ctx.reply(
        `Привет, ${ctx.from.first_name}! 👋\nМы рады видеть тебя здесь. 🍕🚕\n\nПожалуйста, выбери один из пунктов:`,
        {
            ...Markup.inlineKeyboard([
                [Markup.button.webApp('Заказать еду 🍔', WEBAPP_URL)],
                [Markup.button.webApp('Оформить доставку 🚀', `${WEBAPP_URL}/taxi.html`)],
                [Markup.button.callback('Профиль 👤', 'user_profile')],
                [Markup.button.callback('Наши контакты 📞', 'our_contacts')]
            ]),
            ...Markup.removeKeyboard() // Это навсегда удалит серые кнопки снизу
        }
    );
});

// Обработчики кнопок
bot.action('our_contacts', (ctx) => {
    ctx.reply('📞 Наш телефон: +996 (XXX) XX-XX-XX\n📍 Адрес: г. Бишкек');
});

bot.action('user_profile', (ctx) => {
    ctx.reply(`👤 Ваш профиль:\nИмя: ${ctx.from.first_name}\nID: ${ctx.from.id}\nСтатус: Клиент`);
});

// Прием заказов
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