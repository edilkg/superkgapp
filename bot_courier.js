const { Markup } = require('telegraf');

module.exports = function setupCourierBot(courierBot, clientBot, supabase, ADMIN_GROUP_ID) {
    
    // 1. СТАРТ И РЕГИСТРАЦИЯ
    courierBot.start(async (ctx) => {
        try {
            const id = ctx.from.id;
            if (ctx.chat.type !== 'private') return;

            const { data: courier } = await supabase.from('couriers').select('*').eq('id', id).maybeSingle();

            if (!courier) {
                await supabase.from('couriers').insert([{ 
                    id, 
                    name: ctx.from.first_name, 
                    status: 'waiting_approval' 
                }]);
                return ctx.reply("Привет! Ты в панели курьера ТамакKG. 📦\n\nТвоя заявка отправлена админу. Жди уведомления об одобрении!");
            }

            if (courier.status === 'waiting_approval') {
                return ctx.reply("⏳ Твой аккаунт всё еще на проверке. Мы напишем тебе, когда тебя одобрят.");
            }

            ctx.reply("✅ Ты на линии! Новые заказы будут приходить сюда в личку.");
        } catch (e) {
            console.error(e);
            ctx.reply("⚠️ Ошибка при регистрации.");
        }
    });

    // 2. ПРИНЯТИЕ ЗАКАЗА (Кнопка "Я заберу")
    courierBot.action(/courier_take_(.+)/, async (ctx) => {
        try {
            const orderId = ctx.match[1];
            const courierId = ctx.from.id;

            // Проверяем статус заказа в БД (не забрал ли уже другой?)
            const { data: order } = await supabase.from('orders').select('*').eq('id', orderId).maybeSingle();

            if (!order) return ctx.answerCbQuery("❌ Заказ не найден.");
            
            if (order.courier_id) {
                await ctx.editMessageText(`😔 Извини, этот заказ уже забрал другой курьер.`);
                return ctx.answerCbQuery();
            }

            // Назначаем курьера и меняем статус
            await supabase.from('orders').update({ 
                courier_id: courierId, 
                status: 'delivery' 
            }).eq('id', orderId);

            // Обновляем сообщение у курьера (добавляем инфо клиента)
            const fullInfo = `🚀 ЗАКАЗ В РАБОТЕ #${String(orderId).slice(0,5)}\n\n` +
                             `🏢 Ресторан: ${order.restaurant}\n` +
                             `📍 Куда: ${order.address}\n` +
                             `👤 Клиент: ${order.client_name}\n` +
                             `💰 Оплата: ${order.total_price} сом\n\n` +
                             `Нажми кнопку ниже, когда доставишь еду:`;

            await ctx.editMessageText(fullInfo, Markup.inlineKeyboard([
                [Markup.button.callback('✅ ДОСТАВИЛ (ЗАВЕРШИТЬ)', `courier_done_${orderId}`)]
            ]));

            ctx.answerCbQuery("Приятной поездки! 🛵");

            // Пишем клиенту через Клиентского бота
            if (order.client_id) {
                await clientBot.telegram.sendMessage(order.client_id, "🚀 Курьер принял ваш заказ и уже выезжает из ресторана!");
            }

        } catch (e) {
            console.error("Ошибка принятия заказа:", e);
            ctx.answerCbQuery("Произошла ошибка.");
        }
    });

    // 3. ЗАВЕРШЕНИЕ ЗАКАЗА
    courierBot.action(/courier_done_(.+)/, async (ctx) => {
        const orderId = ctx.match[1];
        await supabase.from('orders').update({ status: 'completed' }).eq('id', orderId);
        
        await ctx.editMessageText(`✅ Заказ #${String(orderId).slice(0,5)} выполнен! Деньги зачислены на баланс.`);
        
        const { data: order } = await supabase.from('orders').select('client_id').eq('id', orderId).maybeSingle();
        if (order && order.client_id) {
            await clientBot.telegram.sendMessage(order.client_id, "😋 Заказ доставлен! Приятного аппетита.");
        }
    });

    console.log('📦 Модуль Courier (Yandex Style) загружен');
};