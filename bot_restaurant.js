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

            ctx.reply(`✅ Кабинет ресторана "${rest.name}" активен!\nСюда будут приходить новые заказы.`);
        } catch (err) {}
    });

    // ==========================================
    // 2. ШАГИ РЕГИСТРАЦИИ
    // ==========================================
    restBot.on('text', async (ctx) => {
        const id = ctx.from.id;
        const text = ctx.message.text;
        if (text.startsWith('/')) return;

        const { data: rest } = await supabase.from('restaurants').select('*').eq('id', id).maybeSingle();
        if (!rest || rest.is_approved) return;

        if (rest.step === 'ask_name') {
            await supabase.from('restaurants').update({ name: text, step: 'ask_phone' }).eq('id', id);
            return ctx.reply(`Принято! Теперь напишите номер телефона:`);
        }

        if (rest.step === 'ask_phone') {
            await supabase.from('restaurants').update({ phone: text, step: 'waiting' }).eq('id', id);
            ctx.reply("Спасибо! Заявка отправлена администратору.");

            // ПУШ АДМИНУ (Отправляем через клиентского бота)
            return clientBot.telegram.sendMessage(ADMIN_GROUP_ID, 
                `🏢 НОВАЯ ЗАЯВКА (РЕСТОРАН)\nНазвание: ${rest.name}\nТелефон: ${text}\nID: ${id}`,
                Markup.inlineKeyboard([[Markup.button.callback('✅ ОДОБРИТЬ РЕСТОРАН', `approve_rest_${id}`)]])
            );
        }
    });

    // ==========================================
    // 3. ЛОГИКА ЗАКАЗОВ (С ЗАЩИТОЙ ОТ ОПОЗДАНИЙ)
    // ==========================================
    restBot.action(/rest_accept_(.+)/, async (ctx) => {
        const orderId = ctx.match[1];
        
        try {
            // 👉 ЗАЩИТА: Проверяем статус заказа ПЕРЕД тем, как менять его
            const { data: order } = await supabase.from('orders').select('status').eq('id', orderId).maybeSingle();
            if (!order) return ctx.answerCbQuery("❌ Заказ не найден в базе", { show_alert: true });

            // Если заказ УЖЕ в пути, доставлен или отменен — блокируем нажатие!
            if (['delivery', 'completed', 'canceled'].includes(order.status)) {
                await ctx.answerCbQuery("❌ Поздно! Заказ уже у курьера или завершен.", { show_alert: true });
                return ctx.editMessageText(`❌ Заказ #${String(orderId).slice(0,5)} УЖЕ передан курьеру (или завершен)!\nВам не нужно его принимать.`);
            }

            // Если всё нормально (ожидает оплаты или только что оплачен), меняем на "cooking"
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

    // Кнопка: ОТДАТЬ КУРЬЕРУ
    restBot.action(/rest_given_(.+)/, async (ctx) => {
        const orderId = ctx.match[1];
        try {
            // Тоже добавляем мини-защиту, чтобы ресторан не мог "нажать", если заказ уже завершен
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
    // Кнопка: ОТКЛОНИТЬ ЗАКАЗ (С УМНЫМИ УВЕДОМЛЕНИЯМИ)
    // ==========================================
    restBot.action(/rest_decline_(.+)/, async (ctx) => {
        const orderId = ctx.match[1].trim();
        try {
            await ctx.answerCbQuery("Отклоняем заказ...").catch(() => {});

            // 1. Запрашиваем ВСЕ данные заказа (status, client_id, courier_id, restaurant)
            const { data: order } = await supabase
                .from('orders')
                .select('*')
                .eq('id', orderId)
                .maybeSingle();

            if (!order) return;

           // Защита от двойного нажатия (уже отменен)
            if (order.status === 'canceled') {
                return ctx.answerCbQuery("⚠️ Заказ уже отменен!", { show_alert: true }).catch(() => {});
            }

            // 👉 ИСПРАВЛЕНО: Убрали 'delivery'. Теперь ресторан может отменить заказ, даже если курьер в пути.
            // Оставили только защиту от отмены УЖЕ ЗАВЕРШЕННОГО заказа.
            if (order.status === 'completed') {
                return ctx.answerCbQuery("❌ Невозможно отменить: заказ уже успешно доставлен клиенту!", { show_alert: true }).catch(() => {});
            }

            // 2. Меняем статус в базе на canceled
            await supabase.from('orders').update({ status: 'canceled' }).eq('id', orderId);

            // 3. УВЕДОМЛЯЕМ КЛИЕНТА (С извинениями)
            const cid = order.client_id;
            if (cid && String(cid) !== '111' && String(cid) !== 'null' && String(cid) !== 'undefined') {
                const clientMsg = `❌ <b>Заказ #${String(orderId).slice(0,5)} отменен рестораном.</b>\n\n` +
                                  `Возможно, большая загрузка на кухне или закончились нужные продукты).\n\n` +
                                  `Пожалуйста, вернитесь в меню и выберите другой ресторан. Приносим извинения за неудобства!😔\n
                                  Поддержка: @foodkg_admin`;
                try {
                    await clientBot.telegram.sendMessage(cid, clientMsg, { parse_mode: 'HTML' });
                } catch(e) {
                    console.error("Ошибка отправки уведомления клиенту:", e);
                }
            }

            // 4. УВЕДОМЛЯЕМ КУРЬЕРА (Если он уже нажал "Я возьму")
            const courierId = order.courier_id;
            if (courierId && String(courierId) !== 'null' && String(courierId) !== 'undefined') {
                try {
                    await courierBot.telegram.sendMessage(
                        courierId, 
                        `🚨 <b>ОТМЕНА ЗАКАЗА!</b>\n\nРесторан отменил заказ <b>#${String(orderId).slice(0,5)}</b>.\nВам не нужно за ним ехать, заказ аннулирован.`, 
                        { parse_mode: 'HTML' }
                    );
                } catch(e) {
                    console.error("Ошибка отправки уведомления курьеру:", e);
                }
            }

            // 5. УВЕДОМЛЯЕМ АДМИНА (Контроль качества)
            try {
                await clientBot.telegram.sendMessage(
                    ADMIN_GROUP_ID,
                    `⚠️ <b>Отказ ресторана!</b>\nЗаказ #${String(orderId).slice(0,5)} был только что отклонен заведением <b>${order.restaurant || 'Неизвестно'}</b>.`,
                    { parse_mode: 'HTML' }
                );
            } catch(e) {}

            // 6. Меняем сообщение у самого ресторана
            await ctx.editMessageText(`❌ Заказ #${String(orderId).slice(0,5)} ОТКЛОНЕН вами.`).catch(() => {});
            
        } catch (err) {
            console.error("❌ Ошибка при отклонении рестораном:", err);
        }
    });

    console.log('📦 Модуль Restaurant загружен');
};