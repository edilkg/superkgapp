require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const bot = new Telegraf(process.env.BOT_TOKEN);

// === ПАМЯТЬ ДЛЯ КУРЬЕРОВ И ЗАКАЗОВ ===
let couriers = {}; 
let activeOrders = {}; 
let orderCounter = 1; 

const DELIVERY_FEE = 150; 
const COMMISSION_RATE = 0.10; 
// =====================================

const WEBAPP_URL = 'https://superkgapp.vercel.app';

// Главное меню
bot.start((ctx) => {
    ctx.reply(
        `Привет, ${ctx.from.first_name}! 👋\nМы рады видеть тебя здесь. 🍕🚕\n\nПожалуйста, выбери один из пунктов:`,
        Markup.inlineKeyboard([
            [Markup.button.webApp('🍕 ЗАКАЗАТЬ ЕДУ (ONLINE)', WEBAPP_URL)],
            [Markup.button.webApp('🚀 ОФОРМИТЬ ДОСТАВКУ', `${WEBAPP_URL}/taxi.html`)],
            [Markup.button.callback('👤 МОЙ ПРОФИЛЬ', 'user_profile')],
            [Markup.button.callback('📞 КОНТАКТЫ', 'our_contacts')]
        ])
    );
});

// Обработчики кнопок меню
bot.action('our_contacts', (ctx) => {
    ctx.reply('📞 Наш телефон: +996 (XXX) XX-XX-XX\n📍 Адрес: г. Бишкек');
});

bot.action('user_profile', (ctx) => {
    // Если это курьер, покажем его баланс, если клиент - обычный профиль
    const courierData = couriers[ctx.from.id];
    if (courierData) {
        ctx.reply(`👤 Профиль Курьера:\nИмя: ${ctx.from.first_name}\nID: ${ctx.from.id}\n💰 Баланс: ${courierData.balance} сом\n📊 Доставок: ${courierData.dailyOrders}`);
    } else {
        ctx.reply(`👤 Ваш профиль:\nИмя: ${ctx.from.first_name}\nID: ${ctx.from.id}\nСтатус: Клиент`);
    }
});

// === ПРИЕМ ЗАКАЗА С САЙТА (БРОНЕБОЙНАЯ ВЕРСИЯ) ===
app.post('/web-data', async (req, res) => {
    const { queryId, user, products, totalPrice, address } = req.body;
    
    // Создаем заказ в памяти
    const orderId = `ORD-${orderCounter++}`;
    activeOrders[orderId] = {
        id: orderId,
        status: 'pending',
        address: address || "Адрес не указан",
        price: totalPrice
    };

    try {
        // 1. Отправляем чек КЛИЕНТУ
        if (queryId) {
            try {
                await bot.answerWebAppQuery(queryId, {
                    type: 'article',
                    id: queryId,
                    title: 'Заказ принят',
                    input_message_content: {
                        message_text: `✅ ЗАКАЗ ОФОРМЛЕН!\nНомер: <b>${orderId}</b>\n📍 Адрес: ${address}\n💰 Сумма: ${totalPrice}`,
                        parse_mode: 'HTML'
                    }
                });
            } catch (err) {
                console.log("⚠️ Не удалось закрыть WebApp (вероятно, тест с ПК):", err.message);
                // Ошибку игнорируем, чтобы сервер не падал и заказ шел дальше курьеру
            }
        }

        // 2. Отправляем сообщение КУРЬЕРАМ
        const targetChatId = process.env.ADMIN_CHAT_ID || (user && user.id); 

        if (targetChatId) {
            const text = `🔥 *НОВЫЙ ЗАКАЗ ${orderId}*\n📍 Куда: ${address}\n💰 Сумма: ${totalPrice}`;
            await bot.telegram.sendMessage(targetChatId, text, {
                parse_mode: 'Markdown',
                reply_markup: {
                    inline_keyboard: [
                        [{ text: "📦 Принять заказ (150 сом)", callback_data: `accept_${orderId}` }]
                    ]
                }
            });
        } else {
            console.log("❌ ОШИБКА: Нет ID для отправки сообщения курьеру.");
        }

        return res.status(200).json({ success: true });
    } catch (e) {
        console.error("🔴 КРИТИЧЕСКАЯ Ошибка при обработке заказа:", e.message);
        return res.status(500).json({ error: e.message });
    }
});

// === ЛОГИКА РАБОТЫ КУРЬЕРА (КНОПКИ) ===

// 1. Курьер нажал "Принять"
bot.action(/accept_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    const courierId = ctx.from.id;
    const courierName = ctx.from.first_name;

    if (!activeOrders[orderId] || activeOrders[orderId].status !== 'pending') {
        return ctx.answerCbQuery("Заказ уже забрали или отменен!", { show_alert: true });
    }

    // Регистрация курьера (даем 1000 сом на старте)
    if (!couriers[courierId]) {
        couriers[courierId] = { name: courierName, balance: 1000, dailyOrders: 0 };
    }

    activeOrders[orderId].status = 'accepted';
    activeOrders[orderId].courierId = courierId;

    // Меняем кнопку в общей группе на текст
    await ctx.editMessageText(`✅ Заказ ${orderId} забрал(а) курьер ${courierName}`);
    
    // Отправляем личное сообщение курьеру с новой кнопкой
    await ctx.telegram.sendMessage(courierId, `📦 Заказ ${orderId} твой!\n📍 Едь в ресторан.`, {
        reply_markup: {
            inline_keyboard: [[{ text: "📍 Я на месте (у ресторана)", callback_data: `arrive_${orderId}` }]]
        }
    });
    ctx.answerCbQuery();
});

// 2. Курьер нажал "На месте"
bot.action(/arrive_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    await ctx.editMessageText(`📍 Заказ ${orderId}:\nОжидай выдачи блюд в ресторане.`, {
        reply_markup: {
            inline_keyboard: [[{ text: "🛍 Забрал заказ", callback_data: `pickup_${orderId}` }]]
        }
    });
    ctx.answerCbQuery();
});

// 3. Курьер нажал "Забрал"
bot.action(/pickup_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    const address = activeOrders[orderId] ? activeOrders[orderId].address : "Адрес неизвестен";
    await ctx.editMessageText(`🛍 Заказ ${orderId} у тебя!\n📍 Вези по адресу: ${address}`, {
        reply_markup: {
            inline_keyboard: [[{ text: "✅ ДОСТАВИЛ (Завершить)", callback_data: `deliver_${orderId}` }]]
        }
    });
    ctx.answerCbQuery();
});

// 4. Курьер нажал "Доставил"
bot.action(/deliver_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    const courierId = ctx.from.id;
    
    const commission = DELIVERY_FEE * COMMISSION_RATE; // 150 * 0.10 = 15
    
    if (couriers[courierId]) {
        couriers[courierId].balance -= commission;
        couriers[courierId].dailyOrders += 1;
    }

    await ctx.editMessageText(
        `🎉 *Заказ ${orderId} доставлен!*\n\n💸 Списана комиссия: ${commission} сом.\n💰 Твой баланс: ${couriers[courierId]?.balance} сом.\n📊 Доставок сегодня: ${couriers[courierId]?.dailyOrders}`, 
        { parse_mode: 'Markdown' }
    );
    
    delete activeOrders[orderId]; // Удаляем заказ из памяти
    ctx.answerCbQuery();
});

// ======================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Сервер работает на порту ${PORT}`));
bot.launch();

// Остановка бота при выключении сервера
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));