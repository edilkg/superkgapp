const { Markup } = require('telegraf');

module.exports = function setupCourierBot(courierBot, clientBot, supabase, ADMIN_GROUP_ID) {
    
    // 1. СТАРТ И РЕГИСТРАЦИЯ КУРЬЕРА
    courierBot.start(async (ctx) => {
        const id = ctx.from.id;
        if (ctx.chat.type !== 'private') return; // Регистрация только в личке

        const { data: courier } = await supabase.from('couriers').select('*').eq('id', id).maybeSingle();

        if (!courier) {
            await supabase.from('couriers').insert([{ id, name: ctx.from.first_name, status: 'waiting_approval' }]);
            return ctx.reply("Привет! Ты в панели курьера ТамакKG. 📢\nТвоя заявка отправлена администратору. Как только тебя одобрят, ты сможешь принимать заказы.");
        }

        if (courier.status === 'waiting_approval') {
            return ctx.reply("⏳ Твой аккаунт еще на проверке у админа.");
        }

        ctx.reply("✅ Ты в системе! Жди уведомлений о новых заказах в группе курьеров.");
    });

    // 2. ЛОГИКА ПРИНЯТИЯ ЗАКАЗА
    courierBot.action(/courier_take_(.+)/, async (ctx) => {
        try {
            const orderId = ctx.match[1];
            const courierId = ctx.from.id;

            // Проверяем, не забрал ли уже кто-то этот заказ
            const { data: order } = await supabase.from('orders').select('*').eq('id', orderId).maybeSingle();

            if (!order || order.courier_id) {
                return ctx.answerCbQuery("❌ Этот заказ уже забрали!");
            }

            // Назначаем курьера в базе
            await supabase.from('orders').update({ 
                courier_id: courierId, 
                status: 'delivery' 
            }).eq('id', orderId);

            // 1. Убираем кнопки в общей группе, чтобы другие не жали
            await ctx.editMessageText(`🏃‍♂️ Заказ #${String(orderId).slice(0,5)} забрал курьер ${ctx.from.first_name || 'Инкогнито'}`);

            // 2. ОТПРАВЛЯЕМ ПОЛНЫЕ ДАННЫЕ КУРЬЕРУ В ЛИЧКУ
            const fullDetails = `📦 ДЕТАЛИ ЗАКАЗА #${String(orderId).slice(0,5)}\n\n` +
                                `🏢 Ресторан: ${order.restaurant}\n` +
                                `📍 Адрес доставки: ${order.address}\n` +
                                `💰 Сумма к оплате: ${order.total_price} сом\n` +
                                `👤 Клиент: ${order.client_name}\n` +
                                `📝 Комментарий: ${order.comment || 'нет'}\n\n` +
                                `Нажми кнопку, когда доставишь:`;

            await courierBot.telegram.sendMessage(courierId, fullDetails, 
                Markup.inlineKeyboard([
                    [Markup.button.callback('✅ ДОСТАВЛЕНО!', `courier_done_${orderId}`)]
                ])
            );

            await ctx.answerCbQuery("Заказ принят! Детали в личке.");

            // 3. Уведомляем клиента
            if (order.client_id) {
                await clientBot.telegram.sendMessage(order.client_id, "🚀 Курьер уже забрал ваш заказ и выезжает!");
            }

        } catch (e) {
            console.error(e);
            ctx.answerCbQuery("Ошибка при принятии заказа.");
        }
    });

    // 3. ЗАВЕРШЕНИЕ ЗАКАЗА
    courierBot.action(/courier_done_(.+)/, async (ctx) => {
        const orderId = ctx.match[1];
        await supabase.from('orders').update({ status: 'completed' }).eq('id', orderId);
        
        await ctx.editMessageText(`✅ Заказ #${String(orderId).slice(0,5)} успешно доставлен! Красава!`);
        
        // Финальное сообщение клиенту
        const { data: order } = await supabase.from('orders').select('client_id').eq('id', orderId).maybeSingle();
        if (order && order.client_id) {
            await clientBot.telegram.sendMessage(order.client_id, "😋 Приятного аппетита! Заказ доставлен.");
        }
    });

    console.log('📦 Модуль Courier (Private PM Mode) загружен');
};