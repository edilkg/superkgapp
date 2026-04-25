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
                return courierBot.telegram.sendMessage(ADMIN_GROUP_ID, 
                    `🛵 НОВАЯ ЗАЯВКА (КУРЬЕР)\n\nИмя: ${ctx.from.first_name}\nID: ${id}`,
                    Markup.inlineKeyboard([[Markup.button.callback('✅ ОДОБРИТЬ КУРЬЕРА', `approve_courier_${id}`)]])
                );
            }

            if (courier.status === 'waiting_approval') {
                return ctx.reply("⏳ Твой аккаунт на проверке.");
            }

            // ГЛАВНОЕ МЕНЮ КУРЬЕРА
            ctx.reply(`👤 ЛИЧНЫЙ КАБИНЕТ\n\nИмя: ${courier.name}\n💰 Баланс: ${courier.balance || 0} сом\nСтатус: На линии ✅\n\nЖди новые заказы в этом чате!`);
        } catch (e) { console.error(e); }
    });

    // 2. ОДОБРЕНИЕ И УПРАВЛЕНИЕ БАЛАНСОМ (ДЛЯ АДМИНА)
    courierBot.action(/approve_courier_(.+)/, async (ctx) => {
        const id = ctx.match[1];
        await supabase.from('couriers').update({ status: 'active' }).eq('id', id);
        await ctx.editMessageText(`✅ Курьер ${id} одобрен!`, 
            Markup.inlineKeyboard([[Markup.button.callback('➕ Пополнить баланс (500с)', `add_balance_${id}_500`)]])
        );
        courierBot.telegram.sendMessage(id, "🎉 Твоя заявка одобрена! Напиши /start, чтобы увидеть кабинет.");
    });

    // Кнопка быстрого пополнения для админа
    courierBot.action(/add_balance_(.+)_(.+)/, async (ctx) => {
        const id = ctx.match[1];
        const amount = parseInt(ctx.match[2]);
        
        const { data: c } = await supabase.from('couriers').select('balance').eq('id', id).single();
        const newBalance = (c.balance || 0) + amount;
        
        await supabase.from('couriers').update({ balance: newBalance }).eq('id', id);
        await ctx.answerCbQuery(`Баланс курьера пополнен на ${amount}с!`);
        await ctx.editMessageText(`💰 Баланс курьера ${id} обновлен: ${newBalance} сом.`);
        
        courierBot.telegram.sendMessage(id, `💰 Ваш баланс пополнен на ${amount} сом!\nТекущий баланс: ${newBalance} сом.`);
    });

    // 3. ПРИНЯТИЕ И ЗАВЕРШЕНИЕ ЗАКАЗА (ОСТАВЛЯЕМ БЕЗ ИЗМЕНЕНИЙ)
    courierBot.action(/courier_take_(.+)/, async (ctx) => {
        const orderId = ctx.match[1];
        const { data: order } = await supabase.from('orders').select('*').eq('id', orderId).maybeSingle();

        if (!order || order.courier_id) return ctx.answerCbQuery("❌ Заказ уже занят.");

        await supabase.from('orders').update({ courier_id: ctx.from.id, status: 'delivery' }).eq('id', orderId);
        await ctx.editMessageText(`🚀 ЗАКАЗ В РАБОТЕ #${String(orderId).slice(0,5)}\n\n🏢 ${order.restaurant}\n📍 ${order.address}\n💰 ${order.total_price} сом`,
            Markup.inlineKeyboard([[Markup.button.callback('✅ ДОСТАВИЛ', `courier_done_${orderId}`)]])
        );
        if (order.client_id) clientBot.telegram.sendMessage(order.client_id, "🚀 Курьер принял ваш заказ!");
    });

    courierBot.action(/courier_done_(.+)/, async (ctx) => {
        const orderId = ctx.match[1];
        await supabase.from('orders').update({ status: 'completed' }).eq('id', orderId);
        await ctx.editMessageText(`✅ Заказ выполнен!`);
        const { data: order } = await supabase.from('orders').select('client_id').eq('id', orderId).maybeSingle();
        if (order && order.client_id) clientBot.telegram.sendMessage(order.client_id, "😋 Приятного аппетита!");
    });

    console.log('📦 Модуль Courier обновлен');
};