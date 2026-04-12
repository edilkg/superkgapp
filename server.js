require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const cors = require('cors');

// --- 1. НАСТРОЙКА ВЕБ-СЕРВЕРА ---
const app = express();
app.use(cors());
app.use(express.json());

// --- 2. НАСТРОЙКА ТГ БОТА ---
const bot = new Telegraf(process.env.BOT_TOKEN);

// Ссылка на твой фронтенд (Vercel)
const WEBAPP_URL = 'https://superkgapp.vercel.app';

// Приветствие при команде /start
bot.start((ctx) => {
    ctx.reply(
        `Привет! 👋\nВыбери пункт меню:`,
        {
            ...Markup.inlineKeyboard([
                [Markup.button.webApp('Заказать еду 🍔', WEBAPP_URL)],
                [Markup.button.webApp('Оформить доставку 🚀', `${WEBAPP_URL}/taxi.html`)],
                [Markup.button.callback('Профиль 👤', 'user_profile')],
                [Markup.button.callback('Наши контакты 📞', 'our_contacts')]
            ]),
            ...Markup.removeKeyboard() // Это уберет нижнюю синюю/серую кнопку "Open"
        }
    );
});

// Обработка контактов
bot.action('our_contacts', (ctx) => {
    ctx.reply('📞 Наш телефон: +996 (XXX) XX-XX-XX\n📍 Адрес: г. Бишкек, ул. Примерная 10');
});

// Обработка профиля
bot.action('user_profile', (ctx) => {
    ctx.reply(`👤 Ваш профиль:\nИмя: ${ctx.from.first_name}\nID: ${ctx.from.id}\nСтатус: Пользователь`);
});

// Маршрут для приема заказов из index.html
app.post('/web-data', async (req, res) => {
    const { queryId, products, totalPrice, comment, address } = req.body;
    
    try {
        if (!queryId) {
            console.log('Заказ получен вне Telegram (тестовый режим)');
            return res.status(200).json({ success: true });
        }

        await bot.answerWebAppQuery(queryId, {
            type: 'article',
            id: queryId,
            title: 'Успешная оплата',
            input_message_content: {
                message_text: `✅ <b>Новый заказ!</b>\n\n📍 Адрес: ${address}\n💬 Комментарий: ${comment}\n💰 Сумма: ${totalPrice} сом\n\nСкоро с вами свяжется оператор!`,
                parse_mode: 'HTML'
            }
        });
        return res.status(200).json({ success: true });
    } catch (e) {
        console.error('Ошибка в Telegram API:', e);
        return res.status(500).json({ error: e.message });
    }
});

// --- 3. ЗАПУСК ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Сервер запущен на порту ${PORT}`));

bot.launch().then(() => console.log('🤖 Бот успешно подключен к Telegram!'));

// Плавная остановка
process.once('SIGINT', () => bot.stop('SIGINT'));
process.