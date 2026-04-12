require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Инициализация двух ботов
const bot = new Telegraf(process.env.BOT_TOKEN); // Клиентский
const courierBot = new Telegraf(process.env.COURIER_BOT_TOKEN); // Курьерский

// === НАСТРОЙКИ ===
const ADMIN_ID = process.env.ADMIN_CHAT_ID; // Твой ID
const DELIVERY_FEE = 150;
const COMMISSION = 20;

// База данных в оперативной памяти (после перезагрузки Render обнуляется)
let couriers = {}; 
let activeOrders = {}; 
let orderCounter = 1;

const WEBAPP_URL = 'https://superkgapp.vercel.app';

// ==========================================
// 1. КЛИЕНТСКИЙ БОТ (bot)
// ==========================================
bot.start((ctx) => {
    ctx.reply(`Привет, ${ctx.from.first_name}! 👋\nЗаказывайте еду в ТамакKG:`,
        Markup.inlineKeyboard([[Markup.button.webApp('🍕 ОТКРЫТЬ МЕНЮ', WEBAPP_URL)]]));
});

// ПРИЕМ ЗАКАЗА ИЗ WEB APP
app.post('/web-data', async (req, res) => {
    const { user, address, restaurantName, totalPrice, comment } = req.body;
    const orderId = orderCounter++;
    
    activeOrders[orderId] = { id: orderId, clientId: user?.id, address, restaurantName, totalPrice, comment, status: 'pending' };

    // Рассылка всем курьерам, кто ОДОБРЕН и НА ЛИНИИ
    let couriersNotified = 0;
    for (let id in couriers) {
        if (couriers[id].status === 'online' && couriers[id].isApproved) {
            try {
                await courierBot.telegram.sendMessage(id, 
                    `🔥 *НОВЫЙ ЗАКАЗ #${orderId}*\n🏬 Из: ${restaurantName}\n📍 Куда: ${address}\n💰 Доход: ${DELIVERY_FEE} сом\n💬: ${comment || 'нет'}`,
                    {
                        parse_mode: 'Markdown',
                        ...Markup.inlineKeyboard([[Markup.button.callback('🤝 ПРИНЯТЬ', `accept_${orderId}`)]])
                    }
                );
                couriersNotified++;
            } catch (e) { console.log("Ошибка отправки курьеру:", id); }
        }
    }
    console.log(`Заказ #${orderId} создан. Оповещено курьеров: ${couriersNotified}`);
    res.sendStatus(200);
});

// ==========================================
// 2. КУРЬЕРСКИЙ БОТ (courierBot)
// ==========================================

const getCourierMenu = (id) => {
    const c = couriers[id];
    if (!c || !c.isApproved) return Markup.keyboard([['⏳ Ожидание одобрения...']]).resize();
    const statusBtn = c.status === 'online' ? '🔴 Уйти с линии' : '🟢 Выйти на линию';
    return Markup.keyboard([[statusBtn], ['📊 Инфо', '💳 Баланс'], ['🎧 Поддержка']]).resize();
};

courierBot.start(async (ctx) => {
    const id = ctx.from.id;
    if (!couriers[id]) {
        couriers[id] = { id, step: 'name', balance: 0, dailyOrders: 0, status: 'offline', isApproved: false };
        return ctx.reply("Заявка на курьера.\nВведите ваше Имя и Фамилию:");
    }
    ctx.reply("Рабочее меню:", getCourierMenu(id));
});

