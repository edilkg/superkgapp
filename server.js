require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

// 1. Подключаем наши внешние модули
const setupClientBot = require('./bot_client');
const setupCourierBot = require('./bot_courier');
// const setupRestaurantBot = require('./bot_restaurant'); // Подключим позже!

const app = express();
app.use(cors());
app.use(express.json());

// 2. Инициализация Базы Данных
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// 3. Инициализация Ботов
const bot = new Telegraf(process.env.BOT_TOKEN); // Клиентский бот (Главный)
const courierBot = new Telegraf(process.env.COURIER_BOT_TOKEN); // Курьерский бот

// ID Групп из переменных окружения
const ADMIN_GROUP_ID = process.env.ADMIN_CHAT_ID; 
const COURIER_GROUP_ID = process.env.COURIER_CHAT_ID || process.env.ADMIN_CHAT_ID; 
const DELIVERY_FEE = 150;

// 4. ПЕРЕДАЕМ БОТОВ В МОДУЛИ (Чтобы они там работали)
setupClientBot(bot, supabase, ADMIN_GROUP_ID);
setupCourierBot(courierBot, bot, supabase, ADMIN_GROUP_ID);


// ==========================================
// ПРИЕМ ЗАКАЗА ИЗ WEB APP (ОТ КЛИЕНТА)
// ==========================================
app.post('/web-data', async (req, res) => {
    const { user, address, restaurantName, totalPrice, comment } = req.body;

    try {
        // 1. Сохраняем заказ в Supabase
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
        console.log(`📦 Заказ #${orderId} создан в БД`);

        // 2. Отправляем уведомление Курьерам
        const orderText = `🔥 НОВЫЙ ЗАКАЗ #${orderId.slice(0,5)}\n🏬 Ресторан: ${restaurantName}\n📍 Адрес: ${address}\n💰 Доход курьера: ${DELIVERY_FEE} сом\n💬 Коммент: ${comment || 'нет'}`;
        
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
// ЗАПУСК СЕРВЕРА
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Главный сервер (Диспетчер) запущен на порту ${PORT}`));

const startBots = async () => {
    try {
        await bot.launch();
        console.log('✅ Клиентский бот запущен');
        await courierBot.launch();
        console.log('✅ Курьерский бот запущен');
    } catch (e) {
        console.error('🔴 Ошибка запуска ботов:', e.message);
    }
};
startBots();

// Безопасное выключение
process.once('SIGINT', () => { bot.stop('SIGINT'); courierBot.stop('SIGINT'); });
process.once('SIGTERM', () => { bot.stop('SIGTERM'); courierBot.stop('SIGTERM'); });