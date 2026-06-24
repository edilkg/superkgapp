const { Markup } = require('telegraf');

module.exports = function setupCourierBot(courierBot, bot, restBot, supabase, ADMIN_GROUP_ID) {
    
    // ==========================================
    // 0. СТАРТ И ПРОФИЛЬ
    // ==========================================
    courierBot.start(async (ctx) => {
        try {
            const id = ctx.from.id;
            const { data: courier } = await supabase.from('couriers').select('*').eq('id', id).maybeSingle();

            if (!courier) {
                await supabase.from('couriers').insert([{ id, name: ctx.from.first_name, status: 'waiting_approval', balance: 0 }]);
                ctx.reply("Привет! Заявка отправлена админу. Жди одобрения.");
                
                return bot.telegram.sendMessage(ADMIN_GROUP_ID, 
                    `🛵 НОВАЯ ЗАЯВКА (КУРЬЕР)\nИмя: ${ctx.from.first_name}\nID: ${id}`,
                    Markup.inlineKeyboard([[Markup.button.callback('✅ ОДОБРИТЬ КУРЬЕРА', `approve_courier_${id}`)]])
                );
            }

            if (courier.status === 'waiting_approval') return ctx.reply("⏳ Твой аккаунт на проверке.");

            ctx.reply(`👤 ЛИЧНЫЙ КАБИНЕТ\n\nИмя: ${courier.name}\n💰 Баланс: ${courier.balance || 0} сом\nСтатус: На линии ✅`);
        } catch (e) { console.error(e); }
    });

    // ==========================================
    // 1. КУРЬЕР БЕРЕТ ЗАКАЗ (ЕДЕТ В РЕСТОРАН)
    // ==========================================
    courierBot.action(/courier_take_(.+)/, async (ctx) => {
        const orderId = ctx.match[1];
        const courierId = ctx.from.id;

        try {
            // 👉 ОБНОВЛЕНО: Достаем телефон, ID и имя клиента из базы
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

            // 👉 ОБНОВЛЕНО: Формируем текст для курьера с номером клиента
            const clientPhone = orderCheck.phone || 'Не указан';
            const clientName = orderCheck.client_name || 'Гость';

            const newText = ctx.callbackQuery.message.text + `\n\n✅ ВЫ ПРИНЯЛИ ЗАКАЗ!\nОтправляйтесь в ресторан.\n\n👤 Клиент: ${clientName}\n📞 Телефон клиента: ${clientPhone}\n\nКак только заберете еду, нажмите кнопку ниже:`;

            // Создаем кнопки
            const buttons = [
                [Markup.button.callback('📦 Я взял заказ (Еду к клиенту)', `courier_picked_up_${orderId}`)]
            ];
            
            // Если у клиента есть Telegram ID, добавляем кнопку связи
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
    // 3. КУРЬЕР ДОСТАВИЛ ЗАКАЗ (ВКЛЮЧАЕТ СТАТУС 4)
    // ==========================================
    courierBot.action(/courier_delivered_(.+)/, async (ctx) => {
        const orderId = ctx.match[1];

        try {
            await supabase.from('orders').update({ status: 'completed' }).eq('id', orderId);

            const { data: order } = await supabase.from('orders').select('client_id').eq('id', orderId).maybeSingle();
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