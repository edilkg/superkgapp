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
    const courierData = couriers[ctx.from.id];
    if (courierData) {
        ctx.reply(`👤 Профиль Курьера:\nИмя: ${ctx.from.first_name}\nID: ${ctx.from.id}\n💰 Баланс: ${courierData.balance} сом\n📊 Доставок: ${courierData.dailyOrders}`);
    } else {
        ctx.reply(`👤 Ваш профиль:\nИмя: ${ctx.from.first_name}\nID: ${ctx.from.id}\nСтатус: Клиент`);
    }
});

// === ПРИЕМ ЗАКАЗА С САЙТА ===
app.post('/web-data', async (req, res) => {
    const { queryId, user, products, totalPrice, address } = req.body;
    
    const orderId = `ORD-${orderCounter++}`;
    
    // 💡 ВАЖНО: Запоминаем ID клиента (user.id), чтобы потом присылать ему статусы!
    activeOrders[orderId] = {
        id: orderId,
        status: 'pending',
        address: address || "Адрес не указан",
        price: totalPrice,
        clientId: user?.id // <--- Сохранили ID клиента
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
                        message_text: `✅ ЗАКАЗ ОФОРМЛЕН!\nНомер: <b>${orderId}</b>\n📍 Адрес: ${address}\n💰 Сумма: ${totalPrice}\n\n<i>Мы сообщим, когда курьер возьмет заказ!</i>`,
                        parse_mode: 'HTML'
                    }
                });
            } catch (err) {
                console.log("⚠️ Не удалось закрыть WebApp (тест с ПК):", err.message);
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
        }

        return res.status(200).json({ success: true });
    } catch (e) {
        console.error("🔴 Ошибка при обработке заказа:", e.message);
        return res.status(500).json({ error: e.message });
    }
});

// === ЛОГИКА РАБОТЫ КУРЬЕРА (И УВЕДОМЛЕНИЯ КЛИЕНТУ) ===

// 1. Курьер нажал "Принять"
bot.action(/accept_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    const courierId = ctx.from.id;
    const courierName = ctx.from.first_name;
    const order = activeOrders[orderId];

    if (!order || order.status !== 'pending') {
        return ctx.answerCbQuery("Заказ уже забрали или отменен!", { show_alert: true });
    }

    if (!couriers[courierId]) {
        couriers[courierId] = { name: courierName, balance: 1000, dailyOrders: 0 };
    }

    order.status = 'accepted';
    order.courierId = courierId;

    await ctx.editMessageText(`✅ Заказ ${orderId} забрал(а) курьер ${courierName}`);
    
    await ctx.telegram.sendMessage(courierId, `📦 Заказ ${orderId} твой!\n📍 Едь в ресторан.`, {
        reply_markup: {
            inline_keyboard: [[{ text: "📍 Я на месте (у ресторана)", callback_data: `arrive_${orderId}` }]]
        }
    });

    // 🔔 УВЕДОМЛЯЕМ КЛИЕНТА
    if (order.clientId) {
        await ctx.telegram.sendMessage(order.clientId, `🚴 <b>Ваш заказ ${orderId} передан курьеру!</b>\nКурьер (${courierName}) уже направляется в ресторан.`, { parse_mode: 'HTML' });
    }

    ctx.answerCbQuery();
});

// 2. Курьер нажал "На месте"
bot.action(/arrive_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    const order = activeOrders[orderId];

    await ctx.editMessageText(`📍 Заказ ${orderId}:\nОжидай выдачи блюд в ресторане.`, {
        reply_markup: {
            inline_keyboard: [[{ text: "🛍 Забрал заказ", callback_data: `pickup_${orderId}` }]]
        }
    });

    // 🔔 УВЕДОМЛЯЕМ КЛИЕНТА
    if (order && order.clientId) {
        await ctx.telegram.sendMessage(order.clientId, `⏳ Курьер прибыл в ресторан и ожидает выдачи вашего заказа.`);
    }

    ctx.answerCbQuery();
});

// 3. Курьер нажал "Забрал"
bot.action(/pickup_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    const order = activeOrders[orderId];
    const address = order ? order.address : "Адрес неизвестен";

    await ctx.editMessageText(`🛍 Заказ ${orderId} у тебя!\n📍 Вези по адресу: ${address}`, {
        reply_markup: {
            inline_keyboard: [[{ text: "✅ ДОСТАВИЛ (Завершить)", callback_data: `deliver_${orderId}` }]]
        }
    });

    // 🔔 УВЕДОМЛЯЕМ КЛИЕНТА
    if (order && order.clientId) {
        await ctx.telegram.sendMessage(order.clientId, `🚀 <b>Курьер забрал ваш заказ!</b>\nОн уже в пути и скоро будет у вас по адресу: ${address}.`, { parse_mode: 'HTML' });
    }

    ctx.answerCbQuery();
});

// 4. Курьер нажал "Доставил"
bot.action(/deliver_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    const courierId = ctx.from.id;