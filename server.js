require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

// 1. Подключаем модули
const setupClientBot = require('./bot_client');
const setupCourierBot = require('./bot_courier');
const setupRestaurantBot = require('./bot_restaurant'); // Подключили Ресторан!

const app = express();
app.use(cors());
app.use(express.json());

// 2. БД
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 3. Инициализация ВСЕХ ботов
const bot = new Telegraf(process.env.BOT_TOKEN); 
const courierBot = new Telegraf(process.env.COURIER_BOT_TOKEN); 
const restBot = new Telegraf(process.env.REST_BOT_TOKEN); // Третий бот

// ID Групп
const ADMIN_GROUP_ID = process.env.ADMIN_CHAT_ID; 
const COURIER_GROUP_ID = process.env.COURIER_CHAT_ID || process.env.ADMIN_CHAT_ID; 
const REST_GROUP_ID = process.env.REST_CHAT_ID || process.env.ADMIN_CHAT_ID; // Группа кухни

// 4. Запускаем логику модулей
setupClientBot(bot, supabase, ADMIN_GROUP_ID);
setupCourierBot(courierBot, bot, supabase, ADMIN_GROUP_ID);
setupRestaurantBot(restBot, courierBot, supabase, REST_GROUP_ID, COURIER_GROUP_ID);


// ==========================================
// ПРИЕМ ЗАКАЗА ИЗ WEB APP
// ==========================================
app.post('/web-data', async (req, res) => {
    // Добавили items (список блюд), чтобы показать их повару
    const { user, address, restaurantName, totalPrice, comment, items } = req.body;

    try {
        const { data: newOrder, error } = await supabase
            .from('orders')
            .insert([{
                client_id: user?.id,
                address: address,
                restaurant: restaurantName,
                total_price: totalPrice,
                comment: comment,
                status: 'pending'
            }])
            .select()
            .single();

        if (error) throw error;
        const orderId = newOrder.id;
        console.log(`📦 Заказ #${orderId} создан в БД`);

        // Формируем красивый список еды для повара
        let itemsText = items && items.length > 0 
            ? items.map(i => `🔸 ${i.count}x ${i.item.name}`).join('\n') 
            : 'Детали заказа в системе';

        // 2. ОТПРАВЛЯЕМ В РЕСТОРАН (а не курьерам)
        let msg = `🍔 НОВЫЙ ЗАКАЗ!\nНомер: #${orderId.slice(0,5)}\n\nЧто приготовить:\n${itemsText}\n\nСумма: ${totalPrice} сом`;
        
        await restBot.telegram.sendMessage(REST_GROUP_ID, msg, {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '✅ Принять (Начать готовить)', callback_data: `rest_accept_${orderId}` }]
                ]
            }
        });

        res.status(200).json({ success: true, orderId });

    } catch (err) {
        console.error("🔴 Ошибка при создании заказа:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// ЗАПУСК СЕРВЕРА
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Диспетчер запущен на порту ${PORT}`));

const startBots = async () => {
    try {
        await bot.launch();
        console.log('✅ Клиентский бот запущен');
        await courierBot.launch();
        console.log('✅ Курьерский бот запущен');
        await restBot.launch();
        console.log('✅ Ресторанный бот запущен');
    } catch (e) {
        console.error('🔴 Ошибка запуска ботов:', e.message);
    }
};
startBots();

process.once('SIGINT', () => { bot.stop('SIGINT'); courierBot.stop('SIGINT'); restBot.stop('SIGINT'); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); courierBot.stop('SIGTERM'); restBot.stop('SIGTERM'); });