require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());

// 1. Инициализация Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 2. Инициализация ботов
const bot = new Telegraf(process.env.BOT_TOKEN); // Клиентский
const courierBot = new Telegraf(process.env.COURIER_BOT_TOKEN); // Курьерский

const ADMIN_GROUP_ID = process.env.ADMIN_CHAT_ID;
const DELIVERY_FEE = 150;

// ==========================================
// ЛОГИКА ПРИЕМА ЗАКАЗА ИЗ MINI APP
// ==========================================

app.post('/web-data', async (req, res) => {
    const { user, address, restaurantName, totalPrice, comment } = req.body;

    try {
        // 1. Сохраняем заказ в базу
        const { data: newOrder, error } = await supabase
            .from('orders')
            .insert([{
                client_id: user?.id,
                address: address,
                restaurant: restaurantName,
                total_price: totalPrice,
                status: 'pending'
            }])
            .select()
            .single();

        if (error) throw error;

        const orderId = newOrder.id;
        console.log(`📦 Заказ #${orderId} сохранен в БД`);

        // 2. Ищем онлайн-курьеров (Исправлено: используем .eq вместо .where)
        const { data: onlineCouriers } = await supabase
            .from('couriers')
            .select('id')
            .eq('status', 'online')
            .eq('is_approved', true);

        // 3. Рассылаем уведомления
        if (onlineCouriers && onlineCouriers.length > 0) {
            onlineCouriers.forEach(courier => {
                courierBot.telegram.sendMessage(courier.id, 
                    `🔥 НОВЫЙ ЗАКАЗ #${orderId}\n🏬 Из: ${restaurantName}\n📍 Куда: ${address}\n💰 Доход: ${DELIVERY_FEE} сом\n💬: ${comment || 'нет'}`,
                    Markup.inlineKeyboard([[Markup.button.callback('🤝 ПРИНЯТЬ', `accept_${orderId}`)]])
                ).catch(e => console.log(`Ошибка отправки курьеру ${courier.id}`));
            });
        }

        res.status(200).json({ success: true, orderId });

    } catch (err) {
        console.error("🔴 Ошибка заказа:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// ЛОГИКА БОТОВ
// ==========================================

// КЛИЕНТСКИЙ БОТ
bot.start((ctx) => {
    ctx.reply('Добро пожаловать в ТамакKG! 🍔', 
        Markup.inlineKeyboard([
            // ЗАМЕНИ НА ССЫЛКУ ТИПА https://edilkg.github.io/superkgapp/
            [Markup.button.webApp('Открыть меню', 'https://edilkg.github.io/superkgapp/?v=2')] 
        ])
    );
});

// КУРЬЕРСКИЙ БОТ: Меню
const getCourierMenu = (isApproved, status) => {
    if (!isApproved) return Markup.keyboard([['⏳ Ожидание одобрения...']]).resize();
    const statusBtn = status === 'online' ? '🔴 Уйти с линии' : '🟢 Выйти на линию';
    return Markup.keyboard([[statusBtn], ['📊 Инфо', '💳 Баланс'], ['🎧 Поддержка']]).resize();
};

courierBot.start(async (ctx) => {
    const id = ctx.from.id;
    const { data: courier } = await supabase.from('couriers').select('*').eq('id', id).single();

    if (!courier) {
        await supabase.from('couriers').insert([{ id, name: ctx.from.first_name, step: 'ask_phone', balance: 0 }]);
        return ctx.reply("Привет! Введи свой номер телефона для регистрации:");
    }
    ctx.reply("Меню курьера:", getCourierMenu(courier.is_approved, courier.status));
});

courierBot.on('text', async (ctx) => {
    const id = ctx.from.id;
    const msg = ctx.message.text;
    const { data: courier } = await supabase.from('couriers').select('*').eq('id', id).single();

    if (!courier) return;

    if (courier.step === 'ask_phone') {
        await supabase.from('couriers').update({ phone: msg, step: 'completed' }).eq('id', id);
        ctx.reply("✅ Данные приняты! Ожидайте одобрения администратором.");
        if (ADMIN_GROUP_ID) {
            bot.telegram.sendMessage(ADMIN_GROUP_ID, `🆕 Новый курьер!\n👤 Имя: ${courier.name}\n📱 Тел: ${msg}\n🆔 ID: ${id}`,
                Markup.inlineKeyboard([[Markup.button.callback('✅ ОДОБРИТЬ', `approve_${id}`)]])
            ).catch(e => console.log("Группа админа не найдена"));
        }
        return;
    }

    if (!courier.is_approved) return ctx.reply("⏳ Ваш аккаунт еще проверяется.");

    if (msg === '🟢 Выйти на линию') {
        await supabase.from('couriers').update({ status: 'online' }).eq('id', id);
        ctx.reply("📡 Вы на линии! Теперь вы будете получать заказы.", getCourierMenu(true, 'online'));
    } else if (msg === '🔴 Уйти с линии') {
        await supabase.from('couriers').update({ status: 'offline' }).eq('id', id);
        ctx.reply("😴 Вы ушли с линии.", getCourierMenu(true, 'offline'));
    } else if (msg === '📊 Инфо') {
        ctx.reply(`💳 Ваш баланс: ${courier.balance || 0} сом\n📱 Ваш статус: ${courier.status}`);
    }
});

// Одобрение курьера
bot.action(/approve_(.+)/, async (ctx) => {
    const courierId = ctx.match[1];
    await supabase.from('couriers').update({ is_approved: true }).eq('id', courierId);
    ctx.editMessageText(`✅ Курьер ${courierId} одобрен!`);
    courierBot.telegram.sendMessage(courierId, "🎉 Тебя одобрили! Можешь выходить на линию.");
});

// Принятие заказа курьером
courierBot.action(/accept_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    const { data: order } = await supabase.from('orders').select('*').eq('id', orderId).single();

    if (!order || order.status !== 'pending') return ctx.answerCbQuery("Заказ уже занят или отменен.");

    await supabase.from('orders').update({ status: 'accepted', courier_id: ctx.from.id }).eq('id', orderId);
    ctx.editMessageText(`✅ Вы приняли заказ #${orderId}\n🏬 ${order.restaurant}\n📍 ${order.address}`);
    
    if (order.client_id) {
        bot.telegram.sendMessage(order.client_id, `🚴 Курьер принял ваш заказ #${orderId}! Ожидайте доставку.`);
    }
});

// --- ЗАПУСК ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));

const startBots = async () => {
    try {
        await bot.launch();
        console.log('✅ Клиентский бот: ЗАПУЩЕН');
        await courierBot.launch();
        console.log('✅ Курьерский бот: ЗАПУЩЕН');
    } catch (error) {
        console.error('🔴 Ошибка запуска:', error.message);
    }
};

startBots();

// Остановка для безопасности
process.once('SIGINT', () => { bot.stop('SIGINT'); courierBot.stop('SIGINT'); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); courierBot.stop('SIGTERM'); });