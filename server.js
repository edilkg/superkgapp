require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const setupClientBot = require('./bot_client');
const setupCourierBot = require('./bot_courier');
const setupRestaurantBot = require('./bot_restaurant');
const setupAdminBot = require('./bot_admin');

const app = express();
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const bot = new Telegraf(process.env.BOT_TOKEN); 
const courierBot = new Telegraf(process.env.COURIER_BOT_TOKEN); 
const restBot = new Telegraf(process.env.REST_BOT_TOKEN); 

const ADMIN_GROUP_ID = process.env.ADMIN_CHAT_ID; 

// ==========================================
// ИНИЦИАЛИЗАЦИЯ БОТОВ (ИСПРАВЛЕННЫЙ ПОРЯДОК)
// ==========================================
setupClientBot(bot, supabase, ADMIN_GROUP_ID);

// ВАЖНО: Теперь мы правильно передаем restBot в курьерского бота!
setupCourierBot(courierBot, bot, restBot, supabase, ADMIN_GROUP_ID);

setupRestaurantBot(restBot, courierBot, bot, supabase, ADMIN_GROUP_ID);

const adminActions = setupAdminBot(bot, restBot, courierBot, supabase, ADMIN_GROUP_ID);

// ==========================================
// ПРИЕМ ЗАКАЗОВ С САЙТА
// ==========================================
app.post('/web-data', async (req, res) => {
    try {
        const { type, user, phone, address, restaurantName, totalPrice, comment, resComment, isDoorDelivery, cutlery, items } = req.body;
        if (type !== 'food') return res.status(400).json({ error: 'Тип не еда' });

        // 👉 БРОНЕЖИЛЕТ ОТ СПАМА (МАКСИМУМ 3 ЗАКАЗА НА СЕРВЕРЕ)
        if (user && user.id && user.id != 111) {
            const { data: activeUserOrders } = await supabase
                .from('orders')
                .select('id')
                .eq('client_id', user.id)
                .in('status', ['waiting_payment', 'paid', 'cooking', 'delivery']);
            
            if (activeUserOrders && activeUserOrders.length >= 3) {
                return res.status(400).json({ error: 'У вас уже есть 3 активных заказа! Дождитесь их завершения.' });
            }
        }

        // Собираем все комментарии и опции
        let extraDetails = [];
        if (isDoorDelivery) extraDetails.push('🚪 До двери: Да');
        if (cutlery > 0) extraDetails.push(`🍴 Приборы: ${cutlery} шт`);
        if (comment) extraDetails.push(`📍 Ориентир: ${comment}`);
        if (resComment) extraDetails.push(`💬 Заведению: ${resComment}`);

        // Сохраняем в базу
        const { data: orderData, error: dbError } = await supabase.from('orders').insert([{
            client_id: user?.id || null,
            client_name: user?.first_name || 'Гость',
            phone: phone || '', 
            address: address,
            restaurant: restaurantName,
            total_price: totalPrice,
            comment: extraDetails.join(' | '),
            items: items,
            status: 'waiting_payment'
        }]).select();

        if (dbError) throw dbError;
        const newOrder = orderData[0];

        // Моментально отвечаем браузеру
        res.status(200).json({ success: true, orderId: newOrder.id });

        // Отправляем админу
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