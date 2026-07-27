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
// ==========================================
// ОДНОРАЗОВАЯ ФУНКЦИЯ ДЛЯ ПОЛУЧЕНИЯ ТОКЕНА БАКАЙ БАНКА (ОТЛАДКА)
// ==========================================
app.get('/api/init-bakai', async (req, res) => {
    try {
        const response = await fetch('https://openbanking-api.bakai.kg/Auth/Login', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({
                login: "cATPLMUA",
                password: "ke7PV4DU"
            })
        });
        
        // Читаем ответ не как JSON, а как сырой текст (чтобы поймать HTML)
        const rawText = await response.text();
        
        // Выводим прямо в браузер красивую формочку с ответом банка
        res.send(`
            <meta name="viewport" content="width=device-width, initial-scale=1">
            <div style="font-family: sans-serif; padding: 20px;">
                <h2>Отладка Бакай Банка 🛠</h2>
                <p><b>HTTP Статус:</b> ${response.status} ${response.statusText}</p>
                <p><b>Ответ от банка:</b></p>
                <textarea style="width: 100%; height: 300px; padding: 10px; background: #eee; border: 1px solid #ccc; border-radius: 8px;">${rawText}</textarea>
            </div>
        `);
    } catch (error) {
        res.status(500).send(`Ошибка на нашем сервере: ${error.message}`);
    }
});
app.post('/web-data', async (req, res) => {
    try {
        // 👉 1. ДОБАВИЛИ restaurantAddress в прием данных
        const { type, user, phone, address, restaurantName, restaurantAddress, totalPrice, comment, resComment, isDoorDelivery, cutlery, items, dest_lat, dest_lon } = req.body;
        
        if (type !== 'food') return res.status(400).json({ error: 'Тип не еда' });

        // 👉 БРОНЕЖИЛЕТ ОТ СПАМА 
        if (user && user.id && user.id != 111) {
            const { data: activeUserOrders } = await supabase
                .from('orders')
                .select('id')
                .eq('client_id', user.id)
                .in('status', ['waiting_payment', 'paid', 'cooking', 'delivery']);
            
            if (activeUserOrders && activeUserOrders.length >= 2) {
                return res.status(400).json({ error: 'У вас уже есть 2 активных заказа! Дождитесь их завершения.' });
            }
        }

        let extraDetails = [];
        // 👉 2. СОХРАНЯЕМ АДРЕС В БАЗУ ДАННЫХ
        if (restaurantAddress) extraDetails.push(`🏪 Адрес ресторана: ${restaurantAddress}`); 
        if (isDoorDelivery) extraDetails.push("🚪 Доставка до двери");
        if (cutlery > 0) extraDetails.push(`🍴 Приборы: ${cutlery}`);
        if (comment) extraDetails.push(`📍 Ориентир: ${comment}`);
        if (resComment) extraDetails.push(`💬 Кухне: ${resComment}`);

        // 🗺 ДОБАВЛЯЕМ ССЫЛКУ НА 2ГИС 
        if (dest_lat && dest_lon) {
            extraDetails.push(`🗺 2ГИС: https://2gis.kg/geo/${dest_lon},${dest_lat}`);
        }

        // Сохраняем в базу данных Supabase
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

        // Моментально отвечаем фронтенду
        res.status(200).json({ success: true, orderId: newOrder.id });

        // 👉 3. ПЕРЕДАЕМ АДРЕС АДМИН-БОТУ ДЛЯ КРАСИВОГО ОТОБРАЖЕНИЯ
        adminActions.sendOrderToAdmin({ ...newOrder, restaurantAddress });

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