const { Markup } = require('telegraf');

module.exports = function setupAdminBot(adminBot, restBot, courierBot, supabase, ADMIN_GROUP_ID) {
    
    // ==========================================
    // 1. КНОПКА: ОДОБРИТЬ ОПЛАТУ ЗАКАЗА (ЕДИНАЯ ЛОГИКА)
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

            // 1. Меняем статус в БД
            await supabase.from('orders').update({ status: 'paid' }).eq('id', orderId);

            // 2. Уведомляем клиента и сохраняем кнопку для админа
            const buttons = [];
            const cid = order.client_id;
            if (cid && String(cid) !== '111' && String(cid) !== 'null' && String(cid) !== 'undefined') {
                // Добавляем кнопку связи с клиентом в новый массив кнопок (Остальные кнопки сотрутся)
                buttons.push([Markup.button.url("💬 Написать клиенту", `tg://user?id=${cid}`)]);
                
                try { 
                    await adminBot.telegram.sendMessage(
                        cid, 
                        `✅ <b>Оплата успешно получена!</b>\n\nВаш заказ <b>#${String(orderId).slice(0,5)}</b> передан в ресторан и курьеру🚀`, 
                        { parse_mode: 'HTML' }
                    ); 
                } catch(e) {
                    console.error("Ошибка при отправке уведомления клиенту об оплате:", e);
                }
            }

            // 👉 3. ОБНОВЛЯЕМ СООБЩЕНИЕ АДМИНА (СОХРАНЯЕМ ВЕСЬ ТЕКСТ)
            const oldText = ctx.callbackQuery.message.text || '';
            let newText = '';
            
            // Если текст старый (от функции генерации) - заменяем заголовок
            if (oldText.includes('🚨 НОВЫЙ ЗАКАЗ')) {
                newText = oldText.replace(
                    '🚨 НОВЫЙ ЗАКАЗ НА ПРОВЕРКУ ОПЛАТЫ!', 
                    `✅ ЗАКАЗ #${String(orderId).slice(0,5)} ОДОБРЕН (Оплата получена)`
                );
            } else {
                // Если вдруг старый текст не прочитался (подстраховка от крашей)
                let addressSuffix = '';
                if (order.comment && order.comment.includes('🏪 Адрес ресторана:')) {
                    const parts = order.comment.split(' | ');
                    const addrPart = parts.find(p => p.includes('🏪 Адрес ресторана:'));
                    if (addrPart) {
                        addressSuffix = ` (${addrPart.replace('🏪 Адрес ресторана:', '').trim()})`;
                    }
                }
                const fullRestName = `${order.restaurant || 'Не указан'}${addressSuffix}`;
                newText = `✅ ЗАКАЗ #${String(orderId).slice(0,5)} ОДОБРЕН (Оплата получена)\n🏢 Ресторан: ${fullRestName}\n💰 Сумма: ${order.total_price} сом`;
            }

            // Применяем новый текст и НОВУЮ клавиатуру (без кнопок принятия/отклонения)
            await ctx.editMessageText(newText, buttons.length > 0 ? Markup.inlineKeyboard(buttons) : undefined).catch(() => {});

            // 👉 4. ОТПРАВКА В РЕСТОРАН
            if (order.restaurant) {
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
                    
                    let foodOnlyTotal = 0;
                    itemsArr.forEach(i => {
                        const price = Number(i.price || (i.item ? i.item.price : 0)) || 0;
                        const count = Number(i.count) || 0;
                        foodOnlyTotal += price * count;
                    });

                    const itemsText = itemsArr.map(i => {
                        const name = i.item ? i.item.name : i.name;
                        return `▫️ ${name.replace(/</g, '&lt;').replace(/>/g, '&gt;')} x${i.count}`;
                    }).join('\n');
                    
                    const clientName = (order.client_name || 'Гость').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                    const clientPhone = order.phone || 'Не указан';
                    
                    let restDetails = 'Нет';
                    if (order.comment) {
                        const parts = order.comment.split(' | ');
                        const filteredParts = parts.filter(p => p.includes('🍴 Приборы') || p.includes('💬 Кухне'));
                        if (filteredParts.length > 0) {
                            restDetails = filteredParts.join(' | ');
                        }
                    }
                    
                    let msgRest = `🍔 НОВЫЙ ЗАКАЗ <b>#${String(orderId).slice(0,5)}</b>\n\n` +
                                  `👤 Клиент: <b>${clientName}</b>\n` +
                                  `📞 Номер: ${clientPhone}\n` +
                                  `💬 Детали: <b>${restDetails}</b>\n\n` +
                                  `🛒 Заказ:\n${itemsText}\n\n` +
                                  `💰 Сумма: ${foodOnlyTotal} сом`; 
                    
                    await restBot.telegram.sendMessage(restData.id, msgRest, {
                        parse_mode: 'HTML',
                        ...Markup.inlineKeyboard([
                            [Markup.button.callback('✅ Принять', `rest_accept_${orderId}`)],
                            [Markup.button.callback('❌ Отклонить', `rest_decline_${orderId}`)]
                        ])
                    }).catch(async (e) => {
                        console.error("Ошибка отправки в ресторан:", e.message);
                        await ctx.reply(`❌ Ошибка отправки заказа в ресторан "${order.restaurant}".\nПричина: ${e.message}`);
                    });
                }
            }

            // 👉 5. ОТПРАВКА КУРЬЕРАМ В ОБЩУЮ ГРУППУ
            const COURIER_GROUP_ID = '-1004348705428'; 
            
            let courierItemsArr = [];
            try { courierItemsArr = Array.isArray(order.items) ? order.items : JSON.parse(order.items || '[]'); } catch(e) {}
            
            let foodPrice = 0;
            courierItemsArr.forEach(i => {
                const price = Number(i.price || (i.item ? i.item.price : 0)) || 0;
                const count = Number(i.count) || 0;
                foodPrice += price * count;
            });

            const deliveryPrice = Math.max(0, (order.total_price || 0) - foodPrice);

            let addressSuffixCourier = '';
            if (order.comment && order.comment.includes('🏪 Адрес ресторана:')) {
                const parts = order.comment.split(' | ');
                const addrPart = parts.find(p => p.includes('🏪 Адрес ресторана:'));
                if (addrPart) {
                    addressSuffixCourier = ` (${addrPart.replace('🏪 Адрес ресторана:', '').trim()})`;
                }
            }
            const fullRestNameCourier = `${order.restaurant || 'Не указан'}${addressSuffixCourier}`;

            let msgCourier = `🔥 НОВЫЙ ЗАКАЗ #${String(orderId).slice(0,5)}!\n\n` +
                             `🏢 Ресторан: <b>${fullRestNameCourier}</b>\n` + 
                             `💰 Доставка: <b>${deliveryPrice} сом</b>\n\n` +
                             `Кто заберет?`;
            
            try {
                await courierBot.telegram.sendMessage(COURIER_GROUP_ID, msgCourier, {
                    parse_mode: 'HTML',
                    ...Markup.inlineKeyboard([
                        [Markup.button.callback('🙋‍♂️ Я возьму', `courier_take_${orderId}`)]
                    ])
                });
            } catch (e) {
                console.error("❌ Ошибка отправки заказа в общую группу курьеров:", e);
            }

        } catch (err) {
            console.error("[АДМИН] Ошибка при одобрении заказа:", err);
            try { await ctx.answerCbQuery("❌ Произошла ошибка на сервере", { show_alert: true }); } catch(e){}
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

            if (order.status === 'canceled') {
                return ctx.answerCbQuery("⚠️ Заказ уже отменен!", { show_alert: true }).catch(() => {});
            }

            await supabase.from('orders').update({ status: 'canceled' }).eq('id', orderId);
            
            const buttons = [];
            const cid = order.client_id;
            if (cid && String(cid) !== '111' && String(cid) !== 'null' && String(cid) !== 'undefined') {
                buttons.push([Markup.button.url("💬 Написать клиенту", `tg://user?id=${cid}`)]);
                try { await adminBot.telegram.sendMessage(cid, `❌ Ваш заказ отменен. Оплата не поступила. Попробуйте снова. поддержка @foodkg_admin`); } catch(e){}
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
            Markup.inlineKeyboard([[Markup.button.callback('➕ Пополнить баланс (100)', `add_balance_${id}_100`)]])
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

    // ==========================================
    // 4. УМНАЯ КОМАНДА ДЛЯ ПОПОЛНЕНИЯ БАЛАНСА КУРЬЕРА
    // ==========================================
    adminBot.command('pay', async (ctx) => {
        if (ctx.chat.id.toString() !== ADMIN_GROUP_ID.toString()) return;
        
        const text = ctx.message.text.trim();
        const args = text.split(/\s+/);
        
        if (args.length < 3) {
            return ctx.reply("❌ Неверный формат!\nИспользуйте: /pay [Имя, Телефон или ID] [Сумма]");
        }
        
        const amount = parseInt(args.pop()); 
        if (isNaN(amount) || amount <= 0) return ctx.reply("❌ Сумма должна быть числом больше нуля!");

        const identifier = args.slice(1).join(' '); 
        const cleanSearchPhone = identifier.replace(/[\s\+\-\(\)]/g, ''); 

        try {
            const { data: couriers, error } = await supabase.from('couriers').select('id, name, phone, balance');
            if (error || !couriers) return ctx.reply("❌ Ошибка при поиске курьеров в базе.");

            const matched = couriers.filter(c => {
                const idStr = String(c.id);
                const nameStr = (c.name || '').toLowerCase();
                const phoneStr = (c.phone || '').replace(/[\s\+\-\(\)]/g, '');
                const searchStr = identifier.toLowerCase();

                return idStr === searchStr || 
                       nameStr.includes(searchStr) || 
                       (cleanSearchPhone.length >= 5 && phoneStr.includes(cleanSearchPhone));
            });

            if (matched.length === 0) {
                return ctx.reply(`❌ Курьер "${identifier}" не найден.\nПроверьте правильность написания имени или номера.`);
            }

            if (matched.length > 1) {
                let msg = `⚠️ Найдено несколько курьеров по запросу "${identifier}". Уточните, кому именно пополнить:\n\n`;
                matched.forEach(c => {
                    msg += `👤 ${c.name} | 📞 ${c.phone || 'Нет номера'} | ID: <code>${c.id}</code>\n`;
                });
                msg += `\nПожалуйста, скопируйте нужный ID или номер и повторите команду.`;
                return ctx.reply(msg, { parse_mode: 'HTML' });
            }

            const c = matched[0];
            const newBalance = (c.balance || 0) + amount;
            
            await supabase.from('couriers').update({ balance: newBalance }).eq('id', c.id);
            
            await ctx.reply(`✅ Баланс успешно пополнен!\n👤 Курьер: ${c.name}\n📞 Тел: ${c.phone || 'Нет'}\n💰 Зачислено: ${amount} сом\n💳 Текущий баланс: ${newBalance} сом.`);
            
            try { 
                await courierBot.telegram.sendMessage(c.id, `💰 Ваш баланс пополнен администратором на ${amount} сом!\n💳 Текущий баланс: ${newBalance} сом.\n\nУдачных доставок! 🛵`); 
            } catch(e) {
                console.error("Не удалось отправить сообщение курьеру", e);
            }

        } catch (err) {
            console.error("Ошибка при пополнении:", err);
            ctx.reply("❌ Произошла системная ошибка базы данных.");
        }
    });

    // 5. ОТПРАВКА ЗАКАЗА НА МОДЕРАЦИЮ АДМИНУ

    // ==========================================

    return {

        sendOrderToAdmin: async (orderData) => {

            try {

                const itemsArr = Array.isArray(orderData.items) ? orderData.items : (JSON.parse(orderData.items || '[]'));

                const itemsText = itemsArr.map(i => {

                    const name = i.item ? i.item.name : i.name;

                    return `▫️ ${name} x${i.count}`;

                }).join('\n');

               

                // 👉 НОВАЯ ЛОГИКА: Достаем адрес ресторана для самого первого сообщения админу

                let addressSuffix = '';

                let displayComment = orderData.comment || 'Нет';

               

                if (orderData.restaurantAddress) {

                    addressSuffix = ` (${orderData.restaurantAddress})`;

                    // Вырезаем адрес из комментариев, чтобы не дублировался

                    if (displayComment.includes('🏪 Адрес ресторана:')) {

                        displayComment = displayComment.split(' | ').filter(p => !p.includes('🏪 Адрес ресторана:')).join(' | ') || 'Нет';

                    }

                } else if (displayComment.includes('🏪 Адрес ресторана:')) {

                    const parts = displayComment.split(' | ');

                    const addrPart = parts.find(p => p.includes('🏪 Адрес ресторана:'));

                    if (addrPart) {

                        addressSuffix = ` (${addrPart.replace('🏪 Адрес ресторана:', '').trim()})`;

                        displayComment = parts.filter(p => !p.includes('🏪 Адрес ресторана:')).join(' | ') || 'Нет';

                    }

                }

                const fullRestName = `${orderData.restaurant || 'Не указан'}${addressSuffix}`;



                const message = `🚨 НОВЫЙ ЗАКАЗ НА ПРОВЕРКУ ОПЛАТЫ!\nID: #${String(orderData.id).slice(0,5)}\n💰 Сумма: ${orderData.total_price} сом\n\n👤 Клиент: ${orderData.client_name || 'Гость'}\n📞 Номер: ${orderData.phone || 'Не указан'}\n📍 Адрес: ${orderData.address || 'Не указан'}\n💬 Комментарий: ${displayComment}\n\n🏢 Ресторан: ${fullRestName}\n\n🛒 Блюда:\n${itemsText}`;



                const buttons = [

                    [Markup.button.callback("✅ Оплата получена", `approve_order_${orderData.id}`)],

                    [Markup.button.callback("❌ Оплаты нет", `reject_order_${orderData.id}`)]

                ];



                const cid = orderData.client_id;

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
