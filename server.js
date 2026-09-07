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

// In-memory кэш для оперативного хранения живых координат курьеров
// Структура: courierId => { lat, lon, lastUpdate: timestamp, name, phone }
const activeCouriers = new Map();

const createDispatcher = require('./dispatch_engine');

// ==========================================
// ИНИЦИАЛИЗАЦИЯ БОТОВ И ДИСПЕТЧЕРА
// ==========================================
const dispatcher = createDispatcher({ courierBot, adminBot: bot, restBot, supabase, ADMIN_GROUP_ID, activeCouriers });

setupClientBot(bot, supabase, ADMIN_GROUP_ID);
setupCourierBot(courierBot, bot, restBot, supabase, ADMIN_GROUP_ID, activeCouriers, dispatcher);
setupRestaurantBot(restBot, courierBot, bot, supabase, ADMIN_GROUP_ID, dispatcher);
const adminActions = setupAdminBot(bot, restBot, courierBot, supabase, ADMIN_GROUP_ID, activeCouriers, dispatcher);
// ==========================================
// ФОНОВАЯ ОЧИСТКА "ПРИЗРАЧНЫХ" КУРЬЕРОВ
// ==========================================
// Каждые 5 минут проверяем базу: если курьер числится "is_online = true",
// но его нет в оперативной памяти (activeCouriers) ИЛИ его гео-пинг старше 1 часа,
// мы жестко переводим его в оффлайн в базе данных.
setInterval(async () => {
    try {
        const { data: onlineCouriers } = await supabase.from('couriers').select('id, is_online').eq('is_online', true);
        if (!onlineCouriers) return;

        const NOW = Date.now();
        const ONE_HOUR = 60 * 60 * 1000;

        for (const c of onlineCouriers) {
            const inCache = activeCouriers.get(c.id);
            // Если курьера нет в кэше вообще ИЛИ его геопозиция не обновлялась больше часа
            if (!inCache || (NOW - inCache.lastUpdate) > ONE_HOUR) {
                console.log(`🧹 [ОЧИСТКА] Курьер ${c.id} висит в БД как онлайн, но геопозиции нет (или она старая). Переводим в оффлайн!`);
                await supabase.from('couriers').update({ is_online: false }).eq('id', c.id);
                if (inCache) activeCouriers.delete(c.id);
            }
        }
    } catch (e) {
        console.error("Ошибка при фоновой очистке курьеров:", e.message);
    }
}, 5 * 60 * 1000); // 5 минут

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
            status: 'waiting_payment',
            dest_lat: dest_lat ? Number(dest_lat) : null,
            dest_lon: dest_lon ? Number(dest_lon) : null
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
// 2. ГЕНЕРАЦИЯ ПЛАТЕЖНОЙ ССЫЛКИ
// ==========================================
app.post('/api/create-paylink', async (req, res) => {
    try {
        const { amount, orderId } = req.body;
        const transactionID = "ORDER" + orderId; 

        const bakaiPayload = {
            amount: Number(amount),         
            transactionID: transactionID,   
            comment: `Oplata zakaza #${orderId}`, 
            redirectURL: "https://tamak-backend.onrender.com/success", 
            ttlUnits: 1,                    
            ttl: 15                         
        };

        const token = process.env.BAKAI_TOKEN;
        if (!token) return res.status(500).json({ error: "BAKAI_TOKEN не найден" });

        // ==========================================
        // ВРЕМЕННЫЙ ОБХОД БАКАЙ БАНКА ДЛЯ ТЕСТОВ
        // Если Бакай не работает, мы сами переводим заказ в paid и отправляем его дальше
        // ==========================================
        const MOCK_BAKAI = true; // Поставь false, когда починят Бакай

        if (MOCK_BAKAI) {
            console.log(`[ТЕСТ] Обход Бакай Банка для заказа #${orderId}`);
            
            // 1. Меняем статус на paid
            const { data: updatedOrders, error } = await supabase
                .from('orders')
                .update({ status: 'paid' })
                .eq('id', orderId)
                .select();

            if (!error && updatedOrders && updatedOrders.length > 0) {
                // 2. Отправляем админу/ресторану (имитируем вебхук)
                adminActions.sendOrderToAdmin(updatedOrders[0]);
            }

            // 3. Возвращаем клиенту сразу нашу страницу успеха
            return res.json({ 
                status: "success", 
                transactionID: transactionID, 
                bakaiResponse: { url: "https://tamak-backend.onrender.com/success" } 
            });
        }

        const response = await fetch('https://openbanking-api.bakai.kg/api/PayLink/CreatePayLink', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token.trim()}` 
            },
            body: JSON.stringify(bakaiPayload)
        });

        const textData = await response.text();
        if (!response.ok) return res.status(response.status).json({ error: textData || "Ошибка банка" });

        res.json({ status: "success", transactionID: transactionID, bakaiResponse: { url: textData } });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ==========================================
// 3. ЭКРАН УСПЕШНОЙ ОПЛАТЫ (ДЛЯ БАНКА)
// ==========================================
app.get('/success', (req, res) => {
    res.send('<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body style="display:flex;justify-content:center;align-items:center;height:100vh;font-family:sans-serif;background:#f0f8ff;text-align:center;margin:0;"><div><h1 style="color:#4CAF50;font-size:50px;margin:0;">✅</h1><h2>Оплата прошла успешно!</h2><p style="color:#555;">Пожалуйста, закройте это окно (нажмите крестик) и вернитесь в приложение TamakKG.</p></div></body></html>');
});

// ==========================================
// 4. ВЕБХУК ОТ БАНКА (АВТОМАТИЗАЦИЯ)
// ==========================================
app.post('/api/bakai-webhook', async (req, res) => {
    try {
        console.log("🔔 ВЕБХУК ОТ БАКАЙ БАНКА:", req.body);
        
        const incomingID = req.body.transactionID || req.body.operationID || req.body.TransactionId || req.body.OperationId;
        const status = req.body.status || req.body.Status || "SUCCESS";

        if (incomingID && (status.toUpperCase() === "SUCCESS" || status === "COMPLETED" || req.body.isPaid === true)) {
            
            // 🐛 Убираем "ORDER", чтобы сервер нашел ID в базе!
            const orderId = incomingID.replace("ORDER", "");

            const { data: existingOrder } = await supabase.from('orders').select('status').eq('id', orderId).single();

            // Если заказ ждал оплаты - переводим в paid и запускаем рассылку
            if (existingOrder && existingOrder.status === 'waiting_payment') {
                const { data: updatedOrders, error } = await supabase
                    .from('orders')
                    .update({ status: 'paid' })
                    .eq('id', orderId)
                    .select();

                if (!error && updatedOrders && updatedOrders.length > 0) {
                    // ТЕПЕРЬ ЗАКАЗ ТОЧНО УЛЕТИТ В РЕСТОРАН!
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
// ==========================================
// ГЕНЕРАЦИЯ ПЛАТЕЖНОЙ ССЫЛКИ ДЛЯ КУРЬЕРА (ФИКСИРОВАННАЯ СУММА)
// ==========================================
app.post('/api/generate-courier-paylink', async (req, res) => {
    try {
        const { amount, courierId } = req.body;
        
        // 👉 КЛЮЧЕВОЙ МОМЕНТ: Добавляем префикс COURIER к ID
        const transactionID = "COURIER" + courierId; 

        const bakaiPayload = {
            amount: Number(amount),         
            transactionID: transactionID,   
            comment: `Пополнение баланса курьера ${courierId}`, 
            // ВАЖНО: Замени "ТВОЙ_КУРЬЕРСКИЙ_БОТ" на реальный username (например, foodkg_courier_bot)
            redirectURL: "https://t.me/bizjumush_bot", 
            ttlUnits: 1,                    
            ttl: 15                         
        };

        const token = process.env.BAKAI_COURIER_TOKEN; // Твой новый токен для курьеров
        if (!token) return res.status(500).json({ error: "BAKAI_COURIER_TOKEN не найден" });

        const response = await fetch('https://openbanking-api.bakai.kg/api/PayLink/CreatePayLink', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token.trim()}` 
            },
            body: JSON.stringify(bakaiPayload)
        });

        // Бакай возвращает просто текст (ссылку)
        const textData = await response.text();
        if (!response.ok) return res.status(response.status).json({ error: textData || "Ошибка банка" });

        // Отправляем ссылку фронтенду
        res.json({ url: textData });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});
 // ==========================================
