const { Markup } = require('telegraf');

module.exports = function setupCourierBot(courierBot, bot, restBot, supabase, ADMIN_GROUP_ID) {
    
    // ==========================================
    // 0. СТАРТ И ПРОФИЛЬ
    // ==========================================
    courierBot.start(async (ctx) => {
        try {
            const id = ctx.from?.id;
            if (!id) return;

            const { data: courier } = await supabase.from('couriers').select('*').eq('id', id).maybeSingle();

            if (!courier) {
                // Регистрируем с пометкой, что нужно спросить телефон
                await supabase.from('couriers').insert([{ id, name: ctx.from.first_name || 'Курьер', status: 'offline', step: 'ask_phone', balance: 0 }]);
                
                return ctx.reply("Привет! Чтобы стать курьером, отправь свой номер телефона, нажав на кнопку ниже:", 
                    Markup.keyboard([
                        [Markup.button.contactRequest('📱 Отправить мой номер')]
                    ]).resize()
                );
            }

            if (courier.step === 'ask_phone') {
                return ctx.reply("Пожалуйста, отправь свой номер телефона, нажав на кнопку ниже:", 
                    Markup.keyboard([
                        [Markup.button.contactRequest('📱 Отправить мой номер')]
                    ]).resize()
                );
            }

            if (courier.status === 'waiting_approval') {
                return ctx.reply("⏳ Твой аккаунт на проверке.", Markup.removeKeyboard());
            }

            // Перезаписываем старые кнопки, оставляя только "Баланс"
            ctx.reply(`👤 ЛИЧНЫЙ КАБИНЕТ\n\nИмя: ${courier.name || 'Курьер'}\n💰 Баланс: ${courier.balance || 0} сом\nСтатус: На линии ✅`, 
                Markup.keyboard([
                    ['💳 Баланс']
                ]).resize()
            );
        } catch (e) { 
            console.error("Ошибка при старте курьера:", e); 
        }
    });

    // ==========================================
    // 0.1 ПОЛУЧЕНИЕ НОМЕРА ТЕЛЕФОНА (КНОПКА КОНТАКТА)
    // ==========================================
    courierBot.on('contact', async (ctx) => {
        try {
            const id = ctx.from.id;
            const { data: courier } = await supabase.from('couriers').select('step').eq('id', id).maybeSingle();

            if (!courier || courier.step !== 'ask_phone') return;

            const phone = ctx.message.contact.phone_number;

            await supabase.from('couriers').update({ phone: phone, step: 'completed', status: 'waiting_approval' }).eq('id', id);

            await ctx.reply("✅ Спасибо! Заявка отправлена админу. Жди одобрения.", Markup.removeKeyboard());

            // ПУШ АДМИНУ
            return bot.telegram.sendMessage(ADMIN_GROUP_ID, 
                `🛵 НОВАЯ ЗАЯВКА (КУРЬЕР)\nИмя: ${ctx.from.first_name || 'Не указано'}\nТелефон: ${phone}\nID: ${id}`,
                Markup.inlineKeyboard([[Markup.button.callback('✅ ОДОБРИТЬ КУРЬЕРА', `approve_courier_${id}`)]])
            );
        } catch (e) {
            console.error("Ошибка при получении контакта курьера:", e);
        }
    });

    // ==========================================
    // 0.2 ОБРАБОТКА ТЕКСТА (ЕСЛИ ВВЕЛ НОМЕР ВРУЧНУЮ ИЛИ НАЖАЛ БАЛАНС)
    // ==========================================
    courierBot.on('text', async (ctx) => {
        try {
            const id = ctx.from.id;
            const text = ctx.message.text;

            if (text.startsWith('/')) return;

            const { data: courier } = await supabase.from('couriers').select('*').eq('id', id).maybeSingle();
            if (!courier) return;

            // Если бот ждет номер телефона
            if (courier.step === 'ask_phone') {
                await supabase.from('couriers').update({ phone: text, step: 'completed', status: 'waiting_approval' }).eq('id', id);

                await ctx.reply("✅ Спасибо! Заявка отправлена админу. Жди одобрения.", Markup.removeKeyboard());

                // ПУШ АДМИНУ
                return bot.telegram.sendMessage(ADMIN_GROUP_ID, 
                    `🛵 НОВАЯ ЗАЯВКА (КУРЬЕР)\nИмя: ${ctx.from.first_name || 'Не указано'}\nТелефон: ${text}\nID: ${id}`,
                    Markup.inlineKeyboard([[Markup.button.callback('✅ ОДОБРИТЬ КУРЬЕРА', `approve_courier_${id}`)]])
                );
            }

            // Обработка кнопки "💳 Баланс"
            if (text === '💳 Баланс') {
                if (courier.status === 'waiting_approval') return;
                return ctx.reply(`💳 Ваш текущий баланс: ${courier.balance || 0} сом\n(Комиссия 10% списывается автоматически с каждого доставленного заказа)`);
            }
        } catch (e) {
            console.error("Ошибка при обработке текста курьером:", e);
        }
    });

    // ==========================================
    // 1. КУРЬЕР БЕРЕТ ЗАКАЗ (ЕДЕТ В РЕСТОРАН)
    // ==========================================
    courierBot.action(/courier_take_(.+)/, async (ctx) => {
        const orderId = ctx.match[1];
        const courierId = ctx.from.id;

        try {
            // 👉 ЗАЩИТА БАЛАНСА: Проверяем баланс курьера ПЕРЕД взятием заказа
            const { data: courierCheck } = await supabase.from('couriers').select('balance').eq('id', courierId).maybeSingle();
            
            if (!courierCheck) return ctx.answerCbQuery("❌ Ошибка: курьер не найден", { show_alert: true });
            
            if ((courierCheck.balance || 0) <= 0) {
                return ctx.answerCbQuery("❌ Ваш баланс 0 или ниже! Пополните счет через администратора, чтобы брать новые заказы.", { show_alert: true });
            }

            // 👉 Достаем заказ из базы
            const { data: orderCheck, error: checkErr } = await supabase.from('orders').select('courier_id, restaurant, phone, client_id, client_name').eq('id', orderId).maybeSingle();
            
            if (checkErr || !orderCheck) return ctx.answerCbQuery("❌ Заказ не найден", { show_alert: true });
            if (orderCheck.courier_id && orderCheck.courier_id !== courierId) return ctx.answerCbQuery("❌ Этот заказ уже взял другой курьер", { show_alert: true });

            await supabase.from('orders').update({ courier_id: courierId }).eq('id', orderId);

            const { data: courierData } = await supabase.from('couriers').select('name, phone').eq('id', courierId).maybeSingle();
            
            const cName = courierData?.name || ctx.from.first_name || 'Курьер';
            const cPhone = courierData?.phone || 'Номер не указан';
            const cProfile = ctx.from.username ? `@${ctx.from.username}` : `<a href="tg://user?id=${courierId}">Профиль</a>`;

            const notifyMessage = `🛵 Курьер выехал в ресторан за заказом <b>#${String(orderId).slice(0,5)}</b>\n\n👤 Курьер: <b>${cName}</b>\n📞 Телефон: ${cPhone}\n💬 Telegram: ${cProfile}`;

            try { await bot.telegram.sendMessage(ADMIN_GROUP_ID, notifyMessage, { parse_mode: 'HTML' }); } catch(e) {}

            if (orderCheck.restaurant) {
                const { data: restData } = await supabase.from('restaurants').select('id').eq('name', orderCheck.restaurant).maybeSingle();
                if (restData) {
                    try { await restBot.telegram.sendMessage(restData.id, notifyMessage, { parse_mode: 'HTML' }); } catch(e) {}
                }
            }

            // 👉 Формируем текст для курьера
            const clientPhone = orderCheck.phone || 'Не указан';
            const clientName = orderCheck.client_name || 'Гость';

            const originalMsg = ctx.callbackQuery.message.text;
            const appendText = `\n\n✅ ВЫ ПРИНЯЛИ ЗАКАЗ!\nОтправляйтесь в ресторан.\n\n👤 Клиент: ${clientName}\n📞 Телефон клиента: ${clientPhone}\n\nКак только заберете еду, нажмите кнопку ниже:`;
            const newText = (originalMsg ? originalMsg : "Заказ") + appendText;

            const buttons = [
                [Markup.button.callback('📦 Я взял заказ (Еду к клиенту)', `courier_picked_up_${orderId}`)]
            ];
            
            if (orderCheck.client_id && orderCheck.client_id != 111) {
                buttons.push([Markup.button.url('💬 Написать клиенту', `tg://user?id=${orderCheck.client_id}`)]);
            }

            await ctx.editMessageText(newText, Markup.inlineKeyboard(buttons));
            await ctx.answerCbQuery("✅ Вы назначены на заказ!");
        } catch (err) {
            console.error("Ошибка при взятии заказа курьером:", err.message);
            try { await ctx.answerCbQuery("❌ Ошибка базы данных", {show_alert: true}); } catch(e){}
        }
    });

    // ==========================================
    // 2. КУРЬЕР ЗАБРАЛ ЗАКАЗ (ВКЛЮЧАЕТ СТАТУС 3)
    // ==========================================
    courierBot.action(/courier_picked_up_(.+)/, async (ctx) => {
        const orderId = ctx.match[1];
        const courierId = ctx.from.id; 

        try {
            await supabase.from('orders').update({ status: 'delivery' }).eq('id', orderId);

            const { data: order } = await supabase.from('orders').select('client_id').eq('id', orderId).maybeSingle();
            const { data: courierData } = await supabase.from('couriers').select('name, phone').eq('id', courierId).maybeSingle();
            
            const cName = courierData?.name || ctx.from.first_name || 'Курьер';
            const cPhone = courierData?.phone || 'Номер не указан';

            if (order && order.client_id && order.client_id != 111) {
                const clientMessage = `🚀 Курьер взял заказ и летит к вам!\n\n👤 Курьер: <b>${cName}</b>\n📞 Телефон: ${cPhone}`;
                try { await bot.telegram.sendMessage(order.client_id, clientMessage, { parse_mode: 'HTML' }); } catch(e){}
            }

            // 👉 ОБНОВЛЕНО: Сохраняем кнопку связи с клиентом на этапе "В пути"
            const buttons = [
                [Markup.button.callback('✅ Я доставил заказ', `courier_delivered_${orderId}`)]
            ];
            if (order && order.client_id && order.client_id != 111) {
                buttons.push([Markup.button.url('💬 Написать клиенту', `tg://user?id=${order.client_id}`)]);
            }

            await ctx.editMessageText(
                ctx.callbackQuery.message.text + `\n\n🛵 ВЫ В ПУТИ К КЛИЕНТУ!\nКак только отдадите еду, нажмите кнопку:`,
                Markup.inlineKeyboard(buttons)
            );
            await ctx.answerCbQuery("Выехали к клиенту!");
        } catch (err) {
            console.error("Ошибка при статусе 'в пути':", err);
            try { await ctx.answerCbQuery("❌ Ошибка", {show_alert: true}); } catch(e){}
        }
    });

    // ==========================================
    // 3. КУРЬЕР ДОСТАВИЛ ЗАКАЗ (СТАТУС 4 + СПИСАНИЕ КОМИССИИ)
    // ==========================================
    courierBot.action(/courier_delivered_(.+)/, async (ctx) => {
        const orderId = ctx.match[1];
        const courierId = ctx.from.id; 

        try {
            await supabase.from('orders').update({ status: 'completed' }).eq('id', orderId);

            // Достаем заказ, чтобы посчитать комиссию
            const { data: order } = await supabase.from('orders').select('client_id, items, total_price').eq('id', orderId).maybeSingle();
            
            // 💸 РАСЧЕТ КОМИССИИ (10% ОТ СТОИМОСТИ ДОСТАВКИ)
            let foodPrice = 0;
            try { 
                const itemsArr = Array.isArray(order.items) ? order.items : JSON.parse(order.items || '[]');
                itemsArr.forEach(i => {
                    const price = Number(i.price || (i.item ? i.item.price : 0)) || 0;
                    const count = Number(i.count) || 0;
                    foodPrice += price * count;
                });
            } catch(e) {}
            
            // Вычисляем чистую цену доставки и берем от нее 10%
            const deliveryPrice = Math.max(0, (order.total_price || 0) - foodPrice);
            const commission = Math.round(deliveryPrice * 0.10); 

            // Списываем комиссию с баланса курьера
            const { data: cData } = await supabase.from('couriers').select('balance').eq('id', courierId).maybeSingle();
            if (cData) {
                const newBalance = (cData.balance || 0) - commission;
                await supabase.from('couriers').update({ balance: newBalance }).eq('id', courierId);
                
                // Отправляем чек-уведомление курьеру
                try {
                    await courierBot.telegram.sendMessage(courierId, `💸 Спасибо за доставку!\nКомиссия за заказ: ${commission} сом (10%).\n💳Остаток Баланса: ${newBalance} сом.`);
                } catch(e) {}
            }

            // Уведомляем клиента
            if (order && order.client_id && order.client_id != 111) {
                try { await bot.telegram.sendMessage(order.client_id, `🎉 Заказ успешно доставлен!\nПриятного аппетита 🍔😋`); } catch(e){}
            }

            await ctx.editMessageText(ctx.callbackQuery.message.text + `\n\n🎉 ЗАКАЗ УСПЕШНО ДОСТАВЛЕН!`);
            await ctx.answerCbQuery("Отличная работа!");
        } catch (err) {
            console.error("Ошибка при статусе 'доставлен':", err);
            try { await ctx.answerCbQuery("❌ Ошибка", {show_alert: true}); } catch(e){}
        }
    });
    };