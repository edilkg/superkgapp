const { Markup } = require('telegraf');

module.exports = function setupAdminBot(adminBot, restBot, courierBot, supabase, ADMIN_GROUP_ID, activeCouriers = new Map(), dispatcher = null) {
    
    // ==========================================
    // 1. ОДОБРЕНИЕ КУРЬЕРОВ И РЕСТОРАНОВ
    // ==========================================
    adminBot.action(/approve_courier_(.+)/, async (ctx) => {
        const id = ctx.match[1];
        await ctx.answerCbQuery("✅ Курьер одобрен!").catch(() => {});
        await supabase.from('couriers').update({ status: 'active' }).eq('id', id);
        await ctx.editMessageText(`✅ Курьер ${id} одобрен!`, 
            Markup.inlineKeyboard([[Markup.button.callback('➕ Пополнить баланс (100)', `add_balance_${id}_100`)]])
        ).catch(() => {});

        const welcomeText = 
            `🎉 <b>Поздравляем! Ваша заявка одобрена!</b>\n\n` +
            `Вы зарегистрированы как курьер в TamakKG 🛵\n\n` +
            `📍 <b>Чтобы начать получать заказы:</b>\n` +
            `1. Нажмите кнопку <b>«🟢 Выйти на линию»</b> ниже.\n` +
            `2. Отправьте <b>трансляцию геопозиции</b> (скрепка 📎 ➡️ Геопозиция ➡️ Транслировать геопозицию на 8 часов).\n\n` +
            `После этого система зафиксирует вас на карте и будет направлять вам ближайшие заказы от ресторанов!`;

        try { 
            await courierBot.telegram.sendMessage(id, welcomeText, {
                parse_mode: 'HTML',
                ...Markup.keyboard([
                    ['🟢 Выйти на линию'],
                    ['👤 Профиль'],
                    [Markup.button.webApp('💳 Пополнить баланс', `https://superkgapp.vercel.app/courier_pay.html?id=${id}`)]
                ]).resize()
            }); 
        } catch(e) {
            console.error("Ошибка отправки приветствия курьеру:", e.message);
        }
    });

    adminBot.action(/approve_rest_(.+)/, async (ctx) => {
        const restId = ctx.match[1];
        await ctx.answerCbQuery("✅ Ресторан одобрен!").catch(() => {});
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
    // 2. УМНАЯ КОМАНДА ДЛЯ ПОПОЛНЕНИЯ БАЛАНСА КУРЬЕРА
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

    // ==========================================
    // 2.5. ПОВТОРНЫЙ ПОИСК И ОТМЕНА ПОДВИСШЕГО ЗАКАЗА
    // ==========================================
    adminBot.action(/retry_dispatch_(.+)/, async (ctx) => {
        const orderId = ctx.match[1].trim();
        await ctx.answerCbQuery("🔄 Запускаем повторный поиск курьера...").catch(() => {});

        try {
            if (!dispatcher) {
                return ctx.reply("❌ Диспетчер недоступен.");
            }

            const result = await dispatcher.retryDispatch(orderId);
            if (result.success) {
                const oldText = ctx.callbackQuery.message.text || '';
                await ctx.editMessageText(
                    `${oldText}\n\n🔄 <b>Повторный поиск запущен администратором!</b>\nСистема снова опрашивает курьеров рядом...`, 
                    { parse_mode: 'HTML' }
                ).catch(() => {});

                // Уведомляем ресторан
                try {
                    const { data: ord } = await supabase.from('orders').select('restaurant').eq('id', orderId).maybeSingle();
                    if (ord?.restaurant) {
                        const { data: r } = await supabase.from('restaurants').select('id').eq('name', ord.restaurant).maybeSingle();
                        if (r?.id) {
                            await restBot.telegram.sendMessage(r.id, `🔄 <i>Администратор перезапустил поиск курьера для заказа #${orderId.slice(0, 5)}</i>`, { parse_mode: 'HTML' });
                        }
                    }
                } catch(e) {}
            } else if (result.reason === 'already_taken') {
                await ctx.editMessageText(`✅ Заказ #${orderId.slice(0, 5)} уже взят курьером!`).catch(() => {});
            } else if (result.reason === 'invalid_status') {
                await ctx.editMessageText(`⚠️ Заказ #${orderId.slice(0, 5)} уже ${result.status === 'canceled' ? 'отменен' : 'завершен'}.`).catch(() => {});
            } else {
                await ctx.reply("⚠️ Не удалось перезапустить поиск курьера.");
            }
        } catch (e) {
            console.error("Ошибка при retry_dispatch в админке:", e.message);
        }
    });

    adminBot.action(/admin_cancel_order_(.+)/, async (ctx) => {
        const orderId = ctx.match[1].trim();
        await ctx.answerCbQuery("Отменяем заказ...").catch(() => {});

        try {
            const { data: order } = await supabase
                .from('orders')
                .select('*')
                .eq('id', orderId)
                .maybeSingle();

            if (!order) return;

            if (order.status === 'canceled') {
                return ctx.editMessageText(`⚠️ Заказ #${orderId.slice(0, 5)} уже был отменен ранее.`).catch(() => {});
            }

            if (['delivery', 'completed'].includes(order.status)) {
                return ctx.editMessageText(`❌ Невозможно отменить: заказ уже ${order.status === 'delivery' ? 'в пути у курьера' : 'доставлен'}!`).catch(() => {});
            }

            // Переводим заказ в canceled
            await supabase.from('orders').update({ status: 'canceled' }).eq('id', orderId);

            // Останавливаем сессию диспетчера
            if (dispatcher) {
                dispatcher.finishSession(orderId);
            }

            const oldText = ctx.callbackQuery.message.text || '';
            await ctx.editMessageText(
                `${oldText}\n\n❌ <b>ЗАКАЗ ОТМЕНЕН АДМИНИСТРАТОРОМ.</b>`, 
                { parse_mode: 'HTML' }
            ).catch(() => {});

            // Уведомляем клиента
            const cid = order.client_id;
            if (cid && String(cid) !== '111' && String(cid) !== 'null' && String(cid) !== 'undefined') {
                const clientMsg = `❌ <b>Заказ #${String(orderId).slice(0, 5)} отменен администрацией сервиса.</b>\n\n` +
                                  `К сожалению, поблизости не нашлось свободных курьеров для доставки.\n` +
                                  `Приносим извинения за неудобства! Поддержка: @foodkg_admin`;
                try {
                    await adminBot.telegram.sendMessage(cid, clientMsg, { parse_mode: 'HTML' });
                } catch(e) {}
            }

            // Уведомляем ресторан
            if (order.restaurant) {
                try {
                    const { data: r } = await supabase.from('restaurants').select('id').eq('name', order.restaurant).maybeSingle();
                    if (r?.id) {
                        await restBot.telegram.sendMessage(r.id, `❌ <i>Администратор отменил заказ #${orderId.slice(0, 5)} (курьер не найден).</i>`, { parse_mode: 'HTML' });
                    }
                } catch(e) {}
            }

        } catch (e) {
            console.error("Ошибка при admin_cancel_order в админке:", e.message);
        }
    });

    // ==========================================
    // 3. ОТПРАВКА ИНФО-ЧЕКА В АДМИНКУ И РАССЫЛКА ПО РЕСТОРАНАМ (АВТОМАТИЧЕСКАЯ)
    // ==========================================
    return {
        sendOrderToAdmin: async (orderData) => {
            try {
                const itemsArr = Array.isArray(orderData.items) ? orderData.items : (JSON.parse(orderData.items || '[]'));
                const itemsText = itemsArr.map(i => {
                    const name = i.item ? i.item.name : i.name;
                    return `▫️ ${name} x${i.count}`;
                }).join('\n');

                let addressSuffix = '';
                let displayComment = orderData.comment || 'Нет';

                if (orderData.restaurantAddress) {
                    addressSuffix = ` (${orderData.restaurantAddress})`;
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

                const message = `✅ ОПЛАЧЕННЫЙ ЗАКАЗ В РАБОТЕ!\nID: #${String(orderData.id).slice(0,5)}\n💰 Сумма: ${orderData.total_price} сом\n\n👤 Клиент: ${orderData.client_name || 'Гость'}\n📞 Номер: ${orderData.phone || 'Не указан'}\n📍 Адрес: ${orderData.address || 'Не указан'}\n💬 Комментарий: ${displayComment}\n\n🏢 Ресторан: ${fullRestName}\n\n🛒 Блюда:\n${itemsText}`;

                const buttons = [];
                const cid = orderData.client_id;
                if (cid && String(cid) !== '111' && String(cid) !== 'null' && String(cid) !== 'undefined') {
                    buttons.push([Markup.button.url("💬 Написать клиенту", `tg://user?id=${cid}`)]);
                }

                await adminBot.telegram.sendMessage(ADMIN_GROUP_ID, message, Markup.inlineKeyboard(buttons));

                // 1. Отправляем в ресторан
                try {
                    const { data: restData } = await supabase
                        .from('restaurants')
                        .select('id')
                        .eq('name', orderData.restaurant)
                        .maybeSingle();

                    if (restData && restData.id) {
                        const orderTextForRest = `🔥 <b>НОВЫЙ ОПЛАЧЕННЫЙ ЗАКАЗ #${orderData.id}</b>\n\nБлюда:\n${itemsText}\n\nСумма: ${orderData.total_price} сом\nКомментарий: ${displayComment}`;
                        
                        await restBot.telegram.sendMessage(restData.id, orderTextForRest, {
                            parse_mode: 'HTML',
                            reply_markup: {
                                inline_keyboard: [[
                                    { text: "👨‍🍳 Принять и начать готовить", callback_data: `rest_accept_${orderData.id}` }
                                ]]
                            }
                        });
                    }
                } catch (e) {
                    console.error("❌ Ошибка отправки в ресторан:", e.message);
                }

                // 2. ОДНОВРЕМЕННО ОТПРАВЛЯЕМ КУРЬЕРУ (УМНЫЙ ДИСПЕТЧЕР)
                // Не ждем пока повар приготовит! Курьер уже должен ехать к ресторану!
                try {
                    let restCoords = null;
                    if (orderData.restaurant) {
                        const { data: rData } = await supabase
                            .from('restaurants')
                            .select('lat, lon')
                            .eq('name', orderData.restaurant)
                            .maybeSingle();
                        if (rData && rData.lat && rData.lon) {
                            restCoords = { lat: rData.lat, lon: rData.lon };
                        }
                    }

                    if (dispatcher && restCoords) {
                        // Запускаем умный поиск курьера (2 км -> 5 км -> 10 км -> fallback)
                        console.log(`[ДИСПЕТЧЕР] Вызов startDispatch для заказа #${orderData.id}. Координаты ресторана: ${restCoords.lat}, ${restCoords.lon}`);
                        await dispatcher.startDispatch(orderData, restCoords, fullRestName);
                    } else {
                        console.log(`[ДИСПЕТЧЕР] ОШИБКА: Нет координат ресторана (${orderData.restaurant})! Умный поиск не запущен, и сброс в общую группу отключен.`);
                        // Отправляем уведомление только админу, чтобы он поправил координаты ресторана
                        try {
                            await bot.telegram.sendMessage(ADMIN_GROUP_ID, `⚠️ <b>ВНИМАНИЕ!</b>\nЗаказ #${orderData.id} не отправлен курьерам, так как у ресторана "${fullRestName}" нет координат! Пожалуйста, отправьте локацию ресторана через меню ресторана.`, { parse_mode: 'HTML' });
                        } catch(e){}
                    }
                } catch (e) {
                    console.error("❌ Ошибка отправки курьерам:", e.message);
                }

            } catch (err) {
                console.error("❌ ОШИБКА ОТПРАВКИ В АДМИНКУ/РАССЫЛКИ:", err.message);
            }
        }
    };
};