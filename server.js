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
const bot = new Telegraf(process.env.BOT_TOKEN); // Клиентский бот
const courierBot = new Telegraf(process.env.COURIER_BOT_TOKEN); // Курьерский бот

// ID Групп из переменных окружения
const ADMIN_GROUP_ID = process.env.ADMIN_CHAT_ID; // Группа для проверки документов курьеров
const COURIER_GROUP_ID = process.env.COURIER_CHAT_ID || process.env.ADMIN_CHAT_ID; // Группа, где курьеры берут заказы
const DELIVERY_FEE = 150;

// ==========================================
// ЛОГИКА ПРИЕМА ЗАКАЗА ИЗ MINI APP (FRONTEND)
// ==========================================

app.post('/web-data', async (req, res) => {
    const { user, address, restaurantName, totalPrice, comment } = req.body;

    try {
        // 1. Сохраняем заказ в базу данных
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
        console.log(`📦 Заказ #${orderId} создан`);

        // 2. Отправляем уведомление в ОБЩУЮ ГРУППУ КУРЬЕРОВ
        const orderText = `🔥 НОВЫЙ ЗАКАЗ #${orderId}\n🏬 Ресторан: ${restaurantName}\n📍 Адрес: ${address}\n💰 Доход курьера: ${DELIVERY_FEE} сом\n💬 Коммент: ${comment || 'нет'}`;
        
        await courierBot.telegram.sendMessage(COURIER_GROUP_ID, orderText, 
            Markup.inlineKeyboard([
                [Markup.button.callback('🤝 ПРИНЯТЬ ЗАКАЗ', `accept_${orderId}`)]
            ])
        );

        res.status(200).json({ success: true, orderId });

    } catch (err) {
        console.error("🔴 Ошибка при создании заказа:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// ЛОГИКА КЛИЕНТСКОГО БОТА
// ==========================================

bot.start((ctx) => {
    ctx.reply('Добро пожаловать в ТамакKG! 🍔\nСамая быстрая доставка в твоем городе.', 
        Markup.inlineKeyboard([
            [Markup.button.webApp('🍕 Открыть меню', 'https://edilkg.github.io/superkgapp/?v=35')] 
        ])
    );
});

// ==========================================
// ЛОГИКА КУРЬЕРСКОГО БОТА
// ==========================================

const getCourierMenu = (isApproved, status) => {
    if (!isApproved) return Markup.keyboard([['⏳ Ожидание одобрения...']]).resize();
    const statusBtn = status === 'online' ? '🔴 Уйти с линии' : '🟢 Выйти на линию';
    return Markup.keyboard([[statusBtn], ['📊 Моя статистика', '💳 Баланс']]).resize();
};

courierBot.start(async (ctx) => {
    const id = ctx.from.id;
    const { data: courier } = await supabase.from('couriers').select('*').eq('id', id).single();

    if (!courier) {
        await supabase.from('couriers').insert([{ id, name: ctx.from.first_name, step: 'ask_phone', balance: 0 }]);
        return ctx.reply("Привет! Ты хочешь стать курьером ТамакKG?\nНапиши свой номер телефона для регистрации:");
    }
    ctx.reply("Панель управления курьера:", getCourierMenu(courier.is_approved, courier.status));
});

// Регистрация курьера (текстовые сообщения)
courierBot.on('text', async (ctx) => {
    const id = ctx.from.id;
    const msg = ctx.message.text;
    const { data: courier } = await supabase.from('couriers').select('*').eq('id', id).single();

    if (!courier) return;

    if (courier.step === 'ask_phone') {
        await supabase.from('couriers').update({ phone: msg, step: 'completed' }).eq('id', id);
        ctx.reply("✅ Заявка отправлена! Админ проверит её в ближайшее время.");
        
        // Отправляем админу на одобрение
        bot.telegram.sendMessage(ADMIN_GROUP_ID, `🆕 Новый курьер!\n👤: ${courier.name}\n📱: ${msg}\n🆔: ${id}`,
            Markup.inlineKeyboard([[Markup.button.callback('✅ ОДОБРИТЬ', `approve_${id}`)]])
        );
        return;
    }

    if (!courier.is_approved) return ctx.reply("⏳ Твой аккаунт еще на проверке.");

    if (msg === '🟢 Выйти на линию') {
        await supabase.from('couriers').update({ status: 'online' }).eq('id', id);
        ctx.reply("📡 Ты на линии! Жди новые заказы.", getCourierMenu(true, 'online'));
    } else if (msg === '🔴 Уйти с линии') {
        await supabase.from('couriers').update({ status: 'offline' }).eq('id', id);
        ctx.reply("😴 Ты ушел с линии. Отдыхай!", getCourierMenu(true, 'offline'));
    }
});

// --- ОБРАБОТКА КНОПОК (ACTIONS) ---

// Одобрение курьера админом (в боте клиента/админки)
bot.action(/approve_(.+)/, async (ctx) => {
    const courierId = ctx.match[1];
    await supabase.from('couriers').update({ is_approved: true }).eq('id', courierId);
    ctx.editMessageText(`✅ Курьер ${courierId} теперь в штате!`);
    courierBot.telegram.sendMessage(courierId, "🎉 Поздравляем! Твой аккаунт одобрен. Выходи на линию!");
});

// КУРЬЕР: ПРИНЯТЬ ЗАКАЗ
courierBot.action(/accept_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    const { data: order } = await supabase.from('orders').select('*').eq('id', orderId).single();

    if (!order || order.status !== 'pending') {
        return ctx.answerCbQuery("❌ Заказ уже забрали!");
    }

    await supabase.from('orders').update({ status: 'accepted', courier_id: ctx.from.id }).eq('id', orderId);
    ctx.answerCbQuery("Заказ твой! Удачи!");

    // Уведомляем курьера и даем следующую кнопку
    ctx.editMessageText(`✅ Ты взял заказ #${orderId}\n📍 Езжай по адресу: ${order.address}`, 
        Markup.inlineKeyboard([[Markup.button.callback('📍 Я в ресторане', `at_res_${orderId}`)]])
    );
    
    // Уведомляем клиента
    if (order.client_id) {
        bot.telegram.sendMessage(order.client_id, `🚴 Курьер принял ваш заказ #${orderId}!\nОн уже едет в ресторан.`);
    }
});

// КУРЬЕР: В РЕСТОРАНЕ
courierBot.action(/at_res_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    await supabase.from('orders').update({ status: 'at_restaurant' }).eq('id', orderId);
    
    const { data: order } = await supabase.from('orders').select('*').eq('id', orderId).single();
    if (order.client_id) bot.telegram.sendMessage(order.client_id, "🏢 Курьер прибыл в ресторан. Ваш заказ готовится!");

    ctx.editMessageText(`✅ Ты в ресторане. Забирай еду и нажимай кнопку:`, 
        Markup.inlineKeyboard([[Markup.button.callback('🥡 Забрал, еду к клиенту', `delivering_${orderId}`)]])
    );
});

// КУРЬЕР: В ПУТИ
courierBot.action(/delivering_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    await supabase.from('orders').update({ status: 'delivering' }).eq('id', orderId);
    
    const { data: order } = await supabase.from('orders').select('*').eq('id', orderId).single();
    if (order.client_id) bot.telegram.sendMessage(order.client_id, "🚀 Курьер забрал заказ! Встречайте через 15-20 минут.");

    ctx.editMessageText(`🚴 Ты в пути. Поспеши, клиент голоден!\n🏠 Адрес: ${order.address}`, 
        Markup.inlineKeyboard([[Markup.button.callback('🏁 Доставил!', `done_${orderId}`)]])
    );
});

// КУРЬЕР: ЗАВЕРШЕНО
courierBot.action(/done_(.+)/, async (ctx) => {
    const orderId = ctx.match[1];
    await supabase.from('orders').update({ status: 'delivered' }).eq('id', orderId);
    
    const { data: order } = await supabase.from('orders').select('*').eq('id', orderId).single();
    if (order.client_id) bot.telegram.sendMessage(order.client_id, "✅ Заказ доставлен! Приятного аппетита! 🍽");

    ctx.editMessageText(`🏁 Заказ #${orderId} завершен. Хорошая работа!`);
});

// --- ЗАПУСК ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Сервер запущен на порту ${PORT}`));

const startBots = async () => {
    try {
        await bot.launch();
        console.log('✅ Клиентский бот запущен');
        await courierBot.launch();
        console.log('✅ Курьерский бот запущен');
    } catch (e) {
        console.error('🔴 Ошибка запуска:', e.message);
    }
};
startBots();

// Безопасное выключение
process.once('SIGINT', () => { bot.stop('SIGINT'); courierBot.stop('SIGINT'); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); courierBot.stop('SIGTERM'); });