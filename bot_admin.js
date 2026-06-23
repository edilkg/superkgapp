const { Markup } = require('telegraf');

module.exports = function setupAdminBot(adminBot, restBot, courierBot, supabase, ADMIN_GROUP_ID) {
    
    // ==========================================
    // 1. КНОПКА: ОДОБРИТЬ ОПЛАТУ ЗАКАЗА
    // ==========================================
    adminBot.action(/approve_order_(.+)/, async (ctx) => {
        const orderId = ctx.match[1].trim(); // Убираем случайные пробелы
        console.log(`[АДМИН] Нажата кнопка Оплата получена для заказа: #${orderId}`);
        
        try {
            // 1. Обновляем статус в базе
            const { error: updateErr } = await supabase.from('orders').update({ status: 'paid' }).eq('id', orderId);
            if (updateErr) throw updateErr;
            
            // 2. Получаем заказ
            const { data: order, error: fetchErr } = await supabase.from('orders').select('*').eq('id', orderId).maybeSingle();
            if (fetchErr || !order) return ctx.answerCbQuery("❌ Заказ не найден в базе", { show_alert: true });

            // 3. Сохраняем кнопку "Написать клиенту"
            const buttons = [];
            if (order.client_id && order.client_id != 111) {
                buttons.push([Markup.button.url("💬 Написать клиенту", `tg://user?id=${order.client_id}`)]);
            }

            // 4. Обновляем текст в админке
            await ctx.editMessageText(
                `✅ ЗАКАЗ #${String(orderId).slice(0,5)} ОДОБРЕН (Оплата получена)\nРесторан: ${order.restaurant || 'Не указан'}\nСумма: ${order.total_price} сом`, 
                Markup.inlineKeyboard(buttons)
            );

            // 5. БЕЗОПАСНАЯ отправка в ресторан
            if (order.restaurant) {
                const { data: restData } = await supabase.from('restaurants').select('id').eq('name', order.restaurant).eq('is_approved', true).maybeSingle();
                if (restData) {
                    let itemsArr = [];
                    try { itemsArr = Array.isArray(order.items) ? order.items : JSON.parse(order.items || '[]'); } catch(e) {}
                    
                    const itemsText = itemsArr.map(i => {
                        const name = i.item ? i.item.name : i.name;
                        return `▫️ ${name} x${i.count}`;
                    }).join('\n');
                    
                    let msgRest = `🍔 НОВЫЙ ЗАКАЗ #${String(orderId).slice(0,5)}\n\n${itemsText}\n\nСумма: ${order.total_price} сом`;
                    await restBot.telegram.sendMessage(restData.id, msgRest, Markup.inlineKeyboard([
                        [Markup.button.callback('✅ Принять', `rest_accept_${orderId}`)],
                        [Markup.button.callback('❌ Отклонить', `rest_decline_${orderId}`)]
                    ])).catch(e => console.error("Ошибка отправки в ресторан:", e.message));
                }
            }

            // 6. Уведомляем курьеров
            const { data: couriers } = await supabase.from('couriers').select('id').eq('status', 'active');
            if (couriers && couriers.length > 0) {
                let msgCourier = `🔥 НОВЫЙ ЗАКАЗ #${String(orderId).slice(0,5)}!\n\n🏢 Ресторан: ${order.restaurant || 'Не указан'}\n📍 Куда: ${order.address}\n💰 Оплата: ${order.total_price} сом\n\nКто заберет?`;
                for (const courier of couriers) {
                    try {
                        await courierBot.telegram.sendMessage(courier.id, msgCourier, Markup.inlineKeyboard([
                            [Markup.button.callback('🙋‍♂️ Я возьму', `courier_take_${orderId}`)]
                        ]));
                    } catch (e) {}
                }
            }

            // 7. Уведомляем клиента
            if (order.client_id && order.client_id != 111) {
                try { await adminBot.telegram.sendMessage(order.client_id, `✅ Ваша оплата подтверждена! Заказ #${String(orderId).slice(0,5)} передан на кухню.`); } catch(e){}
            }

            await ctx.answerCbQuery("✅ Оплата подтверждена!");
            console.log(`[АДМИН] Заказ #${orderId} успешно передан дальше.`);

        } catch (err) {
            console.error("❌ ОШИБКА ПРИ ОДОБРЕНИИ ЗАКАЗА:", err);
            try { await ctx.answerCbQuery("❌ Системная ошибка", { show_alert: true }); } catch(e){}
        }
    });

    // ==========================================
    // 2. КНОПКА: ОТКЛОНИТЬ ОПЛАТУ
    // ==========================================
    adminBot.action(/reject_order_(.+)/, async (ctx) => {
        const orderId = ctx.match[1].trim();
        try {
            await supabase.from('orders').update({ status: 'canceled' }).eq('id', orderId);
            const { data: order } = await supabase.from('orders').select('*').eq('id', orderId).maybeSingle();
            
            const buttons = [];
            if (order && order.client_id && order.client_id != 111) {
                buttons.push([Markup.button.url("💬 Написать клиенту", `tg://user?id=${order.client_id}`)]);
                try { await adminBot.telegram.sendMessage(order.client_id, `❌ Ваш заказ отменен, так как мы не получили оплату.`); } catch(e){}
            }

            await ctx.editMessageText(`❌ Заказ #${String(orderId).slice(0,5)} ОТКЛОНЕН (Денег нет)`, Markup.inlineKeyboard(buttons));
            await ctx.answerCbQuery("❌ Заказ отменен!");
        } catch (err) {
            console.error("❌ Ошибка при отклонении:", err);
            try { await ctx.answerCbQuery("❌ Системная ошибка", { show_alert: true }); } catch(e){}
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

    // ВОЗВРАЩАЕМ ФУНКЦИЮ ДЛЯ ОТПРАВКИ ЗАКАЗА АДМИНУ
    return {
        sendOrderToAdmin: async (orderData) => {
            try {
                const itemsArr = Array.isArray(orderData.items) ? orderData.items : (JSON.parse(orderData.items || '[]'));
                const itemsText = itemsArr.map(i => {
                    const name = i.item ? i.item.name : i.name;
                    return `▫️ ${name} x${i.count}`;
                }).join('\n');
                
                const message = `🚨 НОВЫЙ ЗАКАЗ НА ПРОВЕРКУ ОПЛАТЫ!\nID: #${String(orderData.id).slice(0,5)}\n💰 Сумма: ${orderData.total_price} сом\n\n👤 Клиент: ${orderData.client_name || 'Гость'} (TG ID: ${orderData.client_id || 'Нет'})\n📞 Телефон: ${orderData.phone || 'Не указан'}\n📍 Адрес: ${orderData.address || 'Не указан'}\n💬 Комментарий: ${orderData.comment || 'Нет'}\n\n🏢 Ресторан: ${orderData.restaurant || 'Не указан'}\n\n🛒 Блюда:\n${itemsText}`;

                const buttons = [
                    [Markup.button.callback("✅ Оплата получена", `approve_order_${orderData.id}`)],
                    [Markup.button.callback("❌ Оплаты нет", `reject_order_${orderData.id}`)]
                ];

                if (orderData.client_id && orderData.client_id != 111) {
                    buttons.push([Markup.button.url("💬 Написать клиенту", `tg://user?id=${orderData.client_id}`)]);
                }

                await adminBot.telegram.sendMessage(ADMIN_GROUP_ID, message, Markup.inlineKeyboard(buttons));
            } catch (err) {
                console.error("❌ ОШИБКА ОТПРАВКИ В АДМИНКУ:", err.message);
            }
        }
    };
};