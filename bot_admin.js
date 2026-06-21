const { Markup } = require('telegraf');

module.exports = function setupAdminBot(adminBot, restBot, courierBot, supabase, ADMIN_GROUP_ID) {
    
    // ==========================================
    // 1. КНОПКА: ОДОБРИТЬ ОПЛАТУ ЗАКАЗА
    // ==========================================
    adminBot.action(/approve_order_(.+)/, async (ctx) => {
        const orderId = ctx.match[1];
        
        const { data: order } = await supabase.from('orders').select('*').eq('id', orderId).maybeSingle();
        if (!order) return ctx.answerCbQuery("❌ Заказ не найден");

        await ctx.editMessageText(`✅ ЗАКАЗ #${String(orderId).slice(0,5)} ОДОБРЕН (Оплата получена)\nРесторан: ${order.restaurant}\nСумма: ${order.total_price} сом`);

        // Отправляем в ресторан
        const { data: restData } = await supabase.from('restaurants').select('id').eq('name', order.restaurant).eq('is_approved', true).maybeSingle();
        if (restData) {
            const itemsText = order.items.map(i => `▫️ ${i.item.name} x${i.count}`).join('\n');
            let msgRest = `🍔 НОВЫЙ ЗАКАЗ #${String(orderId).slice(0,5)}\n\n${itemsText}\n\nСумма: ${order.total_price} сом`;
            await restBot.telegram.sendMessage(restData.id, msgRest, Markup.inlineKeyboard([
                [Markup.button.callback('✅ Принять', `rest_accept_${orderId}`)],
                [Markup.button.callback('❌ Отклонить', `rest_decline_${orderId}`)]
            ]));
        }

        // Отправляем курьерам
        const { data: couriers } = await supabase.from('couriers').select('id').eq('status', 'active');
        if (couriers && couriers.length > 0) {
            let msgCourier = `🔥 НОВЫЙ ЗАКАЗ #${String(orderId).slice(0,5)}!\n\n🏢 Ресторан: ${order.restaurant}\n📍 Куда: ${order.address}\n💰 Оплата: ${order.total_price} сом\n\nКто заберет?`;
            for (const courier of couriers) {
                try {
                    await courierBot.telegram.sendMessage(courier.id, msgCourier, Markup.inlineKeyboard([
                        [Markup.button.callback('🏃‍♂️ Я ЗАБЕРУ!', `courier_take_${orderId}`)]
                    ]));
                } catch (e) {}
            }
        }

        // Уведомляем клиента
        if (order.client_id) {
            try { await adminBot.telegram.sendMessage(order.client_id, `✅ Ваша оплата подтверждена! Заказ #${String(orderId).slice(0,5)} передан на кухню.`); } catch(e){}
        }
    });

    // ==========================================
    // 2. КНОПКА: ОТКЛОНИТЬ ОПЛАТУ
    // ==========================================
    adminBot.action(/reject_order_(.+)/, async (ctx) => {
        const orderId = ctx.match[1];
        await supabase.from('orders').update({ status: 'canceled' }).eq('id', orderId);
        await ctx.editMessageText(`❌ Заказ #${String(orderId).slice(0,5)} ОТКЛОНЕН (Денег нет)`);
        
        const { data: order } = await supabase.from('orders').select('client_id').eq('id', orderId).maybeSingle();
        if (order && order.client_id) {
            try { await adminBot.telegram.sendMessage(order.client_id, `❌ Ваш заказ отменен, так как мы не получили оплату.`); } catch(e){}
        }
    });

    // ==========================================
    // 3. ОДОБРЕНИЕ КУРЬЕРОВ И РЕСТОРАНОВ
    // ==========================================
    adminBot.action(/approve_courier_(.+)/, async (ctx) => {
        const id = ctx.match[1];
        await supabase.from('couriers').update({ status: 'active' }).eq('id', id);
        await ctx.editMessageText(`✅ Курьер ${id} одобрен!`, 
            Markup.inlineKeyboard([[Markup.button.callback('➕ Пополнить баланс (500с)', `add_balance_${id}_500`)]])
        );
        try { await courierBot.telegram.sendMessage(id, "🎉 Твоя заявка одобрена! Напиши /start, чтобы увидеть кабинет."); } catch(e){}
    });

    adminBot.action(/approve_rest_(.+)/, async (ctx) => {
        const restId = ctx.match[1];
        await supabase.from('restaurants').update({ is_approved: true }).eq('id', restId);
        await ctx.editMessageText(`✅ Ресторан ${restId} одобрен!`);
        try { await restBot.telegram.sendMessage(restId, "🎉 Поздравляем! Ваш ресторан одобрен. Теперь вы можете принимать заказы."); } catch(e){}
    });

    adminBot.action(/add_balance_(.+)_(.+)/, async (ctx) => {
        const id = ctx.match[1];
        const amount = parseInt(ctx.match[2]);
        const { data: c } = await supabase.from('couriers').select('balance').eq('id', id).single();
        const newBalance = (c.balance || 0) + amount;
        await supabase.from('couriers').update({ balance: newBalance }).eq('id', id);
        await ctx.answerCbQuery(`Баланс курьера пополнен!`);
        await ctx.editMessageText(`💰 Баланс курьера ${id} обновлен: ${newBalance} сом.`);
        try { await courierBot.telegram.sendMessage(id, `💰 Ваш баланс пополнен на ${amount} сом!\nТекущий баланс: ${newBalance} сом.`); } catch(e){}
    });

    console.log('🛡️ Модуль Admin загружен');

    // ВОЗВРАЩАЕМ ФУНКЦИЮ ДЛЯ ОТПРАВКИ ЗАКАЗА АДМИНУ
    return {
        sendOrderToAdmin: async (orderData) => {
            try {
                const itemsText = orderData.items.map(i => `▫️ ${i.item.name} x${i.count}`).join('\n');
                
                const message = `🚨 НОВЫЙ ЗАКАЗ НА ПРОВЕРКУ ОПЛАТЫ!
ID: #${String(orderData.id).slice(0,5)}
💰 Сумма: ${orderData.total_price} сом
👤 Клиент: ${orderData.client_name || 'Гость'} (TG ID: ${orderData.client_id || 'Нет'})
📞 Телефон: ${orderData.phone || 'Не указан'}
📍 Адрес: ${orderData.address || 'Не указан'}
💬 Комментарий: ${orderData.comment || 'Нет'}
🏢 Ресторан: ${orderData.restaurant}
🛒 Блюда:
${itemsText}`;

                const buttons = [
                    [Markup.button.callback("✅ Оплата получена", `approve_order_${orderData.id}`)],
                    [Markup.button.callback("❌ Оплаты нет", `reject_order_${orderData.id}`)]
                ];

                if (orderData.client_id) {
                    buttons.push([Markup.button.url("💬 Написать клиенту", `tg://user?id=${orderData.client_id}`)]);
                }

                await adminBot.telegram.sendMessage(ADMIN_GROUP_ID, message, Markup.inlineKeyboard(buttons));
                console.log(`✅ Заказ #${orderData.id} успешно отправлен в группу админов!`);
            } catch (err) {
                console.error("❌ ОШИБКА ОТПРАВКИ В TG-ГРУППУ:", err.message);
            }
        }
    };
};