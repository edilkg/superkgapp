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
            const { data: orderCheck, error: checkErr } = await supabase.from('orders').select('courier_id, restaurant').eq('id', orderId).maybeSingle();
            
            if (checkErr || !orderCheck) return ctx.answerCbQuery("❌ Заказ не найден", { show_alert: true });
            if (orderCheck.courier_id && orderCheck.courier_id !== courierId) return ctx.answerCbQuery("❌ Этот заказ уже взял другой курьер", { show_alert: true });

            await supabase.from('orders').update({ courier_id: courierId }).eq('id', orderId);

            const cName = ctx.from.first_name || 'Курьер';
            const cUsername = ctx.from.username ? '@' + ctx.from.username : `(Без юзернейма, ID: ${courierId})`;

            try { await bot.telegram.sendMessage(ADMIN_GROUP_ID, `🛵 Курьер выехал в ресторан за заказом #${String(orderId).slice(0,5)}:\n👤 ${cName}\n💬 Связь: ${cUsername}`); } catch(e) {}

            if (orderCheck.restaurant) {
                const { data: restData } = await supabase.from('restaurants').select('id').eq('name', orderCheck.restaurant).maybeSingle();
                if (restData) {
                    try { await restBot.telegram.sendMessage(restData.id, `🛵 К вам за заказом #${String(orderId).slice(0,5)} выехал курьер:\n👤 ${cName}\n💬 Связь: ${cUsername}`); } catch(e) {}
                }
            }

            await ctx.editMessageText(
                ctx.callbackQuery.message.text + `\n\n✅ ВЫ ПРИНЯЛИ ЗАКАЗ!\nОтправляйтесь в ресторан. Как только заберете еду, нажмите кнопку ниже:`,
                Markup.inlineKeyboard([[Markup.button.callback('📦 Я взял заказ (Еду к клиенту)', `courier_picked_up_${orderId}`)]])
            );
            
            await ctx.answerCbQuery("✅ Вы назначены на заказ!");
        } catch (err) {
            try { await ctx.answerCbQuery("❌ Ошибка", {show_alert: true}); } catch(e){}
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

            // 👉 Достаем данные клиента и курьера
            const { data: order } = await supabase.from('orders').select('client_id').eq('id', orderId).maybeSingle();
            const { data: courierData } = await supabase.from('couriers').select('name, phone').eq('id', courierId).maybeSingle();
            
            // Собираем Имя и Телефон
            const cName = courierData?.name || ctx.from.first_name || 'Курьер';
            const cPhone = courierData?.phone || 'Номер не указан';

            // 👉 2. НОВОЕ СООБЩЕНИЕ ДЛЯ КЛИЕНТА (КУРЬЕР В ПУТИ)
            if (order && order.client_id && order.client_id != 111) {
                const clientMessage = `🚀 Курьер взял заказ и летит к вам!\n\n👤 Курьер: <b>${cName}</b>\n📞 Телефон: ${cPhone}`;
                
                try { await bot.telegram.sendMessage(order.client_id, clientMessage, { parse_mode: 'HTML' }); } catch(e){}
            }

            await ctx.editMessageText(
                ctx.callbackQuery.message.text + `\n\n🛵 ВЫ В ПУТИ К КЛИЕНТУ!\nКак только отдадите еду, нажмите кнопку:`,
                Markup.inlineKeyboard([[Markup.button.callback('✅ Я доставил заказ', `courier_delivered_${orderId}`)]])
            );
            await ctx.answerCbQuery("Выехали к клиенту!");
        } catch (err) {
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

            // 👉 3. НОВОЕ СООБЩЕНИЕ ДЛЯ КЛИЕНТА (ЗАКАЗ ДОСТАВЛЕН)
            const { data: order } = await supabase.from('orders').select('client_id').eq('id', orderId).maybeSingle();
            if (order && order.client_id && order.client_id != 111) {
                try { await bot.telegram.sendMessage(order.client_id, `🎉 Заказ успешно доставлен!\nПриятного аппетита 🍔😋`); } catch(e){}
            }

            await ctx.editMessageText(ctx.callbackQuery.message.text + `\n\n🎉 ЗАКАЗ УСПЕШНО ДОСТАВЛЕН!`);
            await ctx.answerCbQuery("Отличная работа!");
        } catch (err) {
            try { await ctx.answerCbQuery("❌ Ошибка", {show_alert: true}); } catch(e){}
        }
    });

};