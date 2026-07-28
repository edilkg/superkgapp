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
// ИНИЦИАЛИЗАЦИЯ БОТОВ
// ==========================================
setupClientBot(bot, supabase, ADMIN_GROUP_ID);
setupCourierBot(courierBot, bot, restBot, supabase, ADMIN_GROUP_ID);
setupRestaurantBot(restBot, courierBot, bot, supabase, ADMIN_GROUP_ID);
const adminActions = setupAdminBot(bot, restBot, courierBot, supabase, ADMIN_GROUP_ID);

// ==========================================
// 0. ОДНОРАЗОВАЯ ВЫЖИМАЛКА ТОКЕНА 
// ==========================================
app.get('/api/get-bakai-token', async (req, res) => {
    try {
        const response = await fetch('https://openbanking-api.bakai.kg/Auth/Login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                login: "m8kCCNSV",    // Твой новый логин
                password: "57FcUKMn"  // Твой новый пароль
            })
        });
        const data = await response.json();
        
        if (!response.ok) {
            return res.status(response.status).json({ error: "Логин уже сгорел или неверный", details: data });
        }

        res.json({ 
            status: "🔥 УСПЕШНО!", 
            message: "СОХРАНИ ЭТОТ ТОКЕН В RENDER В ПЕРЕМЕННУЮ BAKAI_TOKEN", 
            token: data.token 
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// 1. СОЗДАНИЕ ЗАКАЗА В БАЗЕ (status: 'waiting_payment')
// ==========================================
app.post('/web-data', async (req, res) => {
    try {
        const { type, user, phone, address, restaurantName, restaurantAddress, totalPrice, comment, resComment, isDoorDelivery, cutlery, items, dest_lat, dest_lon } = req.body;
        
        if (type !== 'food') return res.status(400).json({ error: 'Тип не еда' });

        // Защита от спама (не больше 2 активных заказов)
if (user && user.id && user.id != 111) {
    const { data: activeUserOrders } = await supabase
        .from('orders').select('id').eq('client_id', user.id)
        // 👇 УБРАЛИ waiting_payment отсюда!
        .in('status', ['paid', 'cooking', 'delivery']); 
        
    if (activeUserOrders && activeUserOrders.length >= 2) {
        return res.status(400).json({ error: 'У вас уже есть 2 готовящихся заказа! Дождитесь их доставки.' });
    }
}

        let extraDetails = [];
        if (restaurantAddress) extraDetails.push(`🏪 Адрес ресторана: ${restaurantAddress}`); 
        if (isDoorDelivery) extraDetails.push("🚪 Доставка до двери");
        if (cutlery > 0) extraDetails.push(`🍴 Приборы: ${cutlery}`);
        if (comment) extraDetails.push(`📍 Ориентир: ${comment}`);
        if (resComment) extraDetails.push(`💬 Кухне: ${resComment}`);
        if (dest_lat && dest_lon) extraDetails.push(`🗺 2ГИС: https://2gis.kg/geo/${dest_lon},${dest_lat}`);

        // Сохраняем заказ как waiting_payment
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

        res.status(200).json({ success: true, orderId: newOrder.id });

    } catch (err) {
        console.error(err);
        if (!res.headersSent) res.status(500).json({ error: err.message });
    }
});

// ==========================================
// 2. ГЕНЕРАЦИЯ ПЛАТЕЖНОЙ ССЫЛКИ (С ОТЛАДКОЙ ТОКЕНА)
// ==========================================
app.post('/api/create-paylink', async (req, res) => {
    try {
        const { amount, orderId } = req.body;
        const transactionID = "ORDER" + orderId; 

        const bakaiPayload = {
            amount: Number(amount),         
            transactionID: transactionID,   
            comment: `Oplata zakaza #${orderId}`, 
            redirectURL: "https://t.me/Tamak_kg_bot", 
            ttlUnits: 1,                    
            ttl: 15                         
        };

        const token = process.env.BAKAI_TOKEN;
        if (!token) {
            return res.status(500).json({ error: "BAKAI_TOKEN не найден в Render" });
        }

        // 🕵️ ШПИОН: Смотрим, какой именно токен сервер пытается отправить (первые 15 символов)
        console.log(`🔑 ШПИОН ТОКЕНА: Начинается на -> ${token.substring(0, 15)} | Длина: ${token.length} символов`);
        console.log("📤 Отправляем в Бакай Банк:", bakaiPayload);

        const response = await fetch('https://openbanking-api.bakai.kg/api/PayLink/CreatePayLink', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token.trim()}` // trim() на всякий случай удалит пробелы
            },
            body: JSON.stringify(bakaiPayload)
        });

        const textData = await response.text();
        let data;
        try { data = JSON.parse(textData); } catch (e) {
            console.error("❌ Банк вернул не JSON:", textData);
            return res.status(response.status).json({ error: "Банк вернул текст вместо JSON", details: textData });
        }

        if (!response.ok) {
            console.error("❌ Ошибка при создании ссылки:", data);
            return res.status(response.status).json({ 
                error: data.message || data.title || JSON.stringify(data) || "Ошибка банка", 
                details: data 
            });
        }

        res.json({ status: "success", transactionID: transactionID, bakaiResponse: data });

    } catch (error) {
        console.error("❌ Ошибка сервера:", error);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 3. ВЕБХУК ОТ БАНКА
// ==========================================
app.post('/api/bakai-webhook', async (req, res) => {
    try {
        console.log("🔔 ВЕБХУК ОТ БАКАЙ БАНКА:", req.body);
        
        const incomingID = req.body.transactionID || req.body.operationID || req.body.TransactionId || req.body.OperationId;
        const status = req.body.status || req.body.Status || "SUCCESS";

        if (incomingID && (status.toUpperCase() === "SUCCESS" || status === "COMPLETED" || req.body.isPaid === true)) {
            const orderId = incomingID.replace("ORDER_", "");

            const { data: existingOrder } = await supabase.from('orders').select('status').eq('id', orderId).single();

            if (existingOrder && existingOrder.status === 'waiting_payment') {
                const { data: updatedOrders, error } = await supabase
                    .from('orders')
                    .update({ status: 'paid' })
                    .eq('id', orderId)
                    .select();

                if (!error && updatedOrders && updatedOrders.length > 0) {
                    adminActions.sendOrderToAdmin(updatedOrders[0]);
                    console.log(`✅ ЗАКАЗ №${orderId} ОПЛАЧЕН ПО ССЫЛКЕ! ОТПРАВЛЕН В РАБОТУ!`);
                }
            }
        }
        
        res.status(200).json({ status: "ok" });
    } catch (err) {
        console.error("❌ Ошибка вебхука:", err);
        res.status(200).send("OK");
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