const { Markup } = require('telegraf');

// Функция защиты от крашей Telegram при отправке спецсимволов
const safeHtml = (str) => String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

module.exports = function setupCourierBot(courierBot, bot, restBot, supabase, ADMIN_GROUP_ID, activeCouriers = new Map(), dispatcher = null) {
    
    // ==========================================
    // 0. СТАРТ И ПРОФИЛЬ
    // ==========================================
    // ==========================================
    // КЛАВИАТУРЫ КУРЬЕРА (ДИНАМИЧЕСКИЕ СМЕНЫ)
    // ==========================================
    
    // Клавиатура ОФФЛАЙН (Не на смене)
    const getOfflineKeyboard = (id) => Markup.keyboard([
        ['🟢 Выйти на линию'],
        ['👤 Профиль'],
        [Markup.button.webApp('💳 Пополнить баланс', `https://superkgapp.vercel.app/courier_pay.html?id=${id}`)]
    ]).resize();

    // Клавиатура ОНЛАЙН (На смене)
    const getOnlineKeyboard = (id) => Markup.keyboard([
        ['📋 Мои заказы'],
        ['🔴 Закончить смену', '👤 Профиль'],
        [Markup.button.webApp('💳 Пополнить баланс', `https://superkgapp.vercel.app/courier_pay.html?id=${id}`)]
    ]).resize();

    const getCourierKeyboard = (id, isOnShift) => isOnShift ? getOnlineKeyboard(id) : getOfflineKeyboard(id);

    // ==========================================
    // 0. СТАРТ И РЕГИСТРАЦИЯ КУРЬЕРА
    // ==========================================
    courierBot.start(async (ctx) => {
        try {
            const id = ctx.from?.id;
            if (!id) return;

            const { data: courier } = await supabase.from('couriers').select('*').eq('id', id).maybeSingle();

            if (!courier) {
                await supabase.from('couriers').insert([{ id, name: ctx.from.first_name || 'Курьер', status: 'offline', step: 'ask_phone', balance: 0 }]);
                return ctx.reply("Привет! Чтобы стать курьером, отправь свой номер телефона, нажав на кнопку ниже:", 
                    Markup.keyboard([[Markup.button.contactRequest('📱 Отправить мой номер')]]).resize()
                );
            }

            if (courier.step === 'ask_phone') {
                return ctx.reply("Пожалуйста, отправь свой номер телефона:", 
                    Markup.keyboard([[Markup.button.contactRequest('📱 Отправить мой номер')]]).resize()
                );
            }

            if (courier.status === 'waiting_approval') {
                return ctx.reply("⏳ Твой аккаунт на проверке. Ожидайте одобрения администратора.", Markup.removeKeyboard());
            }

            const isOnShift = activeCouriers.has(id) || Boolean(courier.is_online);
            const statusText = isOnShift ? '🟢 На смене (получаете заказы)' : '🔴 Не на смене (оффлайн)';
            const hintText = isOnShift 
                ? 'Чтобы закончить работу, нажмите кнопку <b>«🔴 Закончить смену»</b>.'
                : '💡 <b>Чтобы начать получать заказы</b>, нажмите <b>«🟢 Выйти на линию»</b> и запустите трансляцию геопозиции.';

            return ctx.reply(
                `👤 <b>ЛИЧНЫЙ КАБИНЕТ КУРЬЕРА</b>\n\n` +
                `Имя: <b>${safeHtml(courier.name || ctx.from.first_name || 'Курьер')}</b>\n` +
                `Телефон: ${safeHtml(courier.phone || 'Не указан')}\n` +
                `Баланс: <b>${courier.balance || 0} сом</b>\n` +
                `Статус: <b>${statusText}</b>\n\n` +
                `${hintText}\n\n` +
                `Для пополнения баланса нажмите кнопку ниже или напишите админу: @foodkg_admin`,
                { parse_mode: 'HTML', ...getCourierKeyboard(id, isOnShift) }
            );
        } catch (e) { 
            console.error("Ошибка при старте курьера:", e); 
        }
    });

    courierBot.on('contact', async (ctx) => {
        try {
            const id = ctx.from.id;
            const { data: courier } = await supabase.from('couriers').select('step').eq('id', id).maybeSingle();
            if (!courier || courier.step !== 'ask_phone') return;

            const phone = ctx.message.contact.phone_number;
            await supabase.from('couriers').update({ phone: phone, step: 'completed', status: 'waiting_approval' }).eq('id', id);
            await ctx.reply("✅ Спасибо! Заявка отправлена администратору. Ожидайте одобрения.", Markup.removeKeyboard());

            return bot.telegram.sendMessage(ADMIN_GROUP_ID, 
                `🛵 НОВАЯ ЗАЯВКА (КУРЬЕР)\nИмя: ${safeHtml(ctx.from.first_name || 'Не указано')}\nТелефон: ${phone}\nID: ${id}`,
                Markup.inlineKeyboard([[Markup.button.callback('✅ ОДОБРИТЬ КУРЬЕРА', `approve_courier_${id}`)]])
            );
        } catch (e) { console.error("Ошибка контакта:", e); }
    });

    // ==========================================
    // СПИСОК АКТИВНЫХ ЗАКАЗОВ КУРЬЕРА (МАРШРУТНЫЙ ЛИСТ)
    // ==========================================
    courierBot.hears(['📋 Мои заказы', '/orders'], async (ctx) => {
        try {
            const courierId = ctx.from.id;
            const { data: orders, error } = await supabase
                .from('orders')
                .select('*')
                .eq('courier_id', courierId)
                .in('status', ['paid', 'cooking', 'delivery']);

            if (error || !orders || orders.length === 0) {
                return ctx.reply("📭 <b>У вас сейчас нет активных заказов.</b>\nКак только появится заказ по вашему маршруту, бот сразу пришлет уведомление!", { parse_mode: 'HTML' });
            }

            let msg = `🛵 <b>ВАШИ АКТИВНЫЕ ЗАКАЗЫ (${orders.length}):</b>\n\n`;

            if (orders.length > 1) {
                msg += `🧭 <i>Мультизаказ! Выполняйте точки по порядку:</i>\n\n`;
            }

            for (let idx = 0; idx < orders.length; idx++) {
                const ord = orders[idx];
                const isDelivered = ord.status === 'delivery';
                const statusIcon = isDelivered ? '🛵 В пути к клиенту' : '🍳 Готовится / забрать в ресторане';

                msg += `<b>${idx + 1}. Заказ #${String(ord.id).slice(0, 5)}</b> [${statusIcon}]\n` +
                       `🏢 Ресторан: <b>${safeHtml(ord.restaurant || 'Не указан')}</b>\n` +
                       `📍 Доставка: <u>${safeHtml(ord.address || 'Не указан')}</u>\n` +
                       `📞 Телефон: ${safeHtml(ord.phone || 'Не указан')}\n\n`;
            }

            const buttons = [];
            for (const ord of orders) {
                if (ord.status === 'delivery') {
                    buttons.push([Markup.button.callback(`✅ Я доставил заказ #${String(ord.id).slice(0, 5)}`, `courier_delivered_${ord.id}`)]);
                } else {
                    buttons.push([Markup.button.callback(`📦 Я забрал заказ #${String(ord.id).slice(0, 5)}`, `courier_picked_up_${ord.id}`)]);
                }
            }

            await ctx.reply(msg, {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: buttons }
            });
        } catch (e) {
            console.error("Ошибка при запросе активных заказов курьера:", e.message);
            ctx.reply("❌ Ошибка загрузки списка заказов.");
        }
    });

    courierBot.hears('👤 Профиль', async (ctx) => {
        try {
            const id = ctx.from.id;
            const { data: courier } = await supabase.from('couriers').select('*').eq('id', id).maybeSingle();
            if (!courier) return;
            if (courier.status === 'waiting_approval') {
                return ctx.reply("⏳ Твой аккаунт на проверке. Ожидайте одобрения администратора.", Markup.removeKeyboard());
            }

            const isOnShift = activeCouriers.has(id) || Boolean(courier.is_online);
            const statusText = isOnShift ? '🟢 На смене (получаете заказы)' : '🔴 Не на смене (оффлайн)';
            const hintText = isOnShift 
                ? 'Чтобы закончить работу, нажмите кнопку <b>«🔴 Закончить смену»</b>.'
                : '💡 <b>Чтобы начать получать заказы</b>, нажмите <b>«🟢 Выйти на линию»</b> и запустите трансляцию геопозиции.';

            return ctx.reply(
                `👤 <b>ЛИЧНЫЙ КАБИНЕТ КУРЬЕРА</b>\n\n` +
                `Имя: <b>${safeHtml(courier.name || ctx.from.first_name || 'Курьер')}</b>\n` +
                `Телефон: ${safeHtml(courier.phone || 'Не указан')}\n` +
                `Баланс: <b>${courier.balance || 0} сом</b>\n` +
                `Статус: <b>${statusText}</b>\n\n` +
                `${hintText}\n\n` +
                `Для пополнения нажмите кнопку ниже или напишите админу: @foodkg_admin`,
                { parse_mode: 'HTML', ...getCourierKeyboard(id, isOnShift) }
            );
        } catch (e) {
            console.error("Ошибка при открытии профиля:", e);
        }
    });

    // Курьер нажал «🟢 Выйти на линию»
    courierBot.hears('🟢 Выйти на линию', async (ctx) => {
        try {
            const id = ctx.from.id;
            const { data: courier } = await supabase.from('couriers').select('*').eq('id', id).maybeSingle();
            if (!courier || courier.status !== 'active') {
                return ctx.reply("⏳ Ваш аккаунт еще не одобрен администратором или не найден.");
            }

            const isOnShift = activeCouriers.has(id) || Boolean(courier.is_online);
            if (isOnShift) {
                return ctx.reply(
                    "🟢 Вы уже находитесь на линии и можете получать заказы!\n\nЕсли хотите завершить смену, нажмите «🔴 Закончить смену».",
                    getOnlineKeyboard(id)
                );
            }

            return ctx.reply(
                `📍 <b>Как выйти на линию и получать заказы:</b>\n\n` +
                `1. Нажмите на скрепку 📎 внизу экрана\n` +
                `2. Выберите <b>«Геопозиция»</b> 🗺\n` +
                `3. Нажмите <b>«Транслировать геопозицию»</b> (выберите <b>8 часов</b>)\n\n` +
                `<i>После отправки трансляции система зафиксирует вас на карте, кнопка сменится на «🔴 Закончить смену», и вам начнут поступать ближайшие заказы! 🛵💨</i>`,
                { parse_mode: 'HTML', ...getOfflineKeyboard(id) }
            );
        } catch (e) {
            console.error("Ошибка при '🟢 Выйти на линию':", e);
        }
    });

    // Курьер нажал «🔴 Закончить смену»
    courierBot.hears('🔴 Закончить смену', async (ctx) => {
        try {
            const id = ctx.from.id;
            
            // Удаляем из оперативной памяти
            activeCouriers.delete(id);

            // В базе выключаем онлайн
            try {
                await supabase.from('couriers').update({ is_online: false }).eq('id', id);
            } catch (e) {
                console.error("Ошибка обновления статуса в БД:", e);
            }

            return ctx.reply(
                `🛑 <b>Спасибо за работу! Смена завершена.</b> 🎉\n\n` +
                `Вы успешно вышли со смены и больше не получаете новые заказы.\n` +
                `Не забудьте остановить трансляцию геопозиции в чате (нажмите на карту ➡️ «Остановить трансляцию»).\n\n` +
                `Отдыхайте! Когда захотите снова выйти на смену — просто нажмите кнопку ниже:`,
                { parse_mode: 'HTML', ...getOfflineKeyboard(id) }
            );
        } catch (e) {
            console.error("Ошибка при '🔴 Закончить смену':", e);
        }
    });

    // Обработка текстового ввода (например, ручной ввод телефона при регистрации)
    courierBot.on('text', async (ctx, next) => {
        try {
            const id = ctx.from.id;
            const text = ctx.message.text;
            if (text.startsWith('/')) return next();

            const { data: courier } = await supabase.from('couriers').select('*').eq('id', id).maybeSingle();
            if (!courier) return next();

            if (courier.step === 'ask_phone') {
                await supabase.from('couriers').update({ phone: text, step: 'completed', status: 'waiting_approval' }).eq('id', id);
                await ctx.reply("✅ Спасибо! Заявка отправлена администратору. Ожидайте одобрения.", Markup.removeKeyboard());

                return bot.telegram.sendMessage(ADMIN_GROUP_ID, 
                    `🛵 НОВАЯ ЗАЯВКА (КУРЬЕР)\nИмя: ${safeHtml(ctx.from.first_name || 'Не указано')}\nТелефон: ${text}\nID: ${id}`,
                    Markup.inlineKeyboard([[Markup.button.callback('✅ ОДОБРИТЬ КУРЬЕРА', `approve_courier_${id}`)]])
                );
            }

            return next();
        } catch (e) {
            console.error("Ошибка в on('text') курьера:", e);
            return next();
        }
    });

    // ==========================================
    // ФОНОВАЯ ГЕОЛОКАЦИЯ: ПРИЕМ И ОБНОВЛЕНИЕ ТОЧКИ
    // ==========================================

    // 1. Курьер прислал геопозицию (первый запуск трансляции)
    courierBot.on('message', async (ctx, next) => {
        const id = ctx.from?.id;
        if (!id) return next();

        // Если прислали геопозицию
        if (ctx.message.location) {
            const isLive = Boolean(ctx.message.location.live_period);
            const lat = ctx.message.location.latitude;
            const lon = ctx.message.location.longitude;

            if (!isLive) {
                return ctx.reply(
                    `⚠️ Вы отправили статичную точку местоположения.\n\n` +
                    `Чтобы система видела ваши перемещения и давала ближайшие заказы, выберите именно <b>«Транслировать геопозицию»</b> (на 8 часов)! 📎 ➡️ Геопозиция ➡️ Транслировать.`,
                    { parse_mode: 'HTML', ...getOfflineKeyboard(id) }
                );
            }

            console.log(`📍 [START] КУРЬЕР ${id} ВЫШЕЛ НА ЛИНИЮ! Координаты сохранены в оперативный кэш.`);
            
            // Сохраняем в In-Memory кэш (0 мс, 0 запросов к БД)
            activeCouriers.set(id, {
                lat: lat,
                lon: lon,
                lastUpdate: Date.now(),
                name: ctx.from.first_name || 'Курьер'
            });

            // В базе меняем статус онлайна
            try {
                await supabase.from('couriers').update({ is_online: true }).eq('id', id);
            } catch (e) {
                console.error("Ошибка обновления is_online курьера:", e);
            }

            return ctx.reply(
                `✅ <b>Вы успешно вышли на линию!</b> 🛵\n\n` +
                `Геолокация активна. Теперь вы находитесь в системе распределения и будете получать ближайшие заказы ресторанов.\n\n` +
                `Когда захотите завершить работу, нажмите кнопку <b>«🔴 Закончить смену»</b> ниже.`,
                { parse_mode: 'HTML', ...getOnlineKeyboard(id) }
            );
        }

        return next();
    });

    // 2. Ловим фоновые обновления (каждые 15-30 секунд от Telegram) или остановку трансляции
    courierBot.on('edited_message', async (ctx) => {
        try {
            const id = ctx.from?.id;
            if (!id || !ctx.editedMessage) return;

            // Если курьер остановил трансляцию вручную (в Telegram при остановке location может отсутствовать)
            if (!ctx.editedMessage.location) {
                if (activeCouriers.has(id)) {
                    activeCouriers.delete(id);
                    try {
                        await supabase.from('couriers').update({ is_online: false }).eq('id', id);
                    } catch (e) {}
                    try {
                        await ctx.reply(
                            `🛑 <b>Трансляция остановлена. Смена завершена!</b>\nСпасибо за работу! 🎉\n\nЧтобы снова начать принимать заказы — нажмите кнопку ниже:`,
                            { parse_mode: 'HTML', ...getOfflineKeyboard(id) }
                        );
                    } catch (e) {}
                }
                return;
            }

            // Если геопозиция получена:
            // Проверяем: если курьер уже нажал "Закончить смену" (оффлайн), не возобновляем смену от остаточных фоновых пингов
            if (!activeCouriers.has(id)) {
                const { data: c } = await supabase.from('couriers').select('is_online, status').eq('id', id).maybeSingle();
                if (!c || c.status !== 'active' || !c.is_online) {
                    return; // Курьер оффлайн — фоновые пинги игнорируются
                }
            }

            const lat = ctx.editedMessage.location.latitude;
            const lon = ctx.editedMessage.location.longitude;

            activeCouriers.set(id, {
                lat: lat,
                lon: lon,
                lastUpdate: Date.now(),
                name: ctx.from.first_name || 'Курьер'
            });
        } catch (e) {
            console.error("Ошибка в edited_message курьера:", e);
        }
    });

    // ==========================================
    // 3. УМНЫЙ ТАЙМЕР НЕАКТИВНОСТИ ГЕОПОЗИЦИИ
    // ==========================================
    // В Telegram Bot API нет события "курьер нажал Остановить трансляцию" в приложении.
    // Telegram просто молча перестает слать координаты.
    // Поэтому мы каждые 20 секунд проверяем: если гео-пинг не поступал более 2 минут (120 секунд) —
    // автоматически переводим курьера в оффлайн, присылаем "Спасибо за работу!"
    // и меняем кнопку на "🟢 Выйти на линию".
    const LOCATION_INACTIVITY_MS = 2 * 60 * 1000; // 2 минуты тишины от Telegram (защита от ложных отключений при спящем экране)

    setInterval(async () => {
        try {
            const now = Date.now();
            for (const [courierId, data] of activeCouriers.entries()) {
                const timeSinceLastUpdate = now - (data.lastUpdate || 0);

                if (timeSinceLastUpdate > LOCATION_INACTIVITY_MS) {
                    console.log(`⏱ [ТАЙМЕР] Гео-пинг курьера ${courierId} прекратился (${Math.round(timeSinceLastUpdate / 1000)}с назад). Завершаем смену автоматически.`);
                    
                    // Удаляем из оперативной памяти
                    activeCouriers.delete(courierId);

                    // В базе переводим в оффлайн
                    try {
                        await supabase.from('couriers').update({ is_online: false }).eq('id', courierId);
                    } catch (e) {
                        console.error("Ошибка обновления статуса курьера в БД:", e.message);
                    }

                    // Отправляем уведомление курьеру
                    try {
                        await courierBot.telegram.sendMessage(
                            courierId,
                            `🛑 <b>Трансляция геопозиции прекращена. Смена завершена!</b>\n\n` +
                            `Система больше не получает координаты, заказы перестали поступать.\n` +
                            `Спасибо за работу! 🎉\n\n` +
                            `Когда захотите снова выйти на смену — просто нажмите кнопку ниже:`,
                            { parse_mode: 'HTML', ...getOfflineKeyboard(courierId) }
                        );
                    } catch (e) {
                        console.error(`Не удалось отправить сообщение курьеру ${courierId}:`, e.message);
                    }
                }
            }
        } catch (err) {
            console.error("Ошибка в таймере неактивности геопозиции:", err.message);
        }
    }, 15 * 1000); // Проверка каждые 15 секунд

    // ==========================================
    // 1. КУРЬЕР БЕРЕТ ЗАКАЗ ИЗ ОБЩЕЙ ГРУППЫ
    // ==========================================
    courierBot.action(/(?:courier_take_|take_order_)(.+)/, async (ctx) => {
        // Очищаем ID от любых случайных пробелов или скрытых символов!
        const orderId = String(ctx.match[1]).trim(); 
        const courierId = ctx.from.id;

        console.log(`[КУРЬЕР] Попытка взять заказ. ID заказа: ${orderId}, ID курьера: ${courierId}`);

        try {
            // Проверка баланса курьера
            const { data: courierCheck } = await supabase.from('couriers').select('balance').eq('id', courierId).maybeSingle();
            if (!courierCheck) {
                console.log("[КУРЬЕР] Ошибка: Курьер не найден в БД.");
                return ctx.answerCbQuery("❌ Ошибка: курьер не найден", { show_alert: true });
            }
            
            if ((courierCheck.balance || 0) <= 0) {
                return ctx.answerCbQuery("❌ Ваш баланс 0 или ниже! Пополните счет, чтобы брать заказы.", { show_alert: true });
            }

            // Проверка статуса заказа
            const { data: orderCheck, error: checkErr } = await supabase.from('orders').select('*').eq('id', orderId).maybeSingle();
            if (checkErr || !orderCheck) {
                console.error("[КУРЬЕР] Ошибка поиска заказа:", checkErr);
                return ctx.answerCbQuery("❌ Заказ не найден", { show_alert: true });
            }

            if (orderCheck.status === 'canceled') {
                await ctx.answerCbQuery("❌ Отбой! Ресторан отменил этот заказ.", { show_alert: true });
                const currentText = ctx.callbackQuery.message.text || 'Заказ';
                return ctx.editMessageText(currentText + `\n\n❌ ОТМЕНЕН РЕСТОРАНОМ`).catch(() => {});
            }
            
            if (orderCheck.courier_id && orderCheck.courier_id !== courierId) {
                await ctx.answerCbQuery("❌ Опоздали! Заказ взял другой курьер", { show_alert: true });
                const currentText = ctx.callbackQuery.message.text || 'Заказ';
                return ctx.editMessageText(currentText + `\n\n❌ ЗАБРАЛ ДРУГОЙ КУРЬЕР`).catch(() => {});
            }

            // Проверяем дистанцию курьера для определения "Заказ без комиссии" (>= 3.5 км)
            let isZeroCommission = false;
            if (dispatcher && typeof dispatcher.getOrderCourierDistance === 'function') {
                const courierDistance = dispatcher.getOrderCourierDistance(orderId, courierId);
                if (courierDistance >= 3500) {
                    isZeroCommission = true;
                }
            }
            if (!isZeroCommission && orderCheck.comment && orderCheck.comment.includes('БЕЗ КОМИССИИ')) {
                isZeroCommission = true;
            }

            let newBalance = courierCheck.balance || 0;

            // 👉 ЛОГИКА НАЗНАЧЕНИЯ В БАЗЕ (Ручной вызов vs Обычный заказ)
            let updatedComment = orderCheck.comment || '';
            if (isZeroCommission && !updatedComment.includes('БЕЗ КОМИССИИ')) {
                updatedComment = updatedComment ? `${updatedComment} | 🎁 БЕЗ КОМИССИИ (>3.5км)` : '🎁 БЕЗ КОМИССИИ (>3.5км)';
            }

            if (orderCheck.is_manual) {
                if (!isZeroCommission) {
                    newBalance -= 20;
                }
                await supabase.from('orders').update({
                    courier_id: courierId,
                    status: 'completed',
                    ...(updatedComment !== (orderCheck.comment || '') ? { comment: updatedComment } : {})
                }).eq('id', orderId);

                if (!isZeroCommission) {
                    await supabase.from('couriers').update({ balance: newBalance }).eq('id', courierId);
                }
            } else {
                await supabase.from('orders').update({
                    courier_id: courierId,
                    ...(updatedComment !== (orderCheck.comment || '') ? { comment: updatedComment } : {})
                }).eq('id', orderId);
            }

            const { data: courierData } = await supabase.from('couriers').select('name, phone').eq('id', courierId).maybeSingle();
            const cName = courierData?.name || ctx.from.first_name || 'Курьер';
            const cPhone = courierData?.phone || 'Номер не указан';
            
            const notifyMessage = `🛵 Курьер едет за заказом #${String(orderId).slice(0,5)}\n👤 Курьер: ${cName}\n📞 Телефон: ${cPhone}`;
            try { await bot.telegram.sendMessage(ADMIN_GROUP_ID, notifyMessage); } catch(e) { console.error("Не смог отправить админу", e.message); }
            
            if (orderCheck.restaurant) {
                const { data: restData } = await supabase.from('restaurants').select('id').eq('name', orderCheck.restaurant).maybeSingle();
                if (restData) {
                    try { await restBot.telegram.sendMessage(restData.id, notifyMessage); } catch(e) { console.error("Не смог отправить в рест", e.message); }
                }
            }

            // Завершаем сессию диспетчера, так как заказ успешно взят!
            if (dispatcher) {
                if (typeof dispatcher.addCourierOrder === 'function') {
                    dispatcher.addCourierOrder(courierId, orderId);
                }
                dispatcher.finishSession(orderId);
            }

            // ИСПРАВЛЕНИЕ БАГА ГРУППЫ: Изменяем текст максимально безопасно
            const groupMsg = ctx.callbackQuery.message.text || `Заказ #${String(orderId).slice(0,5)}`;
            await ctx.editMessageText(`${groupMsg}\n\n✅ ЗАКАЗ ВЗЯЛ: ${cName}`).catch((e) => console.error("Ошибка editMessageText:", e.message));
            
            await ctx.answerCbQuery("✅ Вы назначены на заказ! Подробности в ЛС.");

            // 👉 ФОРМИРУЕМ СООБЩЕНИЕ В ЛИЧКУ КУРЬЕРУ
            let privateText = '';
            const buttons = [];

            if (orderCheck.is_manual) {
                const commText = isZeroCommission ? '0 сом (Заказ от 3.5 км без комиссии! 🎁)' : '20 сом';
                privateText = `📦 <b>Детали РУЧНОГО заказа #${String(orderId).slice(0,5)}</b>\n` +
                              `📍 Забрать из: <b>${safeHtml(orderCheck.restaurant)}</b>\n` +
                              `📞 <b>Данные клиента:</b>\n${safeHtml(orderCheck.address)}\n\n` +
                              `💸 Комиссия за заказ: ${commText}\n` +
                              `💳 Остаток Баланса: ${newBalance} сом`;
            } else {
                buttons.push([Markup.button.callback('📦 Я взял заказ (Еду к клиенту)', `courier_picked_up_${orderId}`)]);

                let deliveryPriceText = 0;
                let foodPrice = 0;
                try { 
                    const itemsArr = Array.isArray(orderCheck.items) ? orderCheck.items : JSON.parse(orderCheck.items || '[]');
                    itemsArr.forEach(i => {
                        const price = Number(i.price || (i.item ? i.item.price : 0)) || 0;
                        const count = Number(i.count) || 0;
                        foodPrice += price * count;
                    });
                    deliveryPriceText = Math.max(0, (orderCheck.total_price || 0) - foodPrice);
                } catch(e) {
                    console.error("Ошибка парсинга цены доставки", e);
                }

                let addressSuffix = '';
                let displayComment = orderCheck.comment || 'Нет комментариев';

                if (displayComment.includes('🏪 Адрес ресторана:')) {
                    const parts = displayComment.split(' | ');
                    const addrPart = parts.find(p => p.includes('🏪 Адрес ресторана:'));
                    if (addrPart) {
                        addressSuffix = ` (${addrPart.replace('🏪 Адрес ресторана:', '').trim()})`;
                        displayComment = parts.filter(p => !p.includes('🏪 Адрес ресторана:')).join(' | ') || 'Нет комментариев';
                    }
                }
                if (displayComment.includes('БЕЗ КОМИССИИ')) {
                    const parts = displayComment.split(' | ');
                    displayComment = parts.filter(p => !p.includes('БЕЗ КОМИССИИ')).join(' | ') || 'Нет комментариев';
                }
                const fullRestName = `${orderCheck.restaurant || 'Не указан'}${addressSuffix}`;

                privateText = `📦 <b>Детали заказа #${String(orderId).slice(0,5)}</b>\n\n` +
                              `💰 <b>Заработок за доставку:</b> <u>${deliveryPriceText} сом</u>\n\n` +
                              (isZeroCommission ? `🎁 <b>Комиссия за заказ: 0 сом</b> (Заказ от 3.5 км без комиссии! 🎉)\n\n` : '') +
                              `📍 Ресторан: <b>${safeHtml(fullRestName)}</b>\n\n` + 
                              `👤 <b>Клиент:</b> ${safeHtml(orderCheck.client_name || 'Гость')}\n` +
                              `📞 <b>Номер:</b> ${safeHtml(orderCheck.phone || 'Не указан')}\n` +
                              `📍 <b>Адрес доставки:</b> <u>${safeHtml(orderCheck.address || 'Не указан')}</u>\n` +
                              `💬 <b>Комментарий:</b> <i>${safeHtml(displayComment)}</i>\n`; 

                const lat = orderCheck.lat || orderCheck.latitude;
                const lon = orderCheck.lon || orderCheck.longitude;
                if (lat && lon) {
                    const gisUrl = `https://2gis.kg/geo/${lon},${lat}`;
                    privateText += `\n🗺 <b>Карта:</b> <a href="${gisUrl}">Открыть точку в 2GIS</a>\n`;
                    buttons.push([Markup.button.url('🧭 Маршрут в 2GIS', gisUrl)]);
                }

                if (orderCheck.client_id && orderCheck.client_id != 111) {
                    buttons.push([Markup.button.url('💬 Написать клиенту', `tg://user?id=${orderCheck.client_id}`)]);
                }
            }

            // Отправляем в личку курьеру
            await courierBot.telegram.sendMessage(courierId, privateText, {
                parse_mode: 'HTML',
                ...(buttons.length > 0 ? Markup.inlineKeyboard(buttons) : {})
            });
            console.log("[КУРЬЕР] Успешно отправили данные в ЛС курьеру!");

        } catch (err) {
            console.error("❌ Фатальная ошибка при взятии заказа курьером:", err);
            try { await ctx.answerCbQuery("❌ Ошибка сервера", {show_alert: true}); } catch(e){}
        }
    });

    // ==========================================
    // КУРЬЕР ПРИНЯЛ МУЛЬТИЗАКАЗ (2 В 1)
    // ==========================================
    courierBot.action(/courier_take_batch_([^_]+)_([^_]+)/, async (ctx) => {
        const orderId1 = ctx.match[1].trim();
        const orderId2 = ctx.match[2].trim();
        const courierId = ctx.from.id;

        try {
            // Проверка баланса курьера
            const { data: courierCheck } = await supabase.from('couriers').select('balance').eq('id', courierId).maybeSingle();
            if (!courierCheck || (courierCheck.balance || 0) <= 0) {
                return ctx.answerCbQuery("❌ Ваш баланс 0 или ниже! Пополните счет, чтобы брать заказы.", { show_alert: true });
            }

            // Назначаем оба заказа курьеру в БД
            await supabase.from('orders').update({ courier_id: courierId }).in('id', [orderId1, orderId2]);

            // Завершаем сессии диспетчера и фиксируем активные заказы
            if (dispatcher) {
                if (typeof dispatcher.addCourierOrder === 'function') {
                    dispatcher.addCourierOrder(courierId, orderId1);
                    dispatcher.addCourierOrder(courierId, orderId2);
                }
                dispatcher.finishSession(orderId1);
                dispatcher.finishSession(orderId2);
            }

            const { data: courierData } = await supabase.from('couriers').select('name, phone').eq('id', courierId).maybeSingle();
            const cName = courierData?.name || ctx.from.first_name || 'Курьер';

            await ctx.editMessageText(
                `✅ <b>ВЫ ПРИНЯЛИ МУЛЬТИЗАКАЗ!</b>\nЗаказы #${orderId1.slice(0, 5)} и #${orderId2.slice(0, 5)} назначены вам.\n\n` +
                `🧭 <i>Откройте подробный маршрутный лист кнопкой «📋 Мои заказы» ниже.</i>`,
                { parse_mode: 'HTML' }
            ).catch(() => {});

            await ctx.answerCbQuery("✅ Мультизаказ принят!");

            // Уведомление администратора
            const adminNotify = `🛵 Курьер ${cName} взял МУЛЬТИЗАКАЗ (Заказы #${orderId1.slice(0, 5)} и #${orderId2.slice(0, 5)})`;
            try { await bot.telegram.sendMessage(ADMIN_GROUP_ID, adminNotify); } catch(e){}

            // Отправляем подсказку в чат курьера
            await ctx.reply(
                `🎉 <b>МУЛЬТИЗАКАЗ В РАБОТЕ!</b>\n\n` +
                `Нажмите кнопку <b>«📋 Мои заказы»</b> в нижнем меню, чтобы видеть обе точки забора и доставки.`,
                { parse_mode: 'HTML' }
            );
        } catch (err) {
            console.error("Ошибка при взятии мультизаказа:", err);
            try { await ctx.answerCbQuery("❌ Ошибка сервера", { show_alert: true }); } catch(e){}
        }
    });

    // ==========================================
    // КУРЬЕР ОТКЛОНИЛ ЗАКАЗ (ПЕРЕДАЕМ СЛЕДУЮЩЕМУ)
    // ==========================================
    courierBot.action(/courier_reject_(.+)/, async (ctx) => {
        const orderId = ctx.match[1].trim();
        const courierId = ctx.from.id;

        try {
            await ctx.answerCbQuery("Заказ отклонен. Ищем другого курьера.");
            await ctx.editMessageText("❌ Вы отклонили этот заказ. Он передан следующему курьеру.").catch(() => {});

            if (dispatcher) {
                await dispatcher.handleCourierReject(orderId, courierId);
            }
        } catch (e) {
            console.error("Ошибка при отклонении заказа курьером:", e.message);
        }
    });

    // ==========================================
    // 2. КУРЬЕР ЗАБРАЛ ЗАКАЗ (В ПУТИ)
    // ==========================================
    courierBot.action(/courier_picked_up_(.+)/, async (ctx) => {
        const orderId = ctx.match[1].trim();
        const courierId = ctx.from.id; 

        try {
            await supabase.from('orders').update({ status: 'delivery' }).eq('id', orderId);

            const { data: order } = await supabase.from('orders').select('client_id, is_manual').eq('id', orderId).maybeSingle();
            const { data: courierData } = await supabase.from('couriers').select('name, phone').eq('id', courierId).maybeSingle();
            
            const cName = courierData?.name || ctx.from.first_name || 'Курьер';
            const cPhone = courierData?.phone || 'Номер не указан';

            if (order && order.client_id && order.client_id != 111 && !order.is_manual) {
                const clientMessage = `🚀 Курьер взял заказ и летит к вам!\n\n👤 Курьер: <b>${cName}</b>\n📞 Телефон: ${cPhone}`;
                try { await bot.telegram.sendMessage(order.client_id, clientMessage, { parse_mode: 'HTML' }); } catch(e){}
            }

            const buttons = [[Markup.button.callback('✅ Я доставил заказ', `courier_delivered_${orderId}`)]];
            if (order && order.client_id && order.client_id != 111 && !order.is_manual) {
                buttons.push([Markup.button.url('💬 Написать клиенту', `tg://user?id=${order.client_id}`)]);
            }

            const oldText = ctx.callbackQuery.message.text || '';
            await ctx.editMessageText(oldText + `\n\n🛵 ВЫ В ПУТИ К КЛИЕНТУ!\nКак только отдадите еду, нажмите кнопку:`, Markup.inlineKeyboard(buttons));
            await ctx.answerCbQuery("Выехали к клиенту!");
        } catch (err) {
            console.error("Ошибка при статусе 'в пути':", err);
            try { await ctx.answerCbQuery("❌ Ошибка", {show_alert: true}); } catch(e){}
        }
    });

    // ==========================================
    // 3. КУРЬЕР ДОСТАВИЛ ЗАКАЗ
    // ==========================================
    courierBot.action(/courier_delivered_(.+)/, async (ctx) => {
        const orderId = ctx.match[1].trim();
        const courierId = ctx.from.id; 

        try {
            await supabase.from('orders').update({ status: 'completed' }).eq('id', orderId);

            const { data: order } = await supabase.from('orders').select('client_id, items, total_price, is_manual, comment').eq('id', orderId).maybeSingle();
            
            const isZeroCommission = order && order.comment && order.comment.includes('БЕЗ КОМИССИИ');
            let commission = 0;

            if (isZeroCommission) {
                commission = 0;
            } else if (order && order.is_manual) {
                commission = 20; 
            } else if (order) {
                let foodPrice = 0;
                try { 
                    const itemsArr = Array.isArray(order.items) ? order.items : JSON.parse(order.items || '[]');
                    itemsArr.forEach(i => {
                        const price = Number(i.price || (i.item ? i.item.price : 0)) || 0;
                        const count = Number(i.count) || 0;
                        foodPrice += price * count;
                    });
                } catch(e) {}
                
                const deliveryPrice = Math.max(0, (order.total_price || 0) - foodPrice);
                commission = Math.round(deliveryPrice * 0.10); 
            }

            const { data: cData } = await supabase.from('couriers').select('balance').eq('id', courierId).maybeSingle();
            if (cData) {
                const currentBalance = cData.balance || 0;
                const newBalance = currentBalance - commission;
                if (commission > 0) {
                    await supabase.from('couriers').update({ balance: newBalance }).eq('id', courierId);
                }
                try {
                    if (isZeroCommission) {
                        await courierBot.telegram.sendMessage(
                            courierId,
                            `🎉 <b>Заказ выполнен!</b>\n🎁 <b>Комиссия за заказ:</b> 0 сом (Заказ от 3.5 км без комиссии!)\n💳 <b>Баланс:</b> ${currentBalance} сом`,
                            { parse_mode: 'HTML' }
                        );
                    } else {
                        await courierBot.telegram.sendMessage(
                            courierId,
                            `💸 <b>Комиссия за заказ:</b> ${commission} сом.\n💳 <b>Остаток Баланса:</b> ${newBalance} сом.`,
                            { parse_mode: 'HTML' }
                        );
                    }
                } catch(e) {}
            }

            if (dispatcher && typeof dispatcher.removeCourierOrder === 'function') {
                dispatcher.removeCourierOrder(courierId, orderId);
            }

            if (order && order.client_id && order.client_id != 111 && !order.is_manual) {
                try { await bot.telegram.sendMessage(order.client_id, `🎉 Заказ успешно доставлен!\nПриятного аппетита 🍔😋`); } catch(e){}
            }

            const remainingCount = dispatcher && typeof dispatcher.getCourierActiveOrdersCount === 'function'
                ? dispatcher.getCourierActiveOrdersCount(courierId)
                : 0;

            if (remainingCount > 0) {
                try {
                    await courierBot.telegram.sendMessage(
                        courierId,
                        `🧭 <b>У вас остался еще ${remainingCount} активный заказ в рейсе!</b>\nНажмите кнопку «📋 Мои заказы», чтобы открыть следующий адрес доставки.`,
                        { parse_mode: 'HTML' }
                    );
                } catch(e) {}
            }

            const oldText = ctx.callbackQuery.message.text || '';
            await ctx.editMessageText(oldText + `\n\n🎉 ЗАКАЗ УСПЕШНО ДОСТАВЛЕН!`).catch(() => {});
            await ctx.answerCbQuery("Отличная работа!");
        } catch (err) {
            console.error("Ошибка при статусе 'доставлен':", err);
            try { await ctx.answerCbQuery("❌ Ошибка", {show_alert: true}); } catch(e){}
        }
    });
};