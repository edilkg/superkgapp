require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const setupClientBot = require('./bot_client');
const setupCourierBot = require('./bot_courier');
const setupRestaurantBot = require('./bot_restaurant');

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

app.post('/web-data', async (req, res) => {
    try {
        const { type, user, address, restaurantName, totalPrice, comment, items } = req.body;
        if (type !== 'food') return res.status(400).json({ error: 'Тип не еда' });

        const itemsText = items.map(i => `▫️ ${i.item.name} x${i.count}`).join('\n');

        const { data: orderData, error: dbError } = await supabase.from('orders').insert([{
            client_id: user?.id || null,
            client_name: user?.first_name || 'Гость',
            address: address,
            restaurant: restaurantName,
            total_price: totalPrice,
            comment: comment || '',
            items: items,
            status: 'new'
        }]).select();

        if (dbError) throw dbError;
        const orderId = orderData[0].id;

        const { data: restData } = await supabase.from('restaurants').select('id').eq('name', restaurantName).eq('is_approved', true).maybeSingle();

        if (restData && restData.id) {
            // 1. ПУШ РЕСТОРАНУ
            let msgRest = `🍔 НОВЫЙ ЗАКАЗ #${String(orderId).slice(0,5)}\n\n${itemsText}\n\nСумма: ${totalPrice} сом`;
            await restBot.telegram.sendMessage(restData.id, msgRest, Markup.inlineKeyboard([
                [Markup.button.callback('✅ Принять', `rest_accept_${orderId}`)],
                [Markup.button.callback('❌ Отклонить', `rest_decline_${orderId}`)]
            ]));

            // 2. ПЕРСОНАЛЬНЫЙ ПУШ ВСЕМ ОДОБРЕННЫМ КУРЬЕРАМ
            const { data: couriers } = await supabase.from('couriers').select('id').eq('status', 'active');
            
            if (couriers && couriers.length > 0) {
                let msgCourier = `🔥 НОВЫЙ ЗАКАЗ #${String(orderId).slice(0,5)}!\n\n🏢 Ресторан: ${restaurantName}\n📍 Куда: ${address}\n💰 Оплата: ${totalPrice} сом\n\nКто заберет?`;
                
                for (const courier of couriers) {
                    try {
                        await courierBot.telegram.sendMessage(courier.id, msgCourier, Markup.inlineKeyboard([
                            [Markup.button.callback('🏃‍♂️ Я ЗАБЕРУ!', `courier_take_${orderId}`)]
                        ]));
                    } catch (e) { console.log(`Не удалось отправить курьеру ${courier.id}`); }
                }
            } else {
                await bot.telegram.sendMessage(ADMIN_GROUP_ID, `⚠️ Заказ #${orderId}: Нет свободных курьеров на линии!`);
            }

        } else {
            await bot.telegram.sendMessage(ADMIN_GROUP_ID, `⚠️ Ресторан "${restaurantName}" не найден или не одобрен!`);
        }

        res.status(200).json({ success: true, orderId });
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
    await Promise.all([launch(bot, 'КЛИЕНТ'), launch(courierBot, 'КУРЬЕР'), launch(restBot, 'РЕСТОРАН')]);
};
startBots();