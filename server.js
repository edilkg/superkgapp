require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

// 1. Подключаем модули
const setupClientBot = require('./bot_client');
const setupCourierBot = require('./bot_courier');
const setupRestaurantBot = require('./bot_restaurant');

const app = express();
app.use(cors());
app.use(express.json());

// 2. БД
// Добавлена проверка на наличие переменных окружения
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_KEY) {
    console.error("КРИТИЧЕСКАЯ ОШИБКА: Не заданы SUPABASE_URL или SUPABASE_KEY");
    process.exit(1);
}
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 3. Инициализация ВСЕХ ботов
if (!process.env.BOT_TOKEN || !process.env.COURIER_BOT_TOKEN || !process.env.REST_BOT_TOKEN) {
    console.error("КРИТИЧЕСКАЯ ОШИБКА: Отсутствует один или несколько токенов ботов");
    process.exit(1);
}
const bot = new Telegraf(process.env.BOT_TOKEN); 
const courierBot = new Telegraf(process.env.COURIER_BOT_TOKEN); 
const restBot = new Telegraf(process.env.REST_BOT_TOKEN); 

// ID Группы Админов
const ADMIN_GROUP_ID = process.env.ADMIN_CHAT_ID; 

// 4. Запускаем логику модулей
setupClientBot(bot, supabase, ADMIN_GROUP_ID);
setupCourierBot(courierBot, bot, supabase, ADMIN_GROUP_ID);
setupRestaurantBot(restBot, courierBot, bot, supabase, ADMIN_GROUP_ID);

// === ТЕСТ СВЯЗИ БОТОВ ===
bot.command('testbots', async (ctx) => {
    await ctx.reply("📡 Начинаю сканирование системы...");
    try {
        const restInfo = await restBot.telegram.getMe();
        await ctx.reply(`🟢 РЕСТОРАН: Бот @${restInfo.username} на связи!`);
    } catch (e) { await ctx.reply(`🔴 РЕСТОРАН ОШИБКА: ${e.message}`); }

    try {
        const courierInfo = await courierBot.telegram.getMe();
        await ctx.reply(`🟢 КУРЬЕР: Бот @${courierInfo.username} на связи!`);
    } catch (e) { await ctx.reply(`🔴 КУРЬЕР ОШИБКА: ${e.message}`); }
});

// 5. ПРИЕМ ЗАКАЗОВ ОТ МИНИ-АППА
app.post('/web-data', async (req, res) => {
    try {
        const { type, user, address, restaurantName, totalPrice, comment, items } = req.body;
        if (type !== 'food') return res.status(400).json({ error: 'Неизвестный тип' });

        const itemsText = items.map(i => `▫️ ${i.item.name} x${i.count}`).join('\n');

        const { data: orderData, error: dbError } = await supabase.from('orders').insert([{
            client_id: user?.id || null,
            client_name: user?.first_name || 'Гость',
            address: address,
            restaurant: restaurantName,
            total_price: totalPrice,
            comment: comment || '',
            items: items,
            status: 'new'
        }]).select();

        if (dbError) throw dbError;
        const orderId = orderData[0].id;

        const { data: restData } = await supabase.from('restaurants').select('id').eq('name', restaurantName).single();

        if (restData && restData.id) {
            // 1. Уведомление Ресторану (в личку)
            let msgRest = `🍔 НОВЫЙ ЗАКАЗ #${String(orderId).slice(0,5)}\n\n${itemsText}\n\nСумма: ${totalPrice} сом`;
            await restBot.telegram.sendMessage(restData.id, msgRest, Markup.inlineKeyboard([
                [Markup.button.callback('✅ Принять', `rest_accept_${orderId}`)],
                [Markup.button.callback('❌ Отклонить', `rest_decline_${orderId}`)]
            ]));

            // 2. Уведомление Курьерам (в группу)
            const targetGroupId = process.env.COURIER_GROUP_ID || ADMIN_GROUP_ID;
            let msgCourier = `🔥 СВОБОДНЫЙ ЗАКАЗ #${String(orderId).slice(0,5)}!\n\n🏢 Откуда: ${restaurantName}\n📍 Куда: ${address}\n💰 Сумма: ${totalPrice} сом`;
            
            await courierBot.telegram.sendMessage(targetGroupId, msgCourier, Markup.inlineKeyboard([
                [Markup.button.callback('🏃‍♂️ Я ЗАБЕРУ!', `courier_take_${orderId}`)]
            ]));

        } else {
            await bot.telegram.sendMessage(ADMIN_GROUP_ID, `⚠️ Ресторан "${restaurantName}" не найден в базе для заказа #${orderId}`);
        }

        res.status(200).json({ success: true, orderId });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Запуск
const PORT = process.env.PORT || 3000;
// Изменил '0.0.0.0' на просто PORT, иногда Render капризничает из-за этого
app.listen(PORT, () => console.log(`🚀 Диспетчер запущен на порту ${PORT}`));

const startBots = async () => {
    const launch = async (b, name) => {
        try {
            await b.telegram.deleteWebhook({ drop_pending_updates: true });
            await b.launch();
            console.log(`✅ ${name} запущен`);
        } catch (e) { console.error(`❌ Ошибка ${name}:`, e.message); }
    };
    await Promise.all([launch(bot, 'КЛИЕНТ'), launch(courierBot, 'КУРЬЕР'), launch(restBot, 'РЕСТОРАН')]);
};
startBots();

const safeStop = (s) => {
    try { bot.stop(s); courierBot.stop(s); restBot.stop(s); } catch(e){}
    process.exit(0);
};
process.once('SIGINT', () => safeStop('SIGINT'));
process.once('SIGTERM', () => safeStop('SIGTERM'));