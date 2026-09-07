/**
 * Модуль умного поиска и раздачи заказов курьерам (Smart Dispatch Engine)
 * Реализует ступенчатую эскалацию: 2 км -> 5 км -> 10 км -> Fallback в админ-группу.
 */

// Вычисление расстояния по формуле Haversine (в метрах)
function getDistanceMeters(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // радиус Земли в метрах
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δφ = ((lat2 - lat1) * Math.PI) / 180;
    const Δλ = ((lon2 - lon1) * Math.PI) / 180;

    const a =
        Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
        Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return Math.round(R * c);
}

// Хранилище активных таймеров и очередей поиска: orderId => { timer, step, attemptedCouriers, ... }
const dispatchSessions = new Map();

/**
 * Инициализация диспетчера
 */
function createDispatcher({ courierBot, adminBot, restBot = null, supabase, ADMIN_GROUP_ID, activeCouriers }) {
    
    // Карта отслеживания активных заказов курьеров: courierId (String) => Set<orderId (String)>
    const courierActiveOrders = new Map();

    // Синхронизация активных заказов из БД при запуске диспетчера
    async function syncActiveOrdersFromDb() {
        try {
            const { data: activeList } = await supabase
                .from('orders')
                .select('id, courier_id')
                .not('courier_id', 'is', null)
                .in('status', ['paid', 'cooking', 'delivery']);
            if (activeList) {
                for (const ord of activeList) {
                    if (ord.courier_id) {
                        addCourierOrder(ord.courier_id, ord.id);
                    }
                }
                console.log(`[ДИСПЕТЧЕР] 📦 Синхронизировано активных заказов курьеров из БД: ${activeList.length}`);
            }
        } catch (e) {
            console.error("[ДИСПЕТЧЕР] Ошибка синхронизации активных заказов из БД:", e.message);
        }
    }
    syncActiveOrdersFromDb();

    function addCourierOrder(courierId, orderId) {
        const cId = String(courierId);
        const oId = String(orderId);
        if (!courierActiveOrders.has(cId)) {
            courierActiveOrders.set(cId, new Set());
        }
        courierActiveOrders.get(cId).add(oId);
        console.log(`[ДИСПЕТЧЕР] 🛵 Курьер ${cId} взял заказ #${oId}. Активных заказов: ${courierActiveOrders.get(cId).size}`);
    }

    function removeCourierOrder(courierId, orderId) {
        const cId = String(courierId);
        const oId = String(orderId);
        if (courierActiveOrders.has(cId)) {
            courierActiveOrders.get(cId).delete(oId);
            console.log(`[ДИСПЕТЧЕР] ✅ Курьер ${cId} освободил заказ #${oId}. Осталось активных: ${courierActiveOrders.get(cId).size}`);
            if (courierActiveOrders.get(cId).size === 0) {
                courierActiveOrders.delete(cId);
            }
        }
    }

    function getCourierActiveOrdersCount(courierId) {
        return courierActiveOrders.get(String(courierId))?.size || 0;
    }

    /**
     * Извлечение координат клиента из заказа (dest_lat/dest_lon или 2GIS ссылка)
     */
    function getOrderClientCoords(order) {
        if (!order) return null;
        if (order.dest_lat && order.dest_lon) {
            return { lat: Number(order.dest_lat), lon: Number(order.dest_lon) };
        }
        if (order.lat && order.lon) {
            return { lat: Number(order.lat), lon: Number(order.lon) };
        }
        if (order.comment && order.comment.includes('https://2gis.kg/geo/')) {
            const match = order.comment.match(/2gis\.kg\/geo\/([0-9.]+),([0-9.]+)/);
            if (match) {
                return { lon: Number(match[1]), lat: Number(match[2]) };
            }
        }
        return null;
    }

    /**
     * Расчет заработка курьера за доставку
     */
    function calculateDeliveryPrice(order) {
        let foodPrice = 0;
        try { 
            const itemsArr = Array.isArray(order.items) ? order.items : JSON.parse(order.items || '[]');
            itemsArr.forEach(i => {
                const price = Number(i.price || (i.item ? i.item.price : 0)) || 0;
                const count = Number(i.count) || 0;
                foodPrice += price * count;
            });
        } catch(e) {}
        return Math.max(0, (order.total_price || 0) - foodPrice);
    }

    /**
     * Поиск подходящих курьеров в радиусе maxDistanceMeters
     * Для стандартного поиска подходят ТОЛЬКО абсолютно свободные курьеры (0 активных заказов)
     */
    async function getAvailableCouriers(restLat, restLon, maxDistanceMeters, excludedCourierIds = new Set()) {
        const candidates = [];
        const NOW = Date.now();

        console.log(`\n[ДИСПЕТЧЕР] 🔍 Поиск свободных курьеров. Радиус: ${maxDistanceMeters}м. Ресторан: ${restLat}, ${restLon}`);
        console.log(`[ДИСПЕТЧЕР] 📦 В in-memory кэше (activeCouriers): ${activeCouriers.size} курьеров.`);

        // 1. Проверяем кэш оперативной памяти activeCouriers
        for (const [cId, cData] of activeCouriers.entries()) {
            if (excludedCourierIds.has(String(cId))) {
                console.log(`     ❌ Отсеян: уже предлагали этот заказ (в excludedCourierIds).`);
                continue;
            }
            if (!cData.lat || !cData.lon) {
                console.log(`     ❌ Отсеян: нет координат.`);
                continue;
            }

            // ПРОВЕРКА ЗАНЯТОСТИ: Только абсолютно свободные курьеры!
            const activeCount = getCourierActiveOrdersCount(cId);
            if (activeCount > 0) {
                console.log(`     ❌ Отсеян: занят заказом (активных: ${activeCount}). Доступен только для попутного перехвата.`);
                continue;
            }

            const timeSinceLastUpdate = NOW - (cData.lastUpdate || 0);
            const minutesSinceLastUpdate = Math.round(timeSinceLastUpdate / 60000);
            if (minutesSinceLastUpdate > 180) {
                console.log(`     ⚠️ Внимание: последний гео-пинг был ${minutesSinceLastUpdate} мин. назад.`);
            }

            const dist = getDistanceMeters(restLat, restLon, cData.lat, cData.lon);
            if (dist <= maxDistanceMeters) {
                console.log(`     ✅ ПОДХОДИТ! Расстояние: ${dist}м <= ${maxDistanceMeters}м.`);
                candidates.push({
                    id: String(cId),
                    distance: dist,
                    name: cData.name || 'Курьер'
                });
            } else {
                console.log(`     ❌ Отсеян: слишком далеко (${dist}м > ${maxDistanceMeters}м).`);
            }
        }

        // 2. Если в In-memory кэше никого нет, проверяем базу данных
        if (candidates.length === 0) {
            console.log(`[ДИСПЕТЧЕР] 🔄 В кэше подходящих нет. Проверяем курьеров из БД (is_online = true, balance > 0)...`);
            try {
                const { data: dbCouriers } = await supabase
                    .from('couriers')
                    .select('id, name, lat, lon, balance, is_online, status')
                    .eq('is_online', true)
                    .gt('balance', 0);

                if (dbCouriers && dbCouriers.length > 0) {
                    for (const c of dbCouriers) {
                        if (excludedCourierIds.has(String(c.id))) continue;
                        if (!c.lat || !c.lon) continue;
                        if (getCourierActiveOrdersCount(c.id) > 0) continue;

                        const dist = getDistanceMeters(restLat, restLon, c.lat, c.lon);
                        if (dist <= maxDistanceMeters) {
                            candidates.push({
                                id: String(c.id),
                                distance: dist,
                                name: c.name || 'Курьер'
                            });
                        }
                    }
                }
            } catch (e) {
                console.error("[ДИСПЕТЧЕР] ❌ Ошибка выборки курьеров из БД:", e.message);
            }
        }

        // Сортируем от самого близкого к более далёкому
        candidates.sort((a, b) => a.distance - b.distance);
        return candidates;
    }

    /**
     * ПРИОРИТЕТ 2: Попутный мультизаказ по вектору (Единая функция)
     * Правила:
     * 1. Вектор движения: Только вперед по курсу (tR2 >= -100м, tC2 >= 0, запрещен разворот назад против маршрута).
     * 2. Асимметричный коридор (1 км + 400 м):
     *    - max(dRest, dClient) <= 1000 м
     *    - min(dRest, dClient) <= 400 м
     *    (Случай А: Ресторан в 900м от оси, клиент прямо у дороги 200м - ОДОБРЕНО.
     *     Случай Б: Ресторан на улице 150м, клиент во дворах 800м - ОДОБРЕНО.
     *     Двойной зигзаг: 800м и 700м - ЗАПРЕЩЕНО).
     */
    async function findVectorEnRouteCourier(order2, restCoords2, restName2) {
        const clientCoords2 = getOrderClientCoords(order2);
        let bestCandidate = null;
        let minDetour = Infinity;

        console.log(`[ДИСПЕТЧЕР] 🔍 Приоритет 2: Поиск попутного курьера по вектору (асимметричный коридор 1 км + 400 м)...`);

        for (const [courierId, cData] of activeCouriers.entries()) {
            if (!cData.lat || !cData.lon) continue;

            // Курьер должен иметь СТРОГО 1 активный заказ
            if (getCourierActiveOrdersCount(courierId) !== 1) continue;

            const activeOrdersSet = courierActiveOrders.get(String(courierId));
            if (!activeOrdersSet || activeOrdersSet.size !== 1) continue;

            const orderId1 = Array.from(activeOrdersSet)[0];
            if (!orderId1) continue;

            let order1 = null;
            try {
                const { data } = await supabase.from('orders').select('*').eq('id', orderId1).maybeSingle();
                order1 = data;
            } catch (e) {
                continue;
            }

            if (!order1 || ['completed', 'canceled'].includes(order1.status)) {
                removeCourierOrder(courierId, orderId1);
                continue;
            }

            const courierPos = { lat: Number(cData.lat), lon: Number(cData.lon) };
            const clientCoords1 = getOrderClientCoords(order1);

            // Если у одного из заказов нет гео-координат, проверяем текстовый адрес
            if (!clientCoords1 || !clientCoords2) {
                if (order1.address && order2.address && order1.address.trim().toLowerCase() === order2.address.trim().toLowerCase()) {
                    const distToRest = getDistanceMeters(courierPos.lat, courierPos.lon, restCoords2.lat, restCoords2.lon);
                    if (distToRest <= 1500) {
                        return {
                            courier: { id: String(courierId), name: cData.name || 'Курьер' },
                            detour: distToRest,
                            deliveryOrder: 'order1_first',
                            order1,
                            dRest: distToRest,
                            dClient: 0
                        };
                    }
                }
                continue;
            }

            // Базовый вектор движения курьера: от текущей позиции курьера к Клиенту 1
            const latMidRad = ((courierPos.lat + clientCoords1.lat) / 2) * (Math.PI / 180);
            const mPerDegLat = 111139;
            const mPerDegLon = 111139 * Math.cos(latMidRad);

            // Вектор основного маршрута курьера: V = Client1 - Courier
            const Vx = (clientCoords1.lon - courierPos.lon) * mPerDegLon;
            const Vy = (clientCoords1.lat - courierPos.lat) * mPerDegLat;
            const routeLen = Math.sqrt(Vx * Vx + Vy * Vy);

            // Если курьер уже подъезжает к первому клиенту (< 350 м), не отвлекаем его
            if (routeLen < 350) continue;

            // Единичный вектор маршрута (вдоль) и единичная нормаль (поперек)
            const ux = Vx / routeLen;
            const uy = Vy / routeLen;
            const nx = -uy;
            const ny = ux;

            // Вектор от курьера до Ресторана 2
            const r2x = (restCoords2.lon - courierPos.lon) * mPerDegLon;
            const r2y = (restCoords2.lat - courierPos.lat) * mPerDegLat;

            // Вектор от курьера до Клиента 2
            const c2x = (clientCoords2.lon - courierPos.lon) * mPerDegLon;
            const c2y = (clientCoords2.lat - courierPos.lat) * mPerDegLat;

            // 1. Продольные проекции (в метрах вдоль вектора движения)
            const tR2 = r2x * ux + r2y * uy;
            const tC2 = c2x * ux + c2y * uy;

            // ПРАВИЛО 1: ТОЛЬКО ВПЕРЕД ПО КУРСУ (Разворот назад строго запрещен!)
            // tR2 >= -100 м (допуск 100м на погрешность GPS у ресторана), tC2 >= 0
            if (tR2 < -100) continue;
            if (tC2 < 0) continue;

            // Забор из Ресторана 2 должен быть раньше вручения Клиенту 2
            if (tC2 < tR2 - 200) continue;

            // Точки не должны уходить далеко за пределы маршрута курьера
            if (tR2 > routeLen + 2000 || tC2 > routeLen + 3000) continue;

            // 2. Поперечные отклонения от прямой оси маршрута (в метрах)
            const dRest = Math.abs(r2x * nx + r2y * ny);
            const dClient = Math.abs(c2x * nx + c2y * ny);

            const maxDev = Math.max(dRest, dClient);
            const minDev = Math.min(dRest, dClient);

            // ПРАВИЛО 2: АСИММЕТРИЧНЫЙ КОРИДОР (1 км + 400 м)
            // Одна точка <= 1000 м, вторая строго <= 400 м (исключает двойной зигзаг)
            if (maxDev > 1000 || minDev > 400) continue;

            // Проверяем прямую доступность Ресторана 2 от курьера (не более 3 км)
            const distCourierToRest2 = getDistanceMeters(courierPos.lat, courierPos.lon, restCoords2.lat, restCoords2.lon);
            if (distCourierToRest2 > 3000) continue;

            // Расчет лучшей последовательности вручения и перепробега (detour)
            // Вариант А: сначала Клиент 2, затем Клиент 1
            const distA = distCourierToRest2 + 
                getDistanceMeters(restCoords2.lat, restCoords2.lon, clientCoords2.lat, clientCoords2.lon) + 
                getDistanceMeters(clientCoords2.lat, clientCoords2.lon, clientCoords1.lat, clientCoords1.lon);

            // Вариант Б: сначала Клиент 1, затем Клиент 2
            const distB = distCourierToRest2 + 
                getDistanceMeters(restCoords2.lat, restCoords2.lon, clientCoords1.lat, clientCoords1.lon) + 
                getDistanceMeters(clientCoords1.lat, clientCoords1.lon, clientCoords2.lat, clientCoords2.lon);

            let deliveryOrder = 'order2_first';
            let totalDist = distA;
            if (distB < distA) {
                deliveryOrder = 'order1_first';
                totalDist = distB;
            }

            const baseDist = getDistanceMeters(courierPos.lat, courierPos.lon, clientCoords1.lat, clientCoords1.lon);
            const detour = Math.max(0, Math.round(totalDist - baseDist));

            // Сохраняем лучшего курьера (с наименьшим крюком)
            if (detour < minDetour) {
                minDetour = detour;
                bestCandidate = {
                    courier: { id: String(courierId), name: cData.name || 'Курьер' },
                    detour,
                    deliveryOrder,
                    order1,
                    dRest: Math.round(dRest),
                    dClient: Math.round(dClient),
                    maxDev: Math.round(maxDev),
                    minDev: Math.round(minDev),
                    tR2: Math.round(tR2),
                    tC2: Math.round(tC2)
                };
            }
        }

        if (bestCandidate) {
            console.log(`[ДИСПЕТЧЕР] 🎯 Приоритет 2 (Векторный попутный перехват): Найден курьер ${bestCandidate.courier.name} (${bestCandidate.courier.id})! Отклонения: Ресторан=${bestCandidate.dRest}м, Клиент=${bestCandidate.dClient}м (коридор 1000м/400м). Крюк: ${bestCandidate.detour}м.`);
        } else {
            console.log(`[ДИСПЕТЧЕР] ℹ️ Приоритет 2: Попутных курьеров по вектору маршрута не обнаружено.`);
        }

        return bestCandidate;
    }

    // Алиас для обратной совместимости
    const findTransitCourier = findVectorEnRouteCourier;

    /**
     * Принудительное автоназначение попутного заказа курьеру (En-Route Auto-Assign)
     */
    async function autoAssignEnRouteOrder(order, restCoords, restName, transitCandidate) {
        const orderId = String(order.id);
        const courierId = String(transitCandidate.courier.id);
        const detourMeters = transitCandidate.detour;

        console.log(`[ДИСПЕТЧЕР] 🚀 ПРИНУДИТЕЛЬНОЕ ДОКИДЫВАНИЕ: заказ #${orderId} назначен курьеру ${courierId} (крюк: ${detourMeters} м)`);

        // 1. Обновляем курьера в БД
        await supabase.from('orders').update({ courier_id: courierId }).eq('id', orderId);

        // 2. Добавляем в отслеживание
        addCourierOrder(courierId, orderId);

        // 3. Отправляем в личку курьеру карточку
        const deliveryPrice = calculateDeliveryPrice(order);
        const detourText = detourMeters < 1000 ? `${detourMeters} м` : `${parseFloat((detourMeters / 1000).toFixed(1))} км`;

        const dropoffHint = transitCandidate.deliveryOrder === 'order2_first'
            ? `💡 <b>Маршрут:</b> Сначала вручите этот заказ #${orderId.slice(0, 5)}, затем предыдущий!`
            : `💡 <b>Маршрут:</b> Сначала вручите первый заказ, затем этот #${orderId.slice(0, 5)}!`;

        const notifyText = 
            `🛵 <b>ВАМ ДОБАВЛЕН ПОПУТНЫЙ ЗАКАЗ #${orderId.slice(0, 5)}!</b>\n\n` +
            `<i>Система автоматически прикрепила попутный заказ к вашему рейсу (перепробег всего ~${detourText}).</i>\n\n` +
            `🏢 <b>Ресторан:</b> ${safeHtml(restName)}\n` +
            `📍 <b>Адрес доставки:</b> <u>${safeHtml(order.address || 'Не указан')}</u>\n` +
            `💰 <b>Заработок за доставку:</b> ~${deliveryPrice} сом\n` +
            `👤 <b>Клиент:</b> ${safeHtml(order.client_name || 'Гость')}\n` +
            `📞 <b>Номер:</b> ${safeHtml(order.phone || 'Не указан')}\n\n` +
            `${dropoffHint}`;

        const buttons = [
            [{ text: `📦 Я забрал заказ #${orderId.slice(0, 5)}`, callback_data: `courier_picked_up_${orderId}` }]
        ];

        const destCoords = getOrderClientCoords(order);
        if (destCoords) {
            const gisUrl = `https://2gis.kg/geo/${destCoords.lon},${destCoords.lat}`;
            buttons.push([{ text: '🧭 Маршрут в 2GIS', url: gisUrl }]);
        }

        if (order.client_id && order.client_id != 111) {
            buttons.push([{ text: '💬 Написать клиенту', url: `tg://user?id=${order.client_id}` }]);
        }

        try {
            await courierBot.telegram.sendMessage(courierId, notifyText, {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: buttons }
            });
        } catch (e) {
            console.error(`[ДИСПЕТЧЕР] Ошибка отправки карточки попутного заказа:`, e.message);
        }

        // 4. Уведомление админам
        try {
            await adminBot.telegram.sendMessage(
                ADMIN_GROUP_ID,
                `🛵 <b>ПОПУТНЫЙ ЗАКАЗ НАЗНАЧЕН!</b>\nЗаказ #${orderId.slice(0, 5)} прикреплен курьеру <b>${safeHtml(transitCandidate.courier.name)}</b> (выполняет мультизаказ, крюк ~${detourText}).`,
                { parse_mode: 'HTML' }
            );
        } catch(e){}

        // 5. Уведомление ресторану
        if (restBot && restName) {
            try {
                const { data: restData } = await supabase.from('restaurants').select('id').eq('name', restName).maybeSingle();
                if (restData) {
                    await restBot.telegram.sendMessage(
                        restData.id,
                        `🛵 Курьер <b>${safeHtml(transitCandidate.courier.name)}</b> назначен на заказ #${orderId.slice(0, 5)} и уже едет к вам!`,
                        { parse_mode: 'HTML' }
                    );
                }
            } catch(e){}
        }

        // Завершаем диспетчер для этого заказа
        finishSession(orderId);
        return true;
    }

    /**
     * Отправка предложения конкретному курьеру с таймером на 25 секунд
     * Поддерживает как одиночные заказы, так и мультизаказы (bundle)
     */
    async function offerOrderToCourier(order, courier, restName, distanceMeters, bundledOrder = null) {
        const orderId = String(order.id);
        const courierId = courier.id;

        let distanceText = '';
        if (distanceMeters < 1000) {
            distanceText = `${distanceMeters} м`;
        } else {
            const km = parseFloat((distanceMeters / 1000).toFixed(1));
            distanceText = `${km} км`;
        }

        const isFreeCommission = distanceMeters >= 3500;
        let commissionBadge = '';
        if (isFreeCommission) {
            commissionBadge = `🎁 <b>Заказ БЕЗ КОМИССИИ!</b> (дистанция от 3.5 км)\n`;
        }

        let offerText = '';
        let buttons = [];

        if (bundledOrder) {
            const deliveryPrice1 = calculateDeliveryPrice(order);
            const deliveryPrice2 = calculateDeliveryPrice(bundledOrder);
            const totalDelivery = deliveryPrice1 + deliveryPrice2;

            offerText = 
                `🔥 <b>ВАМ ДОСТУПЕН МУЛЬТИЗАКАЗ (2 в 1)!</b>\n\n` +
                `🏢 <b>Ресторан 1:</b> ${safeHtml(restName)}\n` +
                `🏠 <b>Адрес 1:</b> ${safeHtml(order.address || 'Не указан')}\n\n` +
                `🏢 <b>Ресторан 2:</b> ${safeHtml(bundledOrder.restaurant || 'Ресторан')}\n` +
                `🏠 <b>Адрес 2:</b> ${safeHtml(bundledOrder.address || 'Не указан')}\n\n` +
                `📍 <b>Расстояние до вас:</b> ~${distanceText}\n` +
                `💰 <b>Заработок за обе доставки:</b> ~${totalDelivery} сом\n\n` +
                `⏳ <i>У вас есть 18 секунд, чтобы принять мультизаказ!</i>`;

            buttons = [
                [
                    { text: '✅ Принять оба заказа', callback_data: `courier_take_batch_${orderId}_${bundledOrder.id}` },
                    { text: '❌ Отклонить', callback_data: `courier_reject_${orderId}` }
                ]
            ];
        } else {
            offerText = 
                `🔥 <b>ВАМ ДОСТУПЕН НОВЫЙ ЗАКАЗ #${orderId.slice(0, 5)}!</b>\n\n` +
                `🏢 <b>Ресторан:</b> ${safeHtml(restName)}\n` +
                `📍 <b>Расстояние до вас:</b> ~${distanceText}\n` +
                (commissionBadge ? `${commissionBadge}\n` : '') +
                `🏠 <b>Адрес доставки:</b> ${safeHtml(order.address || 'Не указан')}\n` +
                `💰 <b>Сумма заказа:</b> ${order.total_price} сом\n\n` +
                `⏳ <i>У вас есть 18 секунд, чтобы принять заказ!</i>`;

            buttons = [
                [
                    { text: '✅ Принять заказ', callback_data: `courier_take_${orderId}` },
                    { text: '❌ Отклонить', callback_data: `courier_reject_${orderId}` }
                ]
            ];
        }

        try {
            const sentMsg = await courierBot.telegram.sendMessage(courierId, offerText, {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: buttons }
            });

            return sentMsg.message_id;
        } catch (e) {
            console.error(`[ДИСПЕТЧЕР] Не удалось отправить оффер курьеру ${courierId}:`, e.message);
            return null;
        }
    }

    /**
     * Поиск кластерного совпадения на кухне (Приоритет 1):
     * Другой активный заказ без курьера, где рестораны <= 700 м и клиенты <= 700 м
     */
    function findClusterMatch(newOrder, newRestCoords) {
        const newOrderId = String(newOrder.id);
        const newClientCoords = getOrderClientCoords(newOrder);

        for (const [existingOrderId, existingSession] of dispatchSessions.entries()) {
            if (existingOrderId === newOrderId) continue;
            if (existingSession.isFinished || existingSession.isBundled) continue;

            // Расстояние между ресторанами <= 700 м
            const distRest = getDistanceMeters(
                newRestCoords.lat, newRestCoords.lon,
                existingSession.restCoords.lat, existingSession.restCoords.lon
            );
            if (distRest > 700) continue;

            // Проверяем расстояние между клиентами <= 700 м
            const existingClientCoords = getOrderClientCoords(existingSession.order);
            let clientsClose = false;

            if (newClientCoords && existingClientCoords) {
                const distClients = getDistanceMeters(
                    newClientCoords.lat, newClientCoords.lon,
                    existingClientCoords.lat, existingClientCoords.lon
                );
                if (distClients <= 700) clientsClose = true;
            } else if (newOrder.address && existingSession.order.address) {
                if (newOrder.address.trim().toLowerCase() === existingSession.order.address.trim().toLowerCase()) {
                    clientsClose = true;
                }
            }

            if (clientsClose) {
                return existingSession;
            }
        }
        return null;
    }

    /**
     * Основная функция диспетчеризации (Воронка Приоритетов 1–5)
     * @param {Object} order - объект заказа
     * @param {Object} restCoords - координаты ресторана {lat, lon}
     * @param {string} restName - название ресторана
     * @param {boolean} skipBuffer - пропустить 60с буфер (например, при ручном перезапуске)
     */
    async function startDispatch(order, restCoords, restName, skipBuffer = false) {
        const orderId = String(order.id);

        // Если диспетчеризация по этому заказу уже идет — не запускаем дубль
        if (dispatchSessions.has(orderId)) return;

        // =========================================================================
        // ПРИОРИТЕТ 1: КЛАСТЕРНЫЙ МУЛЬТИЗАКАЗ (Идеальная пара на кухне)
        // Рестораны <= 700 м, клиенты <= 700 м
        // =========================================================================
        console.log(`[ДИСПЕТЧЕР] 🔍 Приоритет 1: Проверка на кластерный мультизаказ для заказа #${orderId}...`);
        const clusterSession = findClusterMatch(order, restCoords);
        if (clusterSession) {
            console.log(`[ДИСПЕТЧЕР] 🍱 ПРИОРИТЕТ 1 СРАБОТАЛ: Заказ #${orderId} склеен в мультизаказ с заказом #${clusterSession.orderId}!`);
            clusterSession.bundledOrder = order;
            clusterSession.isBundled = true;

            // Если парная сессия ждала в 60с буфере батчинга — сбрасываем ожидание буфера и немедленно ищем курьера на мультизаказ!
            if (clusterSession.bufferTimer) {
                clearTimeout(clusterSession.bufferTimer);
                clusterSession.bufferTimer = null;
                console.log(`[ДИСПЕТЧЕР] ⚡ Склейка в буфере! Заказ #${clusterSession.orderId} немедленно переходит к поиску курьера на мультизаказ.`);
                await nextDispatchStep(clusterSession.orderId);
            }

            try {
                await adminBot.telegram.sendMessage(
                    ADMIN_GROUP_ID,
                    `🍱 <b>КЛАСТЕРНЫЙ МУЛЬТИЗАКАЗ СОЗДАН!</b>\nЗаказы #${clusterSession.orderId.slice(0, 5)} и #${orderId.slice(0, 5)} склеены на старте (рестораны и клиенты рядом <=700м). Ищем курьера сразу на оба заказа!`,
                    { parse_mode: 'HTML' }
                );
            } catch(e){}

            return { success: true, reason: 'clustered_with_' + clusterSession.orderId };
        }

        // =========================================================================
        // ПРИОРИТЕТ 2: ПОПУТНЫЙ МУЛЬТИЗАКАЗ ПО ВЕКТОРУ (Единая функция)
        // Вектор движения только вперед (без разворотов назад против маршрута)
        // Асимметричный коридор: 1 км + 400 м (max <= 1000м, min <= 400м)
        // =========================================================================
        console.log(`[ДИСПЕТЧЕР] 🔍 Приоритет 2: Проверка на попутный мультизаказ по вектору...`);
        const vectorCandidate = await findVectorEnRouteCourier(order, restCoords, restName);
        if (vectorCandidate) {
            console.log(`[ДИСПЕТЧЕР] 🎯 ПРИОРИТЕТ 2 СРАБОТАЛ: Заказ #${orderId} принудительно назначен курьеру ${vectorCandidate.courier.name}!`);
            await autoAssignEnRouteOrder(order, restCoords, restName, vectorCandidate);
            return { success: true, reason: 'vector_en_route_assigned' };
        }

        // =========================================================================
        // БУФЕР БАТЧИНГА (60 СЕКУНД) И ПЕРЕХОД К ПРИОРИТЕТУ 3
        // Если мгновенной склейки нет и попутного курьера по вектору нет:
        // Даем 60 секунд на появление парного заказа на кухне
        // =========================================================================
        const session = {
            orderId,
            order,
            restCoords,
            restName,
            attemptedCouriers: new Set(),
            courierDistanceMap: new Map(), // courierId => distanceMeters
            currentCourierId: null,
            currentMessageId: null,
            timer: null,
            bufferTimer: null,
            isFinished: false,
            isBundled: false,
            bundledOrder: null,
            wave: 1, // 1 = свободные до 2 км, 2 = расширенный поиск 4-6 км
            retryCount: 0 // Счетчик 45-секундных циклов ожидания (до 3 раз ~ 2.5-3 минуты)
        };

        dispatchSessions.set(orderId, session);

        if (skipBuffer) {
            console.log(`[ДИСПЕТЧЕР] ⚡ Буфер батчинга пропущен (ручной запуск). Старт поиска свободных курьеров для заказа #${orderId}`);
            await nextDispatchStep(orderId);
        } else {
            console.log(`[ДИСПЕТЧЕР] ⏳ Окно батчинга: Заказ #${orderId} помещен в 60-секундный буфер для ожидания парного заказа...`);
            session.bufferTimer = setTimeout(async () => {
                session.bufferTimer = null;
                console.log(`[ДИСПЕТЧЕР] ⏱️ 60-секундный буфер батчинга завершен для заказа #${orderId}. Переход к Приоритету 3 (поиск свободных курьеров).`);
                await nextDispatchStep(orderId);
            }, 60000);
        }
    }

    /**
     * Шаг эскалации поиска свободных курьеров (2 км -> 4-6 км -> Повтор/Fallback)
     */
    async function nextDispatchStep(orderId) {
        const session = dispatchSessions.get(orderId);
        if (!session || session.isFinished) return;

        // Проверяем актуальное состояние заказа в БД
        if (!orderId.startsWith('TEST_')) {
            const { data: currentOrder } = await supabase
                .from('orders')
                .select('status, courier_id')
                .eq('id', orderId)
                .maybeSingle();

            if (currentOrder && (currentOrder.courier_id || ['canceled', 'delivery', 'completed'].includes(currentOrder.status))) {
                console.log(`[ДИСПЕТЧЕР] Заказ #${orderId} уже распределен или завершен. Завершаем диспетчер.`);
                finishSession(orderId);
                return;
            }
        }

        // Если было старое сообщение курьеру — обновляем его (срок истёк)
        if (session.currentCourierId && session.currentMessageId) {
            try {
                await courierBot.telegram.editMessageText(
                    session.currentCourierId,
                    session.currentMessageId,
                    null,
                    `⌛ <b>Время на принятие заказа #${orderId.slice(0, 5)} истекло.</b>\nЗаказ передан другому курьеру.`,
                    { parse_mode: 'HTML' }
                );
            } catch (e) {}
        }

        // Проверяем: вдруг за время ожидания на линию вышел попутный курьер по вектору
        const lateVectorCandidate = await findVectorEnRouteCourier(session.order, session.restCoords, session.restName);
        if (lateVectorCandidate) {
            console.log(`[ДИСПЕТЧЕР] 🎯 В повторном поиске обнаружен попутный курьер по вектору: ${lateVectorCandidate.courier.name}!`);
            await autoAssignEnRouteOrder(session.order, session.restCoords, session.restName, lateVectorCandidate);
            return;
        }

        if (!session.wave) session.wave = 1;

        let foundCourier = null;
        let foundDistance = 0;

        // ==========================================
        // ВОЛНА 1: Свободные курьеры рядом (радиус до 2 км)
        // ==========================================
        if (session.wave === 1) {
            console.log(`[ДИСПЕТЧЕР] 🌊 ВОЛНА 1: Поиск свободных курьеров в радиусе 2 км для заказа #${orderId}...`);
            const candidates = await getAvailableCouriers(
                session.restCoords.lat,
                session.restCoords.lon,
                2000,
                session.attemptedCouriers
            );

            if (candidates.length > 0) {
                foundCourier = candidates[0];
                foundDistance = candidates[0].distance;
                console.log(`[ДИСПЕТЧЕР] 🎯 Волна 1: Найден свободный курьер ${foundCourier.name} (${foundCourier.id}) на расстоянии ${foundDistance} м`);
            } else {
                console.log(`[ДИСПЕТЧЕР] ℹ️ Волна 1: Свободных курьеров в радиусе 2 км нет. Переходим к широкому поиску (Волна 2).`);
                session.wave = 2;
            }
        }

        // ==========================================
        // ВОЛНА 2: Расширенный поиск свободных курьеров (4 км -> 6 км)
        // ==========================================
        if (!foundCourier && session.wave === 2) {
            console.log(`[ДИСПЕТЧЕР] 🌊 ВОЛНА 2: Эскалация радиуса (4 км -> 6 км) для заказа #${orderId}...`);
            const RADIUS_TIERS_WIDE = [4000, 6000];
            for (const radius of RADIUS_TIERS_WIDE) {
                const candidates = await getAvailableCouriers(
                    session.restCoords.lat,
                    session.restCoords.lon,
                    radius,
                    session.attemptedCouriers
                );
                if (candidates.length > 0) {
                    foundCourier = candidates[0];
                    foundDistance = candidates[0].distance;
                    console.log(`[ДИСПЕТЧЕР] 🎯 Волна 2: Найден курьер ${foundCourier.name} (${foundCourier.id}) на расстоянии ${foundDistance} м (радиус: ${radius / 1000} км)`);
                    break;
                }
            }
        }

        // Если нашли курьера (из Волны 1 или Волны 2):
        if (foundCourier) {
            session.attemptedCouriers.add(String(foundCourier.id));
            session.courierDistanceMap.set(String(foundCourier.id), foundDistance);
            session.currentCourierId = foundCourier.id;

            const msgId = await offerOrderToCourier(session.order, foundCourier, session.restName, foundDistance, session.bundledOrder);
            session.currentMessageId = msgId;

            // Запускаем таймер на 18 секунд
            session.timer = setTimeout(async () => {
                console.log(`[ДИСПЕТЧЕР] Таймаут 18 сек для курьера ${foundCourier.id} по заказу #${orderId}.`);
                // При таймауте переходим на следующую волну
                if (session.wave === 1) session.wave = 2;
                await nextDispatchStep(orderId);
            }, 18000);

        } else {
            // Если в текущем проходе курьеры не найдены:
            // Даем заказу повисеть в поиске до 3 минут (3 цикла по 45 секунд)
            if (session.retryCount < 3) {
                session.retryCount++;
                console.log(`[ДИСПЕТЧЕР] Курьеры для заказа #${orderId} не найдены. Ожидание 45 сек перед повтором (попытка ${session.retryCount}/3)...`);
                
                // Очищаем список опрошенных и сбрасываем волну на 1 (вдруг кто-то освободился или едет транзитом)
                session.attemptedCouriers.clear();
                session.wave = 1;

                session.timer = setTimeout(async () => {
                    await nextDispatchStep(orderId);
                }, 45000);
                return;
            }

            // АВАРИЙНЫЙ СБРОС (Fallback): Спустя ~3 минуты свободных курьеров не нашлось
            console.log(`[ДИСПЕТЧЕР] В радиусе 6 км за 3 минуты нет свободных курьеров для заказа #${orderId}. Отправляем алерты админу и ресторану!`);
            await triggerFallback(session.order, session.restName, session.restCoords);
            finishSession(orderId);
        }
    }

    /**
     * Аварийный сброс - Уведомление администратора и ресторана с кнопками
     */
    async function triggerFallback(order, restName, restCoords) {
        const orderId = String(order.id);

        // 1. Сообщение администратору
        const adminFallbackText = 
            `🚨 <b>ВНИМАНИЕ: ЗАКАЗ ПОДВИС!</b>\n\n` +
            `Заказ #${orderId.slice(0, 5)} не смог найти свободного курьера в радиусе 6 км за 3 минуты (все курьеры заняты или оффлайн).\n\n` +
            `🏢 <b>Откуда:</b> ${restName}\n` +
            `📍 <b>Куда:</b> ${order.address || 'Не указан'}\n` +
            `💰 <b>Сумма:</b> ${order.total_price || 0} сом\n\n` +
            `<i>Свяжитесь с курьерами, перезапустите поиск или отмените заказ:</i>`;

        const adminButtons = [
            [{ text: "🔄 Поискать курьера еще раз", callback_data: `retry_dispatch_${orderId}` }],
            [{ text: "❌ Отменить заказ", callback_data: `admin_cancel_order_${orderId}` }]
        ];

        try {
            await adminBot.telegram.sendMessage(ADMIN_GROUP_ID, adminFallbackText, {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: adminButtons }
            });
            console.log(`[ДИСПЕТЧЕР] Алерт админу о подвисшем заказе #${order.id} отправлен.`);
        } catch (e) {
            console.error("[ДИСПЕТЧЕР] Ошибка отправки уведомления админу:", e.message);
        }

        // 2. Сообщение ресторану
        if (restBot && restName) {
            try {
                const { data: rest } = await supabase
                    .from('restaurants')
                    .select('id')
                    .eq('name', restName)
                    .maybeSingle();

                if (rest && rest.id) {
                    const restFallbackText = 
                        `⚠️ <b>СВОБОДНЫХ КУРЬЕРОВ ПОКА НЕТ</b>\n\n` +
                        `По заказу #${orderId.slice(0, 5)} система искала курьеров в радиусе 6 км 3 минуты, но все курьеры поблизости сейчас заняты или оффлайн.\n\n` +
                        `Вы можете повторить поиск курьера позже или отменить заказ:`;

                    const restButtons = [
                        [{ text: "🔄 Поискать курьера еще раз", callback_data: `retry_dispatch_${orderId}` }],
                        [{ text: "❌ Отменить заказ", callback_data: `rest_cancel_order_${orderId}` }]
                    ];

                    await restBot.telegram.sendMessage(rest.id, restFallbackText, {
                        parse_mode: 'HTML',
                        reply_markup: { inline_keyboard: restButtons }
                    });
                    console.log(`[ДИСПЕТЧЕР] Алерт ресторану (${rest.id}) о подвисшем заказе #${order.id} отправлен.`);
                }
            } catch (err) {
                console.error("[ДИСПЕТЧЕР] Ошибка отправки алерта ресторану:", err.message);
            }
        }
    }

    /**
     * Повторный запуск диспетчеризации (по нажатию кнопки админом или рестораном)
     */
    async function retryDispatch(orderId) {
        orderId = String(orderId).trim();
        console.log(`[ДИСПЕТЧЕР] 🔄 Ручной перезапуск диспетчеризации для заказа #${orderId}`);

        finishSession(orderId);

        const { data: order, error } = await supabase
            .from('orders')
            .select('*')
            .eq('id', orderId)
            .maybeSingle();

        if (error || !order) {
            console.error(`[ДИСПЕТЧЕР] Заказ #${orderId} не найден в БД при retry.`);
            return { success: false, reason: 'not_found' };
        }

        if (order.courier_id) {
            return { success: false, reason: 'already_taken' };
        }

        if (['completed', 'canceled'].includes(order.status)) {
            return { success: false, reason: 'invalid_status', status: order.status };
        }

        let restCoords = null;
        let restName = order.restaurant || 'Ресторан';
        if (order.restaurant) {
            const { data: rest } = await supabase
                .from('restaurants')
                .select('lat, lon, name')
                .eq('name', order.restaurant)
                .maybeSingle();

            if (rest && rest.lat && rest.lon) {
                restCoords = { lat: rest.lat, lon: rest.lon };
                restName = rest.name;
            }
        }

        if (!restCoords) {
            return { success: false, reason: 'no_coords' };
        }

        await startDispatch(order, restCoords, restName, true);
        return { success: true };
    }

    /**
     * Завершение сессии диспетчера (когда заказ взят курьером или отменен)
     */
    function finishSession(orderId) {
        const session = dispatchSessions.get(String(orderId));
        if (session) {
            session.isFinished = true;
            if (session.timer) clearTimeout(session.timer);
            if (session.bufferTimer) clearTimeout(session.bufferTimer);
            dispatchSessions.delete(String(orderId));
        }
    }

    /**
     * Обработка отклонения курьером (нажал "❌ Отклонить")
     */
    async function handleCourierReject(orderId, courierId) {
        const session = dispatchSessions.get(String(orderId));
        if (session && String(session.currentCourierId) === String(courierId)) {
            if (session.timer) clearTimeout(session.timer);
            await nextDispatchStep(orderId);
        }
    }

    /**
     * Получить дистанцию курьера до ресторана по текущей сессии заказа
     */
    function getOrderCourierDistance(orderId, courierId) {
        const session = dispatchSessions.get(String(orderId));
        if (session && session.courierDistanceMap) {
            return session.courierDistanceMap.get(String(courierId)) || 0;
        }
        return 0;
    }

    return {
        startDispatch,
        retryDispatch,
        finishSession,
        handleCourierReject,
        getOrderCourierDistance,
        getDistanceMeters,
        addCourierOrder,
        removeCourierOrder,
        getCourierActiveOrdersCount,
        findVectorEnRouteCourier,
        findTransitCourier,
        autoAssignEnRouteOrder,
        getOrderClientCoords
    };
}

module.exports = createDispatcher;
