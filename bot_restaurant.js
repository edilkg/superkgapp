const { Markup } = require('telegraf');

module.exports = function setupRestaurantBot(restBot, courierBot, clientBot, supabase, ADMIN_GROUP_ID, dispatcher = null) {
    
    // Команда /panel (на всякий случай)
    restBot.command('panel', (ctx) => {
        // Берем ID того, кто нажал на команду
        const currentId = ctx.from.id; 

        ctx.reply('🛠 Управление рестораном\nЗдесь вы можете менять стоп-лист и управлять меню:', {
            reply_markup: {
                inline_keyboard: [
                    [{
                        text: "⚙️ Управление меню",
                        // 👉 МАГИЯ ЗДЕСЬ: Используем обратные кавычки ` ` и передаем ?id=...
                        web_app: { url: `https://superkgapp.vercel.app/restaurant_panel.html?id=${currentId}` } 
                    }]
                ]
            }
        });
    });

    // Функция для генерации нашей новой "лесенки" кнопок
    const getMainMenuKeyboard = () => {
        return Markup.keyboard([
            [Markup.button.webApp('⚙️ Управление меню', 'https://superkgapp.vercel.app/restaurant_panel.html')],
            ['🚕 Вызвать курьера (Вручную)'],
            [Markup.button.locationRequest('📍 Отправить локацию заведения')]
        ]).resize();
    };

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

            // Выдаем главное меню с кнопками по вертикали
            ctx.reply(`✅ Кабинет ресторана "${rest.name}" активен!\nСюда будут приходить новые заказы.`, getMainMenuKeyboard());
        } catch (err) {
            console.error("Ошибка при старте ресторана:", err);
        }
    });

    // ==========================================
    // ЛОВЕЦ ЛОКАЦИИ РЕСТОРАНА
    // ==========================================
    restBot.on('location', async (ctx) => {
        try {
            const id = ctx.from.id;
            const lat = ctx.message.location.latitude;
            const lon = ctx.message.location.longitude;

            await supabase.from('restaurants').update({ 
                lat: lat, 
                lon: lon 
            }).eq('id', id);

            await ctx.reply("✅ Геопозиция ресторана успешно сохранена в базе! Теперь мы сможем автоматически находить ближайших к вам курьеров.");
        } catch (err) {
            console.error("Ошибка сохранения локации ресторана:", err);
            await ctx.reply("❌ Ошибка при сохранении локации. Убедитесь, что в БД добавлены колонки lat и lon для ресторанов.");
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
            return;
        }

        // --- ЛОГИКА РУЧНОГО ВЫЗОВА ---
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
                return ctx.reply("Действие отменено.", getMainMenuKeyboard());
            }

            // Менеджер отправил данные клиента
            if (rest.step === 'ask_manual_data') {
                await supabase.from('restaurants').update({ step: 'active' }).eq('id', id);
                
                try {
                    const { data: newOrder, error } = await supabase.from('orders').insert([{
                        restaurant: rest.name,
                        address: text,
                        status: 'pending',
                        is_manual: true,
                        total_price: 0
                    }]).select().single();

                    if (error) throw error;

                    let restCoords = null;
                    if (rest.lat && rest.lon) {
                        restCoords = { lat: rest.lat, lon: rest.lon };
                    }

                    if (dispatcher && restCoords) {
                        ctx.reply(`✅ Ручной заказ создан! Умный поиск курьера запущен.\nДанные клиента: ${text}`, getMainMenuKeyboard());
                        await dispatcher.startDispatch(newOrder, restCoords, rest.name);
                    } else {
                        // Нет координат - не можем запустить умный поиск
                        ctx.reply(`⚠️ Заказ создан, но УМНЫЙ ПОИСК НЕ ЗАПУЩЕН!\nУ вашего ресторана не указаны координаты. Пожалуйста, отправьте локацию ресторана через меню!`, getMainMenuKeyboard());
                    }
                } catch (err) {
                    console.error("Ошибка создания ручного заказа:", err);
                    return ctx.reply("❌ Ошибка базы данных при создании заказа.", getMainMenuKeyboard());
                }
            }
        }
    });

    // ==========================================
    // 3. ЛОГИКА ЗАКАЗОВ
    // ==========================================
    restBot.action(/rest_accept_(.+)/, async (ctx) => {
        const orderId = ctx.match[1];
        
        try {
            const { data: order } = await supabase.from('orders').select('status').eq('id', orderId).maybeSingle();
            if (!order) return ctx.answerCbQuery("❌ Заказ не найден в базе", { show_alert: true });

            if (['delivery', 'completed', 'canceled'].includes(order.status)) {
                await ctx.answerCbQuery("❌ Поздно! Заказ уже у курьера или завершен.", { show_alert: true });
                return ctx.editMessageText(`❌ Заказ #${String(orderId).slice(0,5)} УЖЕ передан курьеру (или завершен)!\nВам не нужно его принимать.`).catch(()=>{});
            }

            await supabase.from('orders').update({ status: 'cooking' }).eq('id', orderId);
            
            const oldText = ctx.callbackQuery.message.text || '';
            let newText = '';
            
            if (oldText.includes('🍔 НОВЫЙ ЗАКАЗ')) {
                newText = oldText.replace(/🍔 НОВЫЙ ЗАКАЗ(.*)/, '✅ ЗАКАЗ$1 ПРИНЯТ (Готовится на кухне)\n🛵 <i>Курьер уже ищется и едет к вам!</i>');
            } else {
                newText = `✅ ЗАКАЗ #${String(orderId).slice(0,5)} ПРИНЯТ (Готовится)\n🛵 <i>Курьер уже ищется и едет к вам!</i>\n\n` + oldText;
            }
            
            await ctx.editMessageText(newText, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [[
                        { text: "🔔 Блюда готовы к выдаче", callback_data: `rest_ready_${orderId}` }
                    ]]
                }
            }).catch(() => {});
            await ctx.answerCbQuery("✅ Заказ принят в готовку! Ближайший курьер уже вызывается.");

        } catch (err) {
            console.error("Ошибка ресторана при принятии:", err);
            try { await ctx.answerCbQuery("❌ Ошибка связи с базой", { show_alert: true }); } catch(e){}
        }
    });

    // ==========================================
    // РЕСТОРАН НАЖАЛ «ГОТОВО К ВЫДАЧЕ»
    // ==========================================
    restBot.action(/rest_ready_(.+)/, async (ctx) => {
        const orderId = ctx.match[1].trim();
        try {
            await ctx.answerCbQuery("Отлично! Заказ готов к выдаче.");

            const { data: order } = await supabase
                .from('orders')
                .select('*')
                .eq('id', orderId)
                .maybeSingle();

            const oldText = ctx.callbackQuery.message.text || '';
            await ctx.editMessageText(`${oldText}\n\n✅ <b>БЛЮДА ПОЛНОСТЬЮ ГОТОВЫ К ВЫДАЧЕ!</b>`, {
                parse_mode: 'HTML'
            }).catch(() => {});

            // Если курьер уже назначен — сразу пишем ему, что блюда ждут его на стойке!
            if (order && order.courier_id) {
                try {
                    await courierBot.telegram.sendMessage(
                        order.courier_id,
                        `🔔 <b>Блюда по заказу #${String(orderId).slice(0, 5)} уже готовы!</b>\nМожете забирать на кухне без ожидания.`
                    );
                } catch(e) {}
            }

        } catch (err) {
            console.error("❌ Ошибка при нажатии Готово рестораном:", err);
        }
    });

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
                                  `Возможно, большая загрузка на кухне или закончились нужные продукты.\n\n` +
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

    // ==========================================
    // ПОВТОРНЫЙ ПОИСК КУРЬЕРА РЕСТОРАНОМ
    // ==========================================
    restBot.action(/retry_dispatch_(.+)/, async (ctx) => {
        const orderId = ctx.match[1].trim();
        await ctx.answerCbQuery("🔄 Запускаем повторный поиск курьера...").catch(() => {});

        try {
            if (!dispatcher) {
                return ctx.reply("❌ Модуль диспетчера недоступен.");
            }

            const result = await dispatcher.retryDispatch(orderId);
            if (result.success) {
                const oldText = ctx.callbackQuery.message.text || '';
                await ctx.editMessageText(
                    `${oldText}\n\n🔄 <b>Повторный поиск курьера запущен!</b>\nСистема снова опрашивает курьеров поблизости...`,
                    { parse_mode: 'HTML' }
                ).catch(() => {});

                // Уведомляем администратора в группе
                try {
                    await clientBot.telegram.sendMessage(
                        ADMIN_GROUP_ID, 
                        `🔄 <i>Ресторан перезапустил поиск курьера для заказа #${orderId.slice(0, 5)}</i>`, 
                        { parse_mode: 'HTML' }
                    );
                } catch (e) {}
            } else if (result.reason === 'already_taken') {
                await ctx.editMessageText(`✅ Заказ #${orderId.slice(0, 5)} уже взял курьер!`).catch(() => {});
            } else if (result.reason === 'invalid_status') {
                await ctx.editMessageText(`⚠️ Заказ #${orderId.slice(0, 5)} уже ${result.status === 'canceled' ? 'отменен' : 'завершен'}.`).catch(() => {});
            } else {
                await ctx.reply("⚠️ Не удалось перезапустить поиск курьера (проверьте наличие координат заведения).");
            }
        } catch (e) {
            console.error("Ошибка при retry_dispatch в ресторане:", e.message);
        }
    });

    // ==========================================
    // ОТМЕНА ПОДВИСШЕГО ЗАКАЗА РЕСТОРАНОМ
    // ==========================================
    restBot.action(/rest_cancel_order_(.+)/, async (ctx) => {
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
                `${oldText}\n\n❌ <b>ЗАКАЗ ОТМЕНЕН РЕСТОРАНОМ</b> (курьер не найден).`, 
                { parse_mode: 'HTML' }
            ).catch(() => {});

            // Уведомляем клиента
            const cid = order.client_id;
            if (cid && String(cid) !== '111' && String(cid) !== 'null' && String(cid) !== 'undefined') {
                const clientMsg = `❌ <b>Заказ #${String(orderId).slice(0, 5)} отменен рестораном.</b>\n\n` +
                                  `К сожалению, поблизости не нашлось свободных курьеров для доставки.\n` +
                                  `Приносим извинения за неудобства! Поддержка: @foodkg_admin`;
                try {
                    await clientBot.telegram.sendMessage(cid, clientMsg, { parse_mode: 'HTML' });
                } catch (e) {}
            }

            // Уведомляем админ-чат
            try {
                await clientBot.telegram.sendMessage(
                    ADMIN_GROUP_ID, 
                    `❌ <b>Ресторан отменил подвисший заказ #${orderId.slice(0, 5)}</b> (курьер не найден).`, 
                    { parse_mode: 'HTML' }
                );
            } catch (e) {}

        } catch (e) {
            console.error("Ошибка при rest_cancel_order в ресторане:", e.message);
        }
    });

    console.log('📦 Модуль Restaurant загружен');
};