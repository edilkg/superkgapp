require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

console.log('--- ЗАПУСК СИСТЕМЫ ТАМАКKG ---');

// Проверка токенов
if (!process.env.BOT_TOKEN || !process.env.COURIER_BOT_TOKEN) {
    console.error('❌ ОШИБКА: Токены не найдены в .env!');
    process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);
const courierBot = new Telegraf(process.env.COURIER_BOT_TOKEN);

const ADMIN_ID = process.env.ADMIN_CHAT_ID; 
const DELIVERY_FEE = 150;
const COMMISSION = 20;

let couriers = {}; 
let activeOrders = {}; 
let orderCounter = 1;

const WEBAPP_URL = 'https://superkgapp.vercel.app';

// Меню курьера
const getCourierMenu = (id) => {
    const c = couriers[id];
    if (!c || !c.isApproved) return Markup.keyboard([['⏳ Ожидание одобрения...']]).resize();
    const statusBtn = c.status === 'online' ? '🔴 Уйти с линии' : '🟢 Выйти на линию';
    return Markup.keyboard([[statusBtn], ['📊 Инфо', '💳 Баланс'], ['🎧 Поддержка']]).resize();
};

// ==========================================
// 1. КЛИЕНТСКИЙ БОТ + АДМИНКА
// ==========================================

bot.start((ctx) => {
    ctx.reply(`Привет, ${ctx.from.first_name}! 👋\nЗаказывайте еду в ТамакKG:`,
        Markup.inlineKeyboard([[Markup.button.webApp('🍕 ОТКРЫТЬ МЕНЮ', WEBAPP_URL)]]));
});

// Прием заказа с фронтенда
app.post('/web-data', async (req, res) => {
    const { user, address, restaurantName, totalPrice, comment } = req.body;
    const orderId = orderCounter++;
    activeOrders[orderId] = { id: orderId, clientId: user?.id, address, restaurantName, totalPrice, comment, status: 'pending' };

    console.log(`📦 Новый заказ #${orderId}`);

    for (let id in couriers) {
        if (couriers[id].status === 'online' && couriers[id].isApproved) {
            try {
                await courierBot.telegram.sendMessage(id, 
                    `🔥 *НОВЫЙ ЗАКАЗ #${orderId}*\n🏬 Из: ${restaurantName}\n📍 Куда: ${address}\n💰 Доход: ${DELIVERY_FEE} сом\n💬: ${comment || 'нет'}`,
                    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🤝 ПРИНЯТЬ', `accept_${orderId}`)]]) }
                );
            } catch (e) { console.error(`❌ Ошибка отправки курьеру ${id}`); }
        }
    }
    res.sendStatus(200);
});

// Кнопка одобрения в админ-группе
bot.action(/approve_(.+)/, async (ctx) => {
    const id = ctx.match[1];
    if(couriers[id]) {
        couriers[id].isApproved = true;
        const adminName = ctx.from.first_name || "Админ";
        await ctx.editMessageText(`✅ Курьер ${couriers[id].name} одобрен админом ${adminName}!`);
        await courierBot.telegram.sendMessage(id, "🎉 Поздравляем! Вы одобрены. Теперь выходите на линию!", getCourierMenu(id));
    } else {
        await ctx.answerCbQuery("Курьер не найден в памяти сервера");
    }
});

// ==========================================
// 2. КУРЬЕРСКИЙ БОТ
// ==========================================

courierBot.start(async (ctx) => {
    const id = ctx.from.id;
    // Если курьер новый или в процессе регистрации - сбрасываем на ввод имени
    couriers[id] = { id, step: 'name', balance: 0, dailyOrders: 0, status: 'offline', isApproved: false, name: '', phone: '' };
    await ctx.reply("Добро пожаловать в команду! 🛵\nВведите ваше Имя и Фамилию:");
});