courierBot.on('text', async (ctx) => {
    const id = ctx.from.id;
    const c = couriers[id];
    if (!c) return;

    if (c.step === 'name') {
        c.name = ctx.message.text;
        c.step = 'phone';
        return ctx.reply("Теперь введите ваш номер телефона:");
    }
    if (c.step === 'phone') {
        c.phone = ctx.message.text;
        c.step = 'idle';
        ctx.reply("✅ Данные отправлены! Ожидайте одобрения админом.");
        if(ADMIN_ID) bot.telegram.sendMessage(ADMIN_ID, `🆕 *НОВЫЙ КУРЬЕР:*\n👤 ${c.name}\n📱 ${c.phone}\n🆔 \`${id}\``, 
            { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('✅ ОДОБРИТЬ', `approve_${id}`)]]) });
        return;
    }

    if (!c.isApproved) return ctx.reply("⏳ Ваш аккаунт еще не одобрен.");

    switch (ctx.message.text) {
        case '🟢 Выйти на линию': c.status = 'online'; ctx.reply("📡 Вы на линии!", getCourierMenu(id)); break;
        case '🔴 Уйти с линии': c.status = 'offline'; ctx.reply("😴 Отдыхаете", getCourierMenu(id)); break;
        case '📊 Инфо': ctx.reply(`📊 Статистика:\nДоставок сегодня: ${c.dailyOrders}\nБаланс: ${c.balance} сом`); break;
        case '💳 Баланс': ctx.reply(`Ваш баланс: ${c.balance} сом. Пополнение через @tamak_admin`); break;
    }
});

// --- CALLBACK ACTIONS (КНОПКИ) ---

// Админ одобряет курьера
bot.action(/approve_(.+)/, async (ctx) => {
    const id = ctx.match[1];
    if(couriers[id]) {
        couriers[id].isApproved = true;
        await ctx.editMessageText(`✅ Курьер ${couriers[id].name} одобрен!`);
        await courierBot.telegram.sendMessage(id, "🎉 Поздравляем! Вы одобрены. Выходите на линию!", getCourierMenu(id));
    }
});

// Курьер берет заказ
courierBot.action(/accept_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    const order = activeOrders[orderId];
    if(!order || order.status !== 'pending') return ctx.answerCbQuery("Заказ уже забрали!");
    
    order.status = 'accepted';
    order.courierId = ctx.from.id;

    await ctx.editMessageText(`✅ Вы приняли заказ #${orderId}\n🏬 Ресторан: ${order.restaurantName}\n📍 Куда: ${order.address}`, 
        Markup.inlineKeyboard([[Markup.button.callback('📍 Я НА МЕСТЕ', `arrive_${orderId}`)]]));
});

courierBot.action(/arrive_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    await ctx.editMessageText(`📍 Вы у ресторана. Получите заказ и нажмите кнопку:`, 
        Markup.inlineKeyboard([[Markup.button.callback('🛍️ ЗАБРАЛ ЗАКАЗ', `pickup_${orderId}`)]]));
});

courierBot.action(/pickup_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    const order = activeOrders[orderId];
    await ctx.editMessageText(`🛵 Везите заказ по адресу:\n📍 ${order.address}\n\nНажмите по прибытии:`, 
        Markup.inlineKeyboard([[Markup.button.callback('🏁 ДОСТАВИЛ', `deliver_${orderId}`)]]));
});

courierBot.action(/deliver_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    const order = activeOrders[orderId];
    const id = ctx.from.id;

    if (couriers[id]) {
        couriers[id].dailyOrders++;
        couriers[id].balance -= COMMISSION;
    }

    await ctx.editMessageText(`✅ Заказ #${orderId} завершен!\n💰 Заработок: +${DELIVERY_FEE} сом (в корзину)\n📉 Комиссия: -${COMMISSION} сом (с баланса)`);
    
    if(order && order.clientId) {
        bot.telegram.sendMessage(order.clientId, "🌟 Ваш заказ доставлен! Приятного аппетита!");
    }
    delete activeOrders[orderId];
});

// --- ЗАПУСК ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Back-end started on port ${PORT}`));

bot.launch();
courierBot.launch();

process.once('SIGINT', () => { bot.stop('SIGINT'); courierBot.stop('SIGINT'); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); courierBot.stop('SIGTERM'); });