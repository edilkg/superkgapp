require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const setupClientBot = require('./bot_client');
const setupCourierBot = require('./bot_courier');
const setupRestaurantBot = require('./bot_restaurant');
const setupAdminBot = require('./bot_admin'); // <--- ВЕРНУЛИ ПОДКЛЮЧЕНИЕ АДМИНКИ

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const bot = new Telegraf(process.env.BOT_TOKEN); 
const courierBot = new Telegraf(process.env.COURIER_BOT_TOKEN); 
const restBot = new Telegraf(process.env.REST_BOT_TOKEN); 

const ADMIN_GROUP_ID = process.env.ADMIN_CHAT_ID; 

setupClientBot(bot, supabase, ADMIN_GROUP_ID);
setupCourierBot(courierBot, bot, supabase, ADMIN_GROUP_ID);
setupRestaurantBot(restBot, courierBot, bot, supabase, ADMIN_GROUP_ID);

// Инициализируем админку, чтобы бот начал слушать кнопки!
const adminActions = setupAdminBot(bot, restBot, courierBot, supabase, ADMIN_GROUP_ID);

app.post('/web-data', async (req, res) => {
    try {
        const { type, user, phone, address, restaurantName, totalPrice, comment, resComment, isDoorDelivery, cutlery, items } = req.body;
        if (type !== 'food') return res.status(400).json({ error: 'Тип не еда' });

        // Собираем все новые настройки заказа в красивую строку
        let extraDetails = [];
        if (isDoorDelivery) extraDetails.push('🚪 До двери: Да');
        if (cutlery > 0) extraDetails.push(`🍴 Приборы: ${cutlery} шт`);
        if (comment) extraDetails.push(`📍 Ориентир: ${comment}`);
        if (resComment) extraDetails.push(`💬 Заведению: ${resComment}`);

        // 1. Сохраняем в базу со статусом ожидания оплаты
        const { data: orderData, error: dbError } = await supabase.from('orders').insert([{
            client_id: user?.id || null,
            client_name: user?.first_name || 'Гость',
            phone: phone || '', 
            address: address,
            restaurant: restaurantName,
            total_price: totalPrice,
            comment: extraDetails.join(' | '), // Сохраняем все комментарии вместе
            items: items,
            status: 'waiting_payment'
        }]).select();

        if (dbError) throw dbError;
        const newOrder = orderData[0];

        // 2. Моментально отвечаем браузеру
        res.status(200).json({ success: true, orderId: newOrder.id });

        // 3. Отправляем заказ АДМИНУ на проверку (а не сразу ресторану!)
        adminActions.sendOrderToAdmin(newOrder);

    } catch (err) {
        console.error(err);
        if (!res.headersSent) {
            res.status(500).json({ error: err.message });
        }
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
    await Promise.all([launch(bot, 'ГЛАВНЫЙ БОТ (И АДМИН)'), launch(courierBot, 'КУРЬЕР'), launch(restBot, 'РЕСТОРАН')]);
};
startBots();