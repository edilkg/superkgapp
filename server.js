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
// 1. СОЗДАНИЕ ЗАКАЗА (СО СТАТУСОМ 'waiting_payment')
// ==========================================
app.post('/web-data', async (req, res) => {
    try {
        const { type, user, phone, address, restaurantName, restaurantAddress, totalPrice, comment, resComment, isDoorDelivery, cutlery, items, dest_lat, dest_lon } = req.body;
        
        if (type !== 'food') return res.status(400).json({ error: 'Тип не еда' });

        if (user && user.id && user.id != 111) {
            const { data: activeUserOrders } = await supabase
                .from('orders').select('id').eq('client_id', user.id)
                .in('status', ['waiting_payment', 'paid', 'cooking', 'delivery']);
            if (activeUserOrders && activeUserOrders.length >= 2) {
                return res.status(400).json({ error: 'У вас уже есть 2 активных заказа! Дождитесь их завершения.' });
            }
        }

        let extraDetails = [];
        if (restaurantAddress) extraDetails.push(`🏪 Адрес ресторана: ${restaurantAddress}`); 
        if (isDoorDelivery) extraDetails.push("🚪 Доставка до двери");
        if (cutlery > 0) extraDetails.push(`🍴 Приборы: ${cutlery}`);
        if (comment) extraDetails.push(`📍 Ориентир: ${comment}`);
        if (resComment) extraDetails.push(`💬 Кухне: ${resComment}`);
        if (dest_lat && dest_lon) extraDetails.push(`🗺 2ГИС: https://2gis.kg/geo/${dest_lon},${dest_lat}`);

        const { data: orderData, error: dbError } = await supabase.from('orders').insert([{
            client_id: user?.id || null,
            client_name: user?.first_name || 'Гость',
            phone: phone || '', 
            address: address,
            restaurant: restaurantName,
            total_price: totalPrice,
            comment: extraDetails.join(' | '), 
            items: items,
            status: 'waiting_payment' // Заказ пока только ждет оплаты!
        }]).select();

        if (dbError) throw dbError;
        const newOrder = orderData[0];

        // ⚠️ ВАЖНО: Мы больше не отправляем заказ админу здесь! Он отправится только после оплаты.
        res.status(200).json({ success: true, orderId: newOrder.id });

    } catch (err) {
        console.error(err);
        if (!res.headersSent) res.status(500).json({ error: err.message });
    }
});

// ==========================================
// 2. ГЕНЕРАЦИЯ QR-КОДА
// ==========================================
app.post('/api/create-qr', async (req, res) => {
    try {
        const { amount, orderId } = req.body;
        const operationID = "ORDER_" + orderId; // Жестко привязываем QR к ID заказа!

        const bakaiPayload = {
            accountNo: "1240040003285038", 
            currencyId: 417,               
            amount: amount || 100,         
            operationID: operationID,      
            qrTtlUnits: 1,                 
            qrTtl: 15                      
        };

        const response = await fetch('https://openbanking-api.bakai.kg/api/Qr/GenerateQR', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.BAKAI_TOKEN}` 
            },
            body: JSON.stringify(bakaiPayload)
        });

        const data = await response.json();

        if (!response.ok) return res.status(response.status).json({ error: "Ошибка банка при создании QR", details: data });

        res.json({ status: "success", operationID: operationID, bakaiResponse: data });

    } catch (error) {
        console.error("❌ Ошибка сервера:", error);
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 3. ВЕБХУК ОТ БАНКА (АВТОМАТИКА)
// ==========================================
app.post('/api/bakai-webhook', async (req, res) => {
    try {
        console.log("🔔 ВЕБХУК ОТ БАКАЙ БАНКА:", req.body);
        
        // Банк пришлет нам обратно operationID, который мы ему дали
        const operationID = req.body.operationID || req.body.OperationId || req.body.operationId;
        const status = req.body.status || req.body.Status || "SUCCESS";

        // Если пришел успешный статус и есть ID
        if (operationID && (status.toUpperCase() === "SUCCESS" || status === "COMPLETED" || req.body.isPaid === true)) {
            const orderId = operationID.replace("ORDER_", ""); // Достаем чистый ID заказа (например "123")

            // Проверяем статус в базе
            const { data: existingOrder } = await supabase.from('orders').select('status').eq('id', orderId).single();

            // Если заказ ждал оплаты, меняем на ОПЛАЧЕНО
            if (existingOrder && existingOrder.status === 'waiting_payment') {
                const { data: updatedOrders, error } = await supabase
                    .from('orders')
                    .update({ status: 'paid' })
                    .eq('id', orderId)
                    .select();

                if (!error && updatedOrders && updatedOrders.length > 0) {
                    // 🎉 ДЕНЬГИ ПРИШЛИ! ТЕПЕРЬ ОТПРАВЛЯЕМ ЗАКАЗ АДМИНУ И В РЕСТОРАН!
                    adminActions.sendOrderToAdmin(updatedOrders[0]);
                    console.log(`✅ ЗАКАЗ №${orderId} УСПЕШНО ОПЛАЧЕН И УШЕЛ В РАБОТУ!`);
                }
            }
        }
        
        res.status(200).json({ status: "ok" }); // Обязательно отвечаем банку ОК
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