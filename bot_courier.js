const { Markup } = require('telegraf');

module.exports = function setupCourierBot(courierBot, bot, supabase, ADMIN_GROUP_ID) {

    // Клавиатура меню курьера
    const getCourierMenu = (isApproved, status) => {
        if (!isApproved) return Markup.keyboard([['⏳ Ожидание одобрения...']]).resize();
        const statusBtn = status === 'online' ? '🔴 Уйти с линии' : '🟢 Выйти на линию';
        return Markup.keyboard([[statusBtn], ['📊 Моя статистика', '💳 Баланс']]).resize();
    };

    // 1. СТАРТ И РЕГИСТРАЦИЯ
    courierBot.start(async (ctx) => {
        const id = ctx.from.id;
        const { data: courier } = await supabase.from('couriers').select('*').eq('id', id).single();

        if (!courier) {
            await supabase.from('couriers').insert([{ id, name: ctx.from.first_name, step: 'ask_phone', balance: 0 }]);
            return ctx.reply("Привет! Ты хочешь стать курьером ТамакKG?\nНапиши свой номер телефона для регистрации:");
        }
        ctx.reply("Панель управления курьера:", getCourierMenu(courier.is_approved, courier.status));
    });

    // 2. ОБРАБОТКА ТЕКСТА (Телефон и Смены)
    courierBot.on('text', async (ctx) => {
        const id = ctx.from.id;
        const msg = ctx.message.text;
        const { data: courier } = await supabase.from('couriers').select('*').eq('id', id).single();

        if (!courier) return;

        // Шаг регистрации
        if (courier.step === 'ask_phone') {
            await supabase.from('couriers').update({ phone: msg, step: 'completed' }).eq('id', id);
            ctx.reply("✅ Заявка отправлена! Админ проверит её в ближайшее время.");
            
            // Отправляем админу на одобрение (через главный бот)
            bot.telegram.sendMessage(ADMIN_GROUP_ID, `🆕 Новый курьер!\n👤: ${courier.name}\n📱: ${msg}\n🆔: ${id}`,
                Markup.inlineKeyboard([[Markup.button.callback('✅ ОДОБРИТЬ', `approve_${id}`)]])
            );
            return;
        }

        if (!courier.is_approved) return ctx.reply("⏳ Твой аккаунт еще на проверке.");

        // Управление сменой
        if (msg === '🟢 Выйти на линию') {
            await supabase.from('couriers').update({ status: 'online' }).eq('id', id);
            ctx.reply("📡 Ты на линии! Жди новые заказы.", getCourierMenu(true, 'online'));
        } else if (msg === '🔴 Уйти с линии') {
            await supabase.from('couriers').update({ status: 'offline' }).eq('id', id);
            ctx.reply("😴 Ты ушел с линии. Отдыхай!", getCourierMenu(true, 'offline'));
        }
    });

    // 3. ПРИНЯТИЕ ЗАКАЗА И СТАТУСЫ
    courierBot.action(/accept_(.+)/, async (ctx) => {
        const orderId = ctx.match[1];
        
        // Проверяем, не забрали ли заказ
        const { data: order } = await supabase.from('orders').select('*').eq('id', orderId).single();
        if (!order || order.status !== 'pending') {
            return ctx.answerCbQuery("❌ Заказ уже забрал другой курьер!", { show_alert: true });
        }

        // Бронируем заказ за курьером
        await supabase.from('orders').update({ status: 'accepted', courier_id: ctx.from.id }).eq('id', orderId);
        ctx.answerCbQuery("Заказ твой! Удачи!");

        ctx.editMessageText(`✅ Ты взял заказ #${orderId.slice(0,5)}\n📍 Езжай забирать: ${order.restaurant}\n🏠 Куда отвезти: ${order.address}`, 
            Markup.inlineKeyboard([[Markup.button.callback('📍 Я в ресторане', `at_res_${orderId}`)]])
        );
        
        // Уведомляем клиента
        if (order.client_id) {
            try { bot.telegram.sendMessage(order.client_id, `🚴 Курьер принял ваш заказ #${orderId.slice(0,5)}!\nОн уже едет в ресторан.`); } catch(e){}
        }
    });

    courierBot.action(/at_res_(.+)/, async (ctx) => {
        const orderId = ctx.match[1];
        await supabase.from('orders').update({ status: 'at_restaurant' }).eq('id', orderId);
        
        const { data: order } = await supabase.from('orders').select('client_id').eq('id', orderId).single();
        if (order && order.client_id) {
            try { bot.telegram.sendMessage(order.client_id, "🏢 Курьер прибыл в ресторан. Ваш заказ собирается!"); } catch(e){}
        }

        ctx.editMessageText(`✅ Ты в ресторане. Забирай еду и нажимай кнопку:`, 
            Markup.inlineKeyboard([[Markup.button.callback('🥡 Забрал, еду к клиенту', `delivering_${orderId}`)]])
        );
    });

    courierBot.action(/delivering_(.+)/, async (ctx) => {
        const orderId = ctx.match[1];
        await supabase.from('orders').update({ status: 'delivering' }).eq('id', orderId);
        
        const { data: order } = await supabase.from('orders').select('client_id, address').eq('id', orderId).single();
        if (order && order.client_id) {
            try { bot.telegram.sendMessage(order.client_id, "🚀 Курьер забрал заказ! Встречайте в ближайшее время."); } catch(e){}
        }

        ctx.editMessageText(`🚴 Ты в пути. Поспеши, клиент голоден!\n🏠 Адрес: ${order.address}`, 
            Markup.inlineKeyboard([[Markup.button.callback('🏁 Доставил!', `done_${orderId}`)]])
        );
    });

    courierBot.action(/done_(.+)/, async (ctx) => {
        const orderId = ctx.match[1];
        await supabase.from('orders').update({ status: 'delivered' }).eq('id', orderId);
        
        const { data: order } = await supabase.from('orders').select('client_id').eq('id', orderId).single();
        if (order && order.client_id) {
            try { bot.telegram.sendMessage(order.client_id, "✅ Заказ доставлен! Приятного аппетита! 🍽"); } catch(e){}
        }

        ctx.editMessageText(`🏁 Заказ #${orderId.slice(0,5)} успешно завершен. Хорошая работа!`);
    });

    console.log('📦 Модуль Courier загружен');
};