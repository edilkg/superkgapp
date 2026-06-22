// bot_courier.js
const { Markup } = require('telegraf');

module.exports = function setupCourierBot(courierBot, bot, restBot, supabase, ADMIN_GROUP_ID) {
    
    // 1. СТАРТ И ПРОФИЛЬ
    courierBot.start(async (ctx) => {
        try {
            const id = ctx.from.id;
            const { data: courier } = await supabase.from('couriers').select('*').eq('id', id).maybeSingle();

            if (!courier) {
                await supabase.from('couriers').insert([{ id, name: ctx.from.first_name, status: 'waiting_approval', balance: 0 }]);
                ctx.reply("Привет! Заявка отправлена админу. Жди одобрения.");
                
                // ПРОСТО ОТПРАВЛЯЕМ УВЕДОМЛЕНИЕ АДМИНУ ЧЕРЕЗ ГЛАВНОГО БОТА (clientBot)
                return clientBot.telegram.sendMessage(ADMIN_GROUP_ID, 
                    `🛵 НОВАЯ ЗАЯВКА (КУРЬЕР)\nИмя: ${ctx.from.first_name}\nID: ${id}`,
                    Markup.inlineKeyboard([[Markup.button.callback('✅ ОДОБРИТЬ КУРЬЕРА', `approve_courier_${id}`)]])
                );
            }

            if (courier.status === 'waiting_approval') return ctx.reply("⏳ Твой аккаунт на проверке.");

            ctx.reply(`👤 ЛИЧНЫЙ КАБИНЕТ\n\nИмя: ${courier.name}\n💰 Баланс: ${courier.balance || 0} сом\nСтатус: На линии ✅`);
        } catch (e) { console.error(e); }
    });

    // 2. ПРИНЯТИЕ И ЗАВЕРШЕНИЕ ЗАКАЗА
    // ==========================================
    // 1. КУРЬЕР БЕРЕТ ЗАКАЗ (ЕДЕТ В РЕСТОРАН)
    // ==========================================
    // ==========================================
    // 1. КУРЬЕР БЕРЕТ ЗАКАЗ (ЕДЕТ В РЕСТОРАН)
    // ==========================================
    courierBot.action(/courier_take_(.+)/, async (ctx) => {
        const orderId = ctx.match[1];
        const courierId = ctx.from.id;

        try {
            // 1. Проверяем, не забрал ли уже заказ другой курьер
            const { data: orderCheck, error: checkErr } = await supabase.from('orders').select('courier_id, restaurant').eq('id', orderId).maybeSingle();
            
            if (checkErr || !orderCheck) {
                return ctx.answerCbQuery("❌ Заказ не найден", { show_alert: true });
            }
            
            if (orderCheck.courier_id && orderCheck.courier_id !== courierId) {
                return ctx.answerCbQuery("❌ Этот заказ уже взял другой курьер", { show_alert: true });
            }

            // 2. Бронируем заказ за курьером
            const { error: updateErr } = await supabase.from('orders').update({ courier_id: courierId }).eq('id', orderId);
            if (updateErr) throw updateErr;

            // 3. Данные курьера берем прямо из его профиля Телеграм (Без нагрузки на БД!)
            const cName = ctx.from.first_name || 'Курьер';
            const cUsername = ctx.from.username ? '@' + ctx.from.username : `(Без юзернейма, ID: ${courierId})`;

            // 4. Уведомляем админа
            try {
                await bot.telegram.sendMessage(ADMIN_GROUP_ID, `🛵 Курьер выехал в ресторан за заказом #${String(orderId).slice(0,5)}:\n👤 ${cName}\n💬 Связь: ${cUsername}`);
            } catch(e) {}

            // 5. Уведомляем ресторан
            if (orderCheck.restaurant) {
                const { data: restData } = await supabase.from('restaurants').select('id').eq('name', orderCheck.restaurant).maybeSingle();
                if (restData) {
                    try {
                        await restBot.telegram.sendMessage(restData.id, `🛵 К вам за заказом #${String(orderId).slice(0,5)} выехал курьер:\n👤 ${cName}\n💬 Связь: ${cUsername}`);
                    } catch(e) {}
                }
            }

            // 6. Меняем кнопку у самого курьера на следующий шаг
            await ctx.editMessageText(
                ctx.callbackQuery.message.text + `\n\n✅ ВЫ ПРИНЯЛИ ЗАКАЗ!\nОтправляйтесь в ресторан. Как только заберете еду, нажмите кнопку ниже:`,
                Markup.inlineKeyboard([
                    [Markup.button.callback('📦 Я взял заказ (Еду к клиенту)', `courier_picked_up_${orderId}`)]
                ])
            );
            
            await ctx.answerCbQuery("✅ Вы назначены на заказ!");
        } catch (err) {
            console.error("Ошибка при взятии заказа курьером:", err.message);
            ctx.answerCbQuery("❌ Ошибка базы данных");
        }
    });

    // ==========================================
    // 2. КУРЬЕР ЗАБРАЛ ЗАКАЗ (ВКЛЮЧАЕТ СТАТУС 3 ДЛЯ КЛИЕНТА)
    // ==========================================
    courierBot.action(/courier_picked_up_(.+)/, async (ctx) => {
        const orderId = ctx.match[1];

        try {
            // 👉 МЕНЯЕМ СТАТУС В БАЗЕ (Клиент увидит: "Курьер забрал заказ и едет к вам!")
            await supabase.from('orders').update({ status: 'delivery' }).eq('id', orderId);

            // Обновляем кнопку у курьера
            await ctx.editMessageText(
                ctx.callbackQuery.message.text + `\n\n🛵 ВЫ В ПУТИ К КЛИЕНТУ!\nКак только отдадите еду, нажмите кнопку:`,
                Markup.inlineKeyboard([
                    [Markup.button.callback('✅ Я доставил заказ', `courier_delivered_${orderId}`)]
                ])
            );
            await ctx.answerCbQuery("Выехали к клиенту!");
        } catch (err) {
            console.error("Ошибка при статусе 'в пути':", err);
        }
    });

    // ==========================================
    // 3. КУРЬЕР ДОСТАВИЛ ЗАКАЗ (ВКЛЮЧАЕТ СТАТУС 4 ДЛЯ КЛИЕНТА)
    // ==========================================
    courierBot.action(/courier_delivered_(.+)/, async (ctx) => {
        const orderId = ctx.match[1];

        try {
            // 👉 МЕНЯЕМ СТАТУС В БАЗЕ (Клиент увидит: "Заказ доставлен! Спасибо, что выбрали нас!")
            await supabase.from('orders').update({ status: 'completed' }).eq('id', orderId);

            // Убираем кнопки у курьера, оставляем только текст
            await ctx.editMessageText(ctx.callbackQuery.message.text + `\n\n🎉 ЗАКАЗ УСПЕШНО ДОСТАВЛЕН!`);
            await ctx.answerCbQuery("Отличная работа!");
        } catch (err) {
            console.error("Ошибка при статусе 'доставлен':", err);
        }
    });

};