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
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 3. Инициализация ВСЕХ ботов
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
        const { type, user, address, dest_lat, dest_lon, restaurantName, totalPrice, comment, items } = req.body;

        if (type !== 'food') return res.status(400).json({ error: 'Неизвестный тип заказа' });

        const itemsText = items.map(i => `▫️ ${i.item.name} x${i.count} (${i.pricePerUnit} сом)`).join('\n');

        // Сохраняем в БД
        const { data: orderData, error: dbError } = await supabase.from('orders').insert([{
            client_id: user?.id || null,
            client_name: user?.first_name || 'Гость',
            address: address,
            dest_lat: dest_lat,
            dest_lon: dest_lon,
            restaurant: restaurantName,
            total_price: totalPrice,
            comment: comment || '',
            items: items,
            status: 'new'
        }]).select();

        if (dbError) throw dbError;
        const orderId = orderData[0].id;

        // ИЩЕМ РЕСТОРАН В БАЗЕ
        const { data: restData } = await supabase.from('restaurants').select('id').eq('name', restaurantName).single();

        if (restData && restData.id) {
            
            // ==========================================
            // ДВОЙНОЙ ЗАЛП: КУРЬЕРУ И РЕСТОРАНУ СРАЗУ
            // ==========================================
            
            // Залп 1: В личку Ресторану
            let msgRest = `🍔 НОВЫЙ ЗАКАЗ!\nНомер: #${String(orderId).slice(0,5)}\n\nЧто приготовить:\n${itemsText}\n\nСумма: ${totalPrice} сом\nКомментарий: ${comment || 'нет'}`;
            await restBot.telegram.sendMessage(restData.id, msgRest, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '✅ Принять (Начать готовить)', callback_data: `rest_accept_${orderId}` }],
                        [{ text: '❌ Отклонить', callback_data: `rest_decline_${orderId}` }]
                    ]
                }
            });

            // Залп 2: Курьерам в группу
            const targetGroupId = process.env.COURIER_GROUP_ID || ADMIN_GROUP_ID;
            let msgCourier = `🔥 НОВЫЙ ЗАКАЗ #${String(orderId).slice(0,5)}!\n\n🏢 Забрать: ${restaurantName}\n📍 Отвезти: ${address}\n💰 Оплата клиентом: ${totalPrice} сом\n\nКто готов забрать?`;
            await courierBot.telegram.sendMessage(targetGroupId, msgCourier, {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '🏃‍♂️ Я ЗАБЕРУ!', callback_data: `courier_take_${orderId}` }]
                    ]
                }
            });

        } else {
            // Если ресторан не найден
            await bot.telegram.sendMessage(ADMIN_GROUP_ID, `⚠️ Заказ #${String(orderId).slice(0,5)} сохранен в базу, но ресторан "${restaurantName}" не найден!`);
        }

        res.status(200).json({ success: true, orderId });

    } catch (err) {
        console.error("🔴 Ошибка при создании заказа:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// ЗАПУСК СЕРВЕРА И БОТОВ
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Диспетчер запущен на порту ${PORT}`));

const startBots = async () => {
    console.log('⏳ Начинаем ПАРАЛЛЕЛЬНЫЙ запуск (с жесткой очисткой)...');
    
    const launchBot = async (botInstance, name) => {
        try {
            const me = await botInstance.telegram.getMe();
            console.log(`🟢 [${name}] Бот @${me.username} на связи.`);
            await botInstance.telegram.deleteWebhook({ drop_pending_updates: true });
            await botInstance.launch();
            console.log(`✅ [${name}] УСПЕШНО ЗАПУЩЕН!`);
        } catch (e) {
            console.error(`❌ [${name}] ОШИБКА:`, e.message);
        }
    };

    await Promise.all([
        launchBot(bot, 'КЛИЕНТ'),
        launchBot(courierBot, 'КУРЬЕР'),
        launchBot(restBot, 'РЕСТОРАН')
    ]);
};
startBots();

const safeStop = (signal) => {
    console.log(`🛑 Получен сигнал ${signal}, безопасно выключаем сервер...`);
    try { if (bot.botInfo) bot.stop(signal); } catch(e){}
    try { if (courierBot.botInfo) courierBot.stop(signal); } catch(e){}
    try { if (restBot.botInfo) restBot.stop(signal); } catch(e){}
    process.exit(0);
};

process.once('SIGINT', () => safeStop('SIGINT'));
process.once('SIGTERM', () => safeStop('SIGTERM'));