courierBot.on('text', async (ctx) => {
    const id = ctx.from.id;
    const msg = ctx.message.text;
    const c = couriers[id];
    if (!c) return;

    // Шаг 1: Имя
    if (c.step === 'name') {
        c.name = msg;
        c.step = 'phone';
        return ctx.reply(`Приятно познакомиться, ${c.name}!\nТеперь введите ваш номер телефона:`);
    }

    // Шаг 2: Телефон
    if (c.step === 'phone') {
        c.phone = msg;
        c.step = 'waiting';
        ctx.reply("✅ Данные отправлены! Ожидайте одобрения администраторами в группе.", getCourierMenu(id));
        
        // Отправка админам (с защитой от вылета)
        if(ADMIN_ID) {
            bot.telegram.sendMessage(ADMIN_ID, 
                `🆕 *НОВЫЙ КУРЬЕР:*\n👤 Имя: ${c.name}\n📱 Тел: ${c.phone}\n🆔 ID: \`${id}\``, 
                { 
                    parse_mode: 'Markdown', 
                    ...Markup.inlineKeyboard([[Markup.button.callback('✅ ОДОБРИТЬ КАНДИДАТА', `approve_${id}`)]]) 
                }
            ).catch(err => {
                console.error("❌ ОШИБКА: Бот не может отправить сообщение в админ-группу!");
                console.error("Проверь ADMIN_CHAT_ID и добавлен ли бот в группу.");
            });
        }
        return;
    }

    if (!c.isApproved) return ctx.reply("⏳ Ваш аккаунт еще не одобрен администратором.");

    // Обработка кнопок меню
    switch (msg) {
        case '🟢 Выйти на линию': c.status = 'online'; ctx.reply("📡 Вы на линии! Ожидайте заказы.", getCourierMenu(id)); break;
        case '🔴 Уйти с линии': c.status = 'offline'; ctx.reply("😴 Отдыхаете. Хорошего дня!", getCourierMenu(id)); break;
        case '📊 Инфо': ctx.reply(`📊 Статистика:\nДоставок сегодня: ${c.dailyOrders}\nБаланс: ${c.balance} сом`); break;
        case '💳 Баланс': ctx.reply(`Ваш баланс: ${c.balance} сом.\nДля пополнения пишите @tamak_admin`); break;
        case '🎧 Поддержка': ctx.reply(`Связь с админом: @tamak_admin`); break;
    }
});

// Кнопки заказа
courierBot.action(/accept_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    const order = activeOrders[orderId];
    if(!order || order.status !== 'pending') return ctx.answerCbQuery("Заказ уже забрали!");
    order.status = 'accepted';
    await ctx.editMessageText(`✅ Вы приняли заказ #${orderId}\n🏬 Ресторан: ${order.restaurantName}\n📍 Куда: ${order.address}`, 
        Markup.inlineKeyboard([[Markup.button.callback('📍 Я НА МЕСТЕ', `arrive_${orderId}`)]]));
});

courierBot.action(/arrive_(.+)/, async (ctx) => {
    ctx.editMessageText("Ждите выдачи заказа ⏳", Markup.inlineKeyboard([[Markup.button.callback('🛍️ ЗАБРАЛ ЗАКАЗ', `pickup_${ctx.match[1]}`)]]));
});

courierBot.action(/pickup_(.+)/, async (ctx) => {
    const order = activeOrders[ctx.match[1]];
    ctx.editMessageText(`🛵 Везите по адресу: ${order.address}`, Markup.inlineKeyboard([[Markup.button.callback('🏁 ДОСТАВИЛ', `deliver_${ctx.match[1]}`)]]));
});

courierBot.action(/deliver_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    const id = ctx.from.id;
    if (couriers[id]) { couriers[id].dailyOrders++; couriers[id].balance -= COMMISSION; }
    await ctx.editMessageText(`✅ Заказ доставлен!\n💰 Доход: +${DELIVERY_FEE} сом\n📉 Списано комиссии: -${COMMISSION} сом`);
    if(activeOrders[orderId]?.clientId) bot.telegram.sendMessage(activeOrders[orderId].clientId, "😋 Ваш заказ доставлен! Приятного аппетита!");
    delete activeOrders[orderId];
});

// === ЗАПУСК СЕРВЕРА И БОТА ===
const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Сервер успешно запущен на порту ${PORT}`);
});

bot.launch().catch(err => {
    console.error("🔴 Ошибка при запуске бота. Проверь BOT_TOKEN!", err);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));