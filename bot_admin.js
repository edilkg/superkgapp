const { Markup } = require('telegraf');

module.exports = function setupAdminBot(adminBot, restBot, courierBot, supabase, ADMIN_GROUP_ID) {
    
    // ==========================================
    // 1. КНОПКА: ОДОБРИТЬ ОПЛАТУ ЗАКАЗА
    // ==========================================
    adminBot.action(/approve_order_(.+)/, async (ctx) => {
        const orderId = ctx.match[1].trim(); 
        console.log(`[АДМИН] Нажата кнопка Оплата получена для заказа: #${orderId}`);
        
        try {
            await ctx.answerCbQuery("Одобряем...").catch(() => {});

            const { data: order, error: fetchErr } = await supabase.from('orders').select('*').eq('id', orderId).maybeSingle();
            if (fetchErr || !order) return ctx.answerCbQuery("❌ Заказ не найден", { show_alert: true }).catch(() => {});

            if (order.status === 'paid') {
                return ctx.answerCbQuery("⚠️ Этот заказ уже одобрен!", { show_alert: true }).catch(() => {});
            }

            await supabase.from('orders').update({ status: 'paid' }).eq('id', orderId);

            const buttons = [];
            const cid = order.client_id;
            if (cid && String(cid) !== '111' && String(cid) !== 'null' && String(cid) !== 'undefined') {
                buttons.push([Markup.button.url("💬 Написать клиенту", `tg://user?id=${cid}`)]);
            }

            await ctx.editMessageText(
                `✅ ЗАКАЗ #${String(orderId).slice(0,5)} ОДОБРЕН (Оплата получена)\nРесторан: ${order.restaurant || 'Не указан'}\nСумма: ${order.total_price} сом`, 
                Markup.inlineKeyboard(buttons)
            ).catch(() => {});

            // 👉 ОТПРАВКА В РЕСТОРАН (С СИСТЕМОЙ ОПОВЕЩЕНИЯ АДМИНА)
            if (order.restaurant) {
                // Используем ilike вместо eq для игнорирования регистра букв (MAX BURGER == Max Burger)
                const { data: restData, error: restErr } = await supabase.from('restaurants').select('id, name, is_approved').ilike('name', order.restaurant).maybeSingle();
                
                if (restErr) {
                    await ctx.reply(`❌ Ошибка БД при поиске ресторана: ${restErr.message}`);
                } else if (!restData) {
                    await ctx.reply(`⚠️ ВНИМАНИЕ: Ресторан "${order.restaurant}" не найден в базе данных! Бот не смог переслать им этот заказ.`);
                } else if (!restData.is_approved) {
                    await ctx.reply(`⚠️ ВНИМАНИЕ: Ресторан "${order.restaurant}" не прошел модерацию (is_approved = false). Заказ не отправлен!`);
                } else {
                    let itemsArr = [];
                    try { itemsArr = Array.isArray(order.items) ? order.items : JSON.parse(order.items || '[]'); } catch(e) {}
                    
                    // ЗАЩИТА ОТ КРАША ТЕЛЕГРАМА (Экранируем < и >)
                    const itemsText = itemsArr.map(i => {
                        const name = i.item ? i.item.name : i.name;
                        return `▫️ ${name.replace(/</g, '&lt;').replace(/>/g, '&gt;')} x${i.count}`;
                    }).join('\n');
                    
                    const clientName = (order.client_name || 'Гость').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                    const clientPhone = order.phone || 'Не указан';
                    
                    let msgRest = `🍔 НОВЫЙ ЗАКАЗ <b>#${String(orderId).slice(0,5)}</b>\n\n👤 Клиент: <b>${clientName}</b>\n📞 Телефон: ${clientPhone}\n\n🛒 Заказ:\n${itemsText}\n\n💰 Сумма: ${order.total_price} сом`;
                    
                    await restBot.telegram.sendMessage(restData.id, msgRest, {
                        parse_mode: 'HTML',
                        ...Markup.inlineKeyboard([
                            [Markup.button.callback('✅ Принять', `rest_accept_${orderId}`)],
                            [Markup.button.callback('❌ Отклонить', `rest_decline_${orderId}`)]
                        ])
                    }).catch(async (e) => {
                        // ЕСЛИ ВЫДАСТ ОШИБКУ (НАПРИМЕР ФЕЙК ID 101), АДМИН СРАЗУ УЗНАЕТ!
                        console.error("Ошибка отправки в ресторан:", e.message);
                        await ctx.reply(`❌ Ошибка отправки заказа в ресторан "${order.restaurant}".\nПричина: ${e.message}\n(Возможно это фейковый ID типа 101 или бот заблокирован)`);
                    });
                }
            }

            // ОТПРАВКА КУРЬЕРАМ
            // ==========================================
            // ОТПРАВКА КУРЬЕРАМ (ТОЛЬКО ЦЕНА ЗА ДОСТАВКУ)
            // ==========================================
            const { data: couriers } = await supabase.from('couriers').select('id').eq('status', 'active');
            if (couriers && couriers.length > 0) {
                let itemsArr = [];
                try { itemsArr = Array.isArray(order.items) ? order.items : JSON.parse(order.items || '[]'); } catch(e) {}
                
                // Считаем чистую стоимость еды в заказе
                let foodPrice = 0;
                itemsArr.forEach(i => {
                    const price = Number(i.price || (i.item ? i.item.price : 0)) || 0;
                    const count = Number(i.count) || 0;
                    foodPrice += price * count;
                });

                // Вычитаем еду из общей суммы, чтобы получить чистую стоимость доставки
                const deliveryPrice = Math.max(0, (order.total_price || 0) - foodPrice);

                let msgCourier = `🔥 НОВЫЙ ЗАКАЗ #${String(orderId).slice(0,5)}!\n\n🏢 Ресторан: ${order.restaurant || 'Не указан'}\n📍 Куда: ${order.address}\n💬 Детали: ${order.comment || 'Нет'}\n💰 Доставка: ${deliveryPrice} сом\n\nКто заберет?`;
                
                for (const courier of couriers) {
                    try {
                        await courierBot.telegram.sendMessage(courier.id, msgCourier, Markup.inlineKeyboard([
                            [Markup.button.callback('🙋‍♂️ Я возьму', `courier_take_${orderId}`)]
                        ]));
                    } catch (e) {}
                }
            }

            if (cid && String(cid) !== '111' && String(cid) !== 'null' && String(cid) !== 'undefined') {
                try { await adminBot.telegram.sendMessage(cid, `✅ Ваша оплата поступила!\nЗаказ передан ресторану и курьеру 👨‍🍳🛵`); } catch(e){}
            }

        } catch (err) {
            console.error("❌ ОШИБКА ПРИ ОДОБРЕНИИ ЗАКАЗА:", err);
            try { await ctx.answerCbQuery("❌ Ошибка сервера").catch(() => {}); } catch(e){}
        }
    });

    // ==========================================
    // 2. КНОПКА: ОТКЛОНИТЬ ОПЛАТУ
    // ==========================================
    adminBot.action(/reject_order_(.+)/, async (ctx) => {
        const orderId = ctx.match[1].trim();
        try {
            await ctx.answerCbQuery("Отклоняем...").catch(() => {});

            const { data: order } = await supabase.from('orders').select('*').eq('id', orderId).maybeSingle();
            if (!order) return;

            // Защита от двойного нажатия
            if (order.status === 'canceled') {
                return ctx.answerCbQuery("⚠️ Заказ уже отменен!", { show_alert: true }).catch(() => {});
            }

            await supabase.from('orders').update({ status: 'canceled' }).eq('id', orderId);
            
            const buttons = [];
            const cid = order.client_id;
            if (cid && String(cid) !== '111' && String(cid) !== 'null' && String(cid) !== 'undefined') {
                buttons.push([Markup.button.url("💬 Написать клиенту", `tg://user?id=${cid}`)]);
                try { await adminBot.telegram.sendMessage(cid, `❌ Ваш заказ отменен. Оплата не поступила.`); } catch(e){}
            }

            await ctx.editMessageText(`❌ Заказ #${String(orderId).slice(0,5)} ОТКЛОНЕН (Денег нет)`, Markup.inlineKeyboard(buttons)).catch(() => {});
            
        } catch (err) {
            console.error("❌ Ошибка при отклонении:", err);
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
        ).catch(() => {});
        try { await courierBot.telegram.sendMessage(id, "🎉 Твоя заявка одобрена! Напиши /start, чтобы увидеть кабинет."); } catch(e){}
    });

    adminBot.action(/approve_rest_(.+)/, async (ctx) => {
        const restId = ctx.match[1];
        await supabase.from('restaurants').update({ is_approved: true }).eq('id', restId);
        await ctx.editMessageText(`✅ Ресторан ${restId} одобрен!`).catch(() => {});
        try { await restBot.telegram.sendMessage(restId, "🎉 Поздравляем! Ваш ресторан одобрен. Теперь вы можете принимать заказы."); } catch(e){}
    });

    adminBot.action(/add_balance_(.+)_(.+)/, async (ctx) => {
        const id = ctx.match[1];
        const amount = parseInt(ctx.match[2]);
        const { data: c } = await supabase.from('couriers').select('balance').eq('id', id).single();
        const newBalance = (c.balance || 0) + amount;
        await supabase.from('couriers').update({ balance: newBalance }).eq('id', id);
        await ctx.answerCbQuery(`Баланс пополнен!`).catch(() => {});
        await ctx.editMessageText(`💰 Баланс курьера ${id} обновлен: ${newBalance} сом.`).catch(() => {});
        try { await courierBot.telegram.sendMessage(id, `💰 Ваш баланс пополнен на ${amount} сом!\nТекущий баланс: ${newBalance} сом.`); } catch(e){}
    });

    return {
        sendOrderToAdmin: async (orderData) => {
            try {
                const itemsArr = Array.isArray(orderData.items) ? orderData.items : (JSON.parse(orderData.items || '[]'));
                const itemsText = itemsArr.map(i => {
                    const name = i.item ? i.item.name : i.name;
                    return `▫️ ${name} x${i.count}`;
                }).join('\n');
                
                const message = `🚨 НОВЫЙ ЗАКАЗ НА ПРОВЕРКУ ОПЛАТЫ!\nID: #${String(orderData.id).slice(0,5)}\n💰 Сумма: ${orderData.total_price} сом\n\n👤 Клиент: ${orderData.client_name || 'Гость'}\n📞 Телефон: ${orderData.phone || 'Не указан'}\n📍 Адрес: ${orderData.address || 'Не указан'}\n💬 Комментарий: ${orderData.comment || 'Нет'}\n\n🏢 Ресторан: ${orderData.restaurant || 'Не указан'}\n\n🛒 Блюда:\n${itemsText}`;

                const buttons = [
                    [Markup.button.callback("✅ Оплата получена", `approve_order_${orderData.id}`)],
                    [Markup.button.callback("❌ Оплаты нет", `reject_order_${orderData.id}`)]
                ];

                const cid = orderData.client_id;
                // ЗАЩИТА: Надежная проверка ID клиента
                if (cid && String(cid) !== '111' && String(cid) !== 'null' && String(cid) !== 'undefined') {
                    buttons.push([Markup.button.url("💬 Написать клиенту", `tg://user?id=${cid}`)]);
                }

                await adminBot.telegram.sendMessage(ADMIN_GROUP_ID, message, Markup.inlineKeyboard(buttons));
            } catch (err) {
                console.error("❌ ОШИБКА ОТПРАВКИ В АДМИНКУ:", err.message);
            }
        }
    };
};