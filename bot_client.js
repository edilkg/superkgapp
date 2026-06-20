const { Markup } = require('telegraf');
// server.js
require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const setupClientBot = require('./bot_client');
const setupCourierBot = require('./bot_courier');
const setupRestaurantBot = require('./bot_restaurant');
const setupAdminBot = require('./bot_admin'); // Подключили админский модуль

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const bot = new Telegraf(process.env.BOT_TOKEN); 
const courierBot = new Telegraf(process.env.COURIER_BOT_TOKEN); 
const restBot = new Telegraf(process.env.REST_BOT_TOKEN); 
const ADMIN_GROUP_ID = process.env.ADMIN_CHAT_ID; 

// Инициализируем ботов, передаем им всё необходимое
setupClientBot(bot, supabase);
setupCourierBot(courierBot, bot, supabase, ADMIN_GROUP_ID); 
setupRestaurantBot(restBot, courierBot, bot, supabase, ADMIN_GROUP_ID);
// Админский бот (он же главный bot) слушает команды в группе
setupAdminBot(bot, restBot, courierBot, supabase, ADMIN_GROUP_ID);

app.post('/web-data', async (req, res) => {
    try {
        const { type, user, address, restaurantName, totalPrice, comment, items } = req.body;
        if (type !== 'food') return res.status(400).json({ error: 'Тип не еда' });

        // 1. Сохраняем в базу (статус waiting_payment)
        const { data: orderData, error: dbError } = await supabase.from('orders').insert([{
            client_id: user?.id || null,
            client_name: user?.first_name || 'Гость',
            address: address,
            restaurant: restaurantName,
            total_price: totalPrice,
            comment: comment || '',
            items: items,
            status: 'waiting_payment'
        }]).select();

        if (dbError) throw dbError;
        const newOrder = orderData[0];

        // 2. МОМЕНТАЛЬНЫЙ ОТВЕТ КЛИЕНТУ (Браузер не виснет!)
        res.status(200).json({ success: true, orderId: newOrder.id });

        // 3. ФОНОВАЯ ОТПРАВКА АДМИНУ НА ПРОВЕРКУ
        setupAdminBot.sendOrderToAdmin(bot, ADMIN_GROUP_ID, newOrder);

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Сервер на порту ${PORT}`));

const startBots = async () => {
    const launch = async (b, n) => {
        try {
            await b.telegram.deleteWebhook({ drop_pending_updates: true });
            await b.launch();
            console.log(`✅ ${n} запущен`);
        } catch (e) { console.error(`❌ Ошибка ${n}:`, e.message); }
    };
    await Promise.all([launch(bot, 'КЛИЕНТ (АДМИН)'), launch(courierBot, 'КУРЬЕР'), launch(restBot, 'РЕСТОРАН')]);
};
startBots();

    // В будущем здесь будут: 
    // - Проверка статуса заказа по номеру
    // - Оставить отзыв
    // - Связь с поддержкой