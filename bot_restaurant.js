const { Markup } = require('telegraf');

module.exports = function setupRestaurantBot(restBot, courierBot, clientBot, supabase, ADMIN_GROUP_ID) {
    
    // ==========================================
    // 1. СТАРТ И РЕГИСТРАЦИЯ
    // ==========================================
    restBot.start(async (ctx) => {
        try {
            const id = ctx.from.id;
            const { data: rest } = await supabase.from('restaurants').select('*').eq('id', id).maybeSingle();

            if (!rest) {
                await supabase.from('restaurants').insert([{ id, step: 'ask_name', is_approved: false }]);
                return ctx.reply("Привет! Добро пожаловать в панель партнера ТамакKG. 🍔\n\nВведите название вашего заведения:");
            }

            if (!rest.is_approved) return ctx.reply("⏳ Ваша заявка находится на проверке у администратора.");

            // 👉 ДОБАВЛЕНО: Постоянная кнопка внизу экрана для одобренных ресторанов
            ctx.reply(`✅ Кабинет ресторана "${rest.name}" активен!\nСюда будут приходить новые заказы.`,
                Markup.keyboard([
                    ['🚕 Вызвать курьера (Вручную)']
                ]).resize()
            );
        } catch (err) {
            console.error("Ошибка при старте ресторана:", err);
        }
    });

    // ==========================================
    // 2. ОБРАБОТКА ТЕКСТА И РУЧНЫХ ЗАКАЗОВ
    // ==========================================
    restBot.on('text', async (ctx) => {
        const id = ctx.from.id;
        const text = ctx.message.text;
        if (text.startsWith('/')) return;

        const { data: rest } = await supabase.from('restaurants').select('*').eq('id', id).maybeSingle();
        if (!rest) return;

        // --- ЛОГИКА РЕГИСТРАЦИИ ---
        if (!rest.is_approved) {
            if (rest.step === 'ask_name') {
                await supabase.from('restaurants').update({ name: text, step: 'ask_phone' }).eq('id', id);
                return ctx.reply(`Принято! Теперь напишите номер телефона:`);
            }

            if (rest.step === 'ask_phone') {
                await supabase.from('restaurants').update({ phone: text, step: 'waiting' }).eq('id', id);
                ctx.reply("Спасибо! Заявка отправлена администратору.");

                return clientBot.telegram.sendMessage(ADMIN_GROUP_ID, 
                    `🏢 НОВАЯ ЗАЯВКА (РЕСТОРАН)\nНазвание: ${rest.name}\nТел: ${text}\nID: ${id}`,
                    Markup.inlineKeyboard([[Markup.button.callback('✅ ОДОБРИТЬ РЕСТОРАН', `approve_rest_${id}`)]])
                );
            }
            return; // Если заявка ждет одобрения, игнорируем другой текст
        }

        // --- ЛОГИКА РУЧНОГО ВЫЗОВА (КНОПКИ ВНИЗУ) ---
        if (rest.is_approved) {
            // Менеджер нажал кнопку вызова
            if (text === '🚕 Вызвать курьера (Вручную)') {
                await supabase.from('restaurants').update({ step: 'ask_manual_data' }).eq('id', id);
                return ctx.reply("📝 Отправьте данные клиента (например: 0555123456, ул. Советская 45):",
                    Markup.keyboard([
                        ['❌ Отмена']
                    ]).resize()
                );
            }

            // Менеджер передумал и нажал отмену
            if (text === '❌ Отмена') {
                await supabase.from('restaurants').update({ step: 'active' }).eq('id', id);
                return ctx.reply("Действие отменено.", 
                    Markup.keyboard([
                        ['🚕 Вызвать курьера (Вручную)']
                    ]).resize()
                );
            }

            // Менеджер отправил данные клиента
            if (rest.step === 'ask_manual_data') {
                // Возвращаем ресторан в активный статус
                await supabase.from('restaurants').update({ step: 'active' }).eq('id', id);
                
                try {
                    // Создаем заказ в БД с пометкой is_manual = true
                    const { data: newOrder, error } = await supabase.from('orders').insert([{
                        restaurant: rest.name,
                        address: text,
                        status: 'pending', // Ждет курьера
                        is_manual: true
                    }]).select().single();

                    if (error) throw error;

                    // Отвечаем менеджеру
                    ctx.reply(`✅ Вызов успешно отправлен курьерам!\nДанные клиента: ${text}`, 
                        Markup.keyboard([
                            ['🚕 Вызвать курьера (Вручную)']
                        ]).resize()
                    );

                    // Отправляем в общую группу курьеров
                    return courierBot.telegram.sendMessage(ADMIN_GROUP_ID,
                        `🚨 <b>РУЧНОЙ ВЫЗОВ (от ресторана)</b>\n\n` +
                        `📍 Забрать: <b>${rest.name}</b>\n` +
                        `📞 Данные клиента:\n${text}\n\n` +
                        `💸 Комиссия за заказ: 20 сом.`,
                        { 
                            parse_mode: 'HTML',
                            reply_markup: {
                                inline_keyboard: [[{ text: '🚕 Принять заказ', callback_data: `courier_accept_${newOrder.id}` }]]
                            }
                        }
                    );
                } catch (err) {
                    console.error("Ошибка создания ручного заказа:", err);
                    return ctx.reply("❌ Ошибка базы данных при создании заказа.",
                        Markup.keyboard([
                            ['🚕 Вызвать курьера (Вручную)']
                        ]).resize()
                    );
                }
            }
        }
    });

    // ==========================================
    // 3. ЛОГИКА ЗАКАЗОВ (С ЗАЩИТОЙ ОТ ОПОЗДАНИЙ)
    // ==========================================
    restBot.action(/rest_accept_(.+)/, async (ctx) => {
        const orderId = ctx.match[1];
        
        try {
            const { data: order } = await supabase.from('orders').select('status').eq('id', orderId).maybeSingle();
            if (!order) return ctx.answerCbQuery("❌ Заказ не найден в базе", { show_alert: true });

            if (['delivery', 'completed', 'canceled'].includes(order.status)) {
                await ctx.answerCbQuery("❌ Поздно! Заказ уже у курьера или завершен.", { show_alert: true });
                return ctx.editMessageText(`❌ Заказ #${String(orderId).slice(0,5)} УЖЕ передан курьеру (или завершен)!\nВам не нужно его принимать.`);
            }

            await supabase.from('orders').update({ status: 'cooking' }).eq('id', orderId);
            
            await ctx.editMessageText(`👨‍🍳 Заказ #${String(orderId).slice(0,5)} готовится!\nНажмите кнопку, когда отдадите пакет:`,
                Markup.inlineKeyboard([[Markup.button.callback('📦 ОТДАНО КУРЬЕРУ', `rest_given_${orderId}`)]])
            );
            await ctx.answerCbQuery("Заказ принят в работу!");

        } catch (err) {
            console.error("Ошибка ресторана при принятии:", err);
            try { await ctx.answerCbQuery("❌ Ошибка связи с базой", { show_alert: true }); } catch(e){}
        }
    });

    restBot.action(/rest_given_(.+)/, async (ctx) => {
        const orderId = ctx.match[1];
        try {
            const { data: order } = await supabase.from('orders').select('status').eq('id', orderId).maybeSingle();
            if (order && order.status === 'completed') {
                await ctx.answerCbQuery("❌ Заказ уже доставлен клиенту!", { show_alert: true });
                return ctx.editMessageText(`✅ Этот заказ УЖЕ успешно доставлен клиенту!`);
            }

            await ctx.editMessageText(`✅ Заказ успешно передан курьеру!`);
            await ctx.answerCbQuery("Отлично!");
        } catch (e) {}
    });

    // ==========================================
    // 4. Кнопка: ОТКЛОНИТЬ ЗАКАЗ (С УМНЫМИ УВЕДОМЛЕНИЯМИ)
    // ==========================================
    restBot.action(/rest_decline_(.+)/, async (ctx) => {
        const orderId = ctx.match[1].trim();
        try {
            await ctx.answerCbQuery("Отклоняем заказ...").catch(() => {});

            const { data: order } = await supabase
                .from('orders')
                .select('*')
                .eq('id', orderId)
                .maybeSingle();

            if (!order) return;

            if (order.status === 'canceled') {
                return ctx.answerCbQuery("⚠️ Заказ уже отменен!", { show_alert: true }).catch(() => {});
            }

            if (order.status === 'completed') {
                return ctx.answerCbQuery("❌ Невозможно отменить: заказ уже успешно доставлен клиенту!", { show_alert: true }).catch(() => {});
            }

            await supabase.from('orders').update({ status: 'canceled' }).eq('id', orderId);

            const cid = order.client_id;
            if (cid && String(cid) !== '111' && String(cid) !== 'null' && String(cid) !== 'undefined') {
                const clientMsg = `❌ <b>Заказ #${String(orderId).slice(0,5)} отменен рестораном.</b>\n\n` +
                                  `Возможно, большая загрузка на кухне или закончились нужные продукты).\n\n` +
                                  `Пожалуйста, вернитесь в меню и выберите другой ресторан. Приносим извинения за неудобства!😔 Поддержка: @foodkg_admin`;
                try {
                    await clientBot.telegram.sendMessage(cid, clientMsg, { parse_mode: 'HTML' });
                } catch(e) {
                    console.error("Ошибка отправки уведомления клиенту:", e);
                }
            }

            const courierId = order.courier_id;
            if (courierId && String(courierId) !== 'null' && String(courierId) !== 'undefined') {
                try {
                    await courierBot.telegram.sendMessage(
                        courierId, 
                        `🚨 <b>ОТМЕНА ЗАКАЗА!</b>\n\nРесторан отменил заказ <b>#${String(orderId).slice(0,5)}</b>.`, 
                        { parse_mode: 'HTML' }
                    );
                } catch(e) {
                    console.error("Ошибка отправки уведомления курьеру:", e);
                }
            }

            try {
                await clientBot.telegram.sendMessage(
                    ADMIN_GROUP_ID,
                    `⚠️ <b>Отказ ресторана!</b>\nЗаказ #${String(orderId).slice(0,5)} был только что отклонен заведением <b>${order.restaurant || 'Неизвестно'}</b>.`,
                    { parse_mode: 'HTML' }
                );
            } catch(e) {}

            await ctx.editMessageText(`❌ Заказ #${String(orderId).slice(0,5)} ОТКЛОНЕН вами.`).catch(() => {});
            
        } catch (err) {
            console.error("❌ Ошибка при отклонении рестораном:", err);
        }
    });

    console.log('📦 Модуль Restaurant загружен');
};