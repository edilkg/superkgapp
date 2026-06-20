// bot_courier.js
const { Markup } = require('telegraf');

module.exports = function setupCourierBot(courierBot, clientBot, supabase, ADMIN_GROUP_ID) {
    
    // 1. СТАРТ И ПРОФИЛЬ
    courierBot.start(async (ctx) => {
        try {
            const id = ctx.from.id;
            const { data: courier } = await supabase.from('couriers').select('*').eq('id', id).maybeSingle();

            if (!courier) {
                await supabase.from('couriers').insert([{ id, name: ctx.from.first_name, status: 'waiting_approval', balance: 0 }]);
                ctx.reply("Привет! Заявка отправлена админу. Жди одобрения.");
                
                // ПРОСТО ОТПРАВЛЯЕМ УВЕДОМЛЕНИЕ АДМИНУ ЧЕРЕЗ ГЛАВНОГО БОТА (clientBot)
                return clientBot.telegram.sendMessage(ADMIN_GROUP_ID, 
                    `🛵 НОВАЯ ЗАЯВКА (КУРЬЕР)\nИмя: ${ctx.from.first_name}\nID: ${id}`,
                    Markup.inlineKeyboard([[Markup.button.callback('✅ ОДОБРИТЬ КУРЬЕРА', `approve_courier_${id}`)]])
                );
            }

            if (courier.status === 'waiting_approval') return ctx.reply("⏳ Твой аккаунт на проверке.");

            ctx.reply(`👤 ЛИЧНЫЙ КАБИНЕТ\n\nИмя: ${courier.name}\n💰 Баланс: ${courier.balance || 0} сом\nСтатус: На линии ✅`);
        } catch (e) { console.error(e); }
    });

    // 2. ПРИНЯТИЕ И ЗАВЕРШЕНИЕ ЗАКАЗА
    courierBot.action(/courier_take_(.+)/, async (ctx) => {
        const orderId = ctx.match[1];
        const { data: order } = await supabase.from('orders').select('*').eq('id', orderId).maybeSingle();

        if (!order || order.courier_id) return ctx.answerCbQuery("❌ Заказ уже занят.");

        await supabase.from('orders').update({ courier_id: ctx.from.id, status: 'delivery' }).eq('id', orderId);
        await ctx.editMessageText(`🚀 ЗАКАЗ В РАБОТЕ #${String(orderId).slice(0,5)}\n\n🏢 ${order.restaurant}\n📍 ${order.address}\n💰 ${order.total_price} сом`,
            Markup.inlineKeyboard([[Markup.button.callback('✅ ДОСТАВИЛ', `courier_done_${orderId}`)]])
        );
        if (order.client_id) clientBot.telegram.sendMessage(order.client_id, "🚀 Курьер забрал ваш заказ!");
    });

    courierBot.action(/courier_done_(.+)/, async (ctx) => {
        const orderId = ctx.match[1];
        await supabase.from('orders').update({ status: 'completed' }).eq('id', orderId);
        await ctx.editMessageText(`✅ Заказ выполнен!`);
        const { data: order } = await supabase.from('orders').select('client_id').eq('id', orderId).maybeSingle();
        if (order && order.client_id) clientBot.telegram.sendMessage(order.client_id, "😋 Приятного аппетита!");
    });

    console.log('📦 Модуль Courier загружен');
};