// ВЕБХУК БАКАЙ БАНКА (ПОПОЛНЕНИЕ БАЛАНСА КУРЬЕРА)
// ==========================================
app.post('/api/bakaicourier-webhook', async (req, res) => {
    try {
        console.log("🔔 ВЕБХУК ОТ БАКАЙ (КУРЬЕР):", req.body);
        
        const incomingID = req.body.transactionID || req.body.operationID || req.body.TransactionId || req.body.OperationId;
        const status = req.body.status || req.body.Status || "SUCCESS";
        // Важно: берем сумму, на которую курьер пополнил
        const paidAmount = Number(req.body.amount || req.body.Amount || req.body.totalAmount || 0);

        // 👉 Проверяем, что оплата успешна и это именно КУРЬЕРСКАЯ транзакция
        if (incomingID && incomingID.startsWith("COURIER") && 
           (status.toUpperCase() === "SUCCESS" || status === "COMPLETED" || req.body.isPaid === true)) {
            
            // 🐛 Убираем "COURIER", чтобы сервер нашел ID курьера в базе!
            const courierId = incomingID.replace("COURIER", "");

            // 1. Ищем текущий баланс курьера в БД
            const { data: courier } = await supabase.from('couriers').select('balance').eq('id', courierId).single();

            if (courier && paidAmount > 0) {
                // 2. Плюсуем баланс
                const newBalance = (courier.balance || 0) + paidAmount;
                
                await supabase
                    .from('couriers')
                    .update({ balance: newBalance })
                    .eq('id', courierId);

                console.log(`✅ БАЛАНС КУРЬЕРА ${courierId} УСПЕШНО ПОПОЛНЕН НА ${paidAmount} сом!`);

                // 3. Отправляем уведомление в бот
                try {
                    await courierBot.telegram.sendMessage(
                        courierId, 
                        `🎉 Баланс пополнен на ${paidAmount} сом.\n💳 Текущий баланс: ${newBalance} сом.\nЖирных заказов вам 🍔💸`
                    );
                } catch (e) {
                    console.error("❌ Не смогли отправить сообщение курьеру:", e.message);
                }
            }
        }
        res.status(200).json({ status: "ok" });
    } catch (err) {
        console.error("❌ Ошибка курьерского вебхука:", err);
        res.status(200).send("OK");
    }
});
// ==========================================
// 5. ПРОВЕРКА СТАТУСА ЗАКАЗА ДЛЯ ФРОНТЕНДА
// ==========================================
app.get('/api/check-status/:id', async (req, res) => {
    try {
        const { data, error } = await supabase.from('orders').select('status').eq('id', req.params.id).single();
        if (error) throw error;
        res.json({ status: data.status });
    } catch (err) {
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
    await Promise.all([launch(bot, 'ГЛАВНЫЙ БОТ (И АДМИН)'), launch(courierBot, 'КУРЬЕР'), launch(restBot, 'РЕСТОРАН')]);
};
startBots();