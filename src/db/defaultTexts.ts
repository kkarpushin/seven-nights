/**
 * Тексты и настройки по умолчанию. Приложение А docs/design-bot.md + §3 и §4
 * docs/quiz-bot-integration.md + docs/quiz-spec.md, дословно.
 *
 * Почему это лежит здесь, а не в src/texts.ts: реестр нужен двум независимым
 * потребителям — засеву базы (scripts/seed.ts) и рантайму бота (src/texts.ts).
 * Держать его в модуле бота значило бы тянуть весь бот в скрипт засева.
 * src/texts.ts реэкспортирует DEFAULT_TEXTS отсюда — контракт §5.8 сохраняется.
 *
 * Правило, которое легко нарушить незаметно: `value` и `default_value` при засеве
 * равны, но дальше расходятся — админка меняет `value`, а `default_value` остаётся
 * точкой возврата. Поэтому менять формулировки здесь после запуска нельзя: это
 * сдвинет «как было» под уже отредактированным текстом.
 *
 * `placeholders` — белый список для валидации в админке. В него обязан входить
 * каждый плейсхолдер, который встречается в тексте по умолчанию, иначе владелец
 * не сможет сохранить обратно даже исходную формулировку.
 */

export type TextDefault = {
  key: string
  value: string
  placeholders: string[]
  section: TextSection
  /** «Где это видно» — подсказка в админке. */
  hint: string
}

export type TextSection =
  | 'onboarding'
  | 'evening'
  | 'now'
  | 'pause'
  | 'numbers'
  | 'final'
  | 'buttons'
  | 'admin'
  | 'quiz'

export const TEXT_SECTIONS: readonly TextSection[] = [
  'onboarding', 'evening', 'now', 'pause', 'numbers', 'final', 'buttons', 'admin', 'quiz',
]

/** Человеческие названия разделов для админки. */
export const SECTION_TITLES: Record<TextSection, string> = {
  onboarding: 'Онбординг',
  evening: 'Вечерний ритуал',
  now: '«Практика сейчас»',
  pause: 'Пауза, возвращение, смена времени',
  numbers: 'Не цифра и свободный текст',
  final: 'Финал и день восьмой',
  buttons: 'Подписи кнопок',
  admin: 'Уведомления владельцу и служебное',
  quiz: 'Тест «Индекс внутренней опоры»',
}

export const DEFAULT_TEXTS: readonly TextDefault[] = [
  // ─────────────────────────── Онбординг (§2.1) ───────────────────────────
  {
    key: 'onb.welcome',
    value:
      'Привет. Это «Семь ночей»: семь вечеров подряд, каждый вечер одна аудиопрактика. Ничего готовить не надо: наушники и кровать. Вечером я напишу, а в конце недели покажу, что изменилось.',
    placeholders: [],
    section: 'onboarding',
    hint: 'Самое первое сообщение после /start.',
  },
  {
    key: 'onb.quiz_index',
    value: 'Твой индекс опоры сейчас {quiz_index} из ста. Это точка отсчёта, к ней вернёмся через семь вечеров.',
    placeholders: ['{quiz_index}', '{quiz_sum}'],
    section: 'onboarding',
    hint: 'Только для пришедших с теста на сайте, ровно один раз. Без теста строки просто нет.',
  },
  {
    key: 'onb.hour_ask',
    value: 'Во сколько вечером тебе удобно получать практику?',
    placeholders: [],
    section: 'onboarding',
    hint: 'Второй вопрос онбординга, под ним кнопки 21:00 / 22:00 / 23:00 / Другое время.',
  },
  {
    key: 'onb.hour_retry',
    value: 'Напиши час как на часах, например 21:30.',
    placeholders: [],
    section: 'onboarding',
    hint: 'Час не распознан или нажато «Другое время».',
  },
  {
    key: 'onb.clock_ask',
    value: 'Поняла, {time}. И одно уточнение, чтобы не перепутать часовой пояс. Сколько сейчас у тебя на часах?',
    placeholders: ['{time}'],
    section: 'onboarding',
    hint: 'Третий вопрос онбординга: по ответу вычисляется часовой пояс.',
  },
  {
    key: 'onb.clock_retry',
    value: 'Напиши время, как на телефоне, например 18:42.',
    placeholders: [],
    section: 'onboarding',
    hint: 'Время на часах не распознано или смещение вне допустимого диапазона.',
  },
  {
    key: 'onb.done_now',
    value: 'Открыла тебе семь вечеров. Первый можно начать прямо сейчас.',
    placeholders: ['{time}'],
    section: 'onboarding',
    hint: 'Онбординг закончился внутри вечернего окна — сразу за этим идёт вопрос «как ты».',
  },
  {
    key: 'onb.done_later',
    value:
      'Открыла тебе семь вечеров. Первая практика — {when} в {time}. До вечера можно ничего не делать, я напишу сама.',
    placeholders: ['{when}', '{time}'],
    section: 'onboarding',
    hint: 'Онбординг закончился вне вечернего окна.',
  },

  // ───────────────────────── Вечерний ритуал (§2.2) ─────────────────────────
  {
    key: 'ev.before_first',
    value:
      'Добрый вечер. Первый вечер из семи. Как ты сейчас, от 0 до 10? 0 — совсем тяжело, 10 — лучше некуда.',
    placeholders: ['{time}'],
    section: 'evening',
    hint: 'Вечерний пинг первого вечера.',
  },
  {
    key: 'ev.before',
    value: 'Добрый вечер. Вечер {n} из 7. Как ты сейчас, от 0 до 10?',
    placeholders: ['{n}', '{dots}', '{time}'],
    section: 'evening',
    hint: 'Вечерний пинг вечеров 2, 3, 5, 6.',
  },
  {
    key: 'ev.before_half',
    value: 'Добрый вечер. Четвёртый вечер, половина пути. Как ты сейчас, от 0 до 10?',
    placeholders: ['{n}', '{dots}'],
    section: 'evening',
    hint: 'Вечерний пинг четвёртого вечера.',
  },
  {
    key: 'ev.before_last',
    value: 'Добрый вечер. Седьмой вечер, последний. Как ты сейчас, от 0 до 10?',
    placeholders: ['{n}', '{dots}'],
    section: 'evening',
    hint: 'Вечерний пинг седьмого вечера.',
  },
  {
    key: 'ev.before_after_skip',
    value:
      'Вчера не получилось, это нормально. Продолжим с того места, где остановились. Вечер {n} из 7. Как ты сейчас, от 0 до 10?',
    placeholders: ['{n}', '{dots}'],
    section: 'evening',
    hint: 'Пинг после одного пропущенного вечера.',
  },
  {
    key: 'ev.before_after_skips',
    value:
      'Несколько дней не получилось, это нормально. Продолжим с того места, где остановились. Вечер {n} из 7. Как ты сейчас, от 0 до 10?',
    placeholders: ['{n}', '{dots}'],
    section: 'evening',
    hint: 'Пинг после двух и более пропущенных вечеров подряд.',
  },
  {
    key: 'ev.before_ack',
    value: 'Записала: {before} {bar}\nЧто сегодня ближе?',
    placeholders: ['{before}', '{bar}'],
    section: 'evening',
    hint: 'Ответ на цифру «до»: подтверждение и вопрос категории одним сообщением.',
  },
  {
    key: 'ev.state_ack',
    value: 'Сегодня: {category}.',
    placeholders: ['{category}', '{title}'],
    section: 'evening',
    hint: 'Во что превращается сообщение с кнопками категорий после выбора.',
  },
  {
    key: 'ev.practice_caption',
    value: 'Ложись, надень наушники и просто слушай.\n\n{line1}\n{line2}',
    placeholders: ['{line1}', '{line2}', '{title}', '{n}'],
    section: 'evening',
    hint: 'Подпись под аудио вечерней практики.',
  },
  {
    key: 'ev.practice_sleep_hint',
    value: 'Если уснёшь — хорошо. Утром спрошу, как ты.',
    placeholders: [],
    section: 'evening',
    hint: 'Добавляется к подписи только для практик категории «сон».',
  },
  {
    key: 'ev.after',
    value: 'А сейчас как, от 0 до 10?',
    placeholders: [],
    section: 'evening',
    hint: 'Вопрос «после» — по кнопке «Готово» или по таймеру.',
  },
  {
    key: 'ev.close',
    value: 'Записала: {after} {bar}\n{delta}\n{dots} Вечер {n} из 7. До завтра.',
    placeholders: ['{after}', '{bar}', '{delta}', '{dots}', '{n}', '{time}'],
    section: 'evening',
    hint: 'Закрытие вечеров 1–6.',
  },
  {
    key: 'ev.close_morning_tail',
    value: 'До вечера.',
    placeholders: ['{time}'],
    section: 'evening',
    hint: 'Заменяет «До завтра.» в конце ev.close, если цифра «после» пришла утром.',
  },
  {
    key: 'ev.delta_up',
    value: 'Было {before}, стало {after}. На {d} {деление} легче.',
    placeholders: ['{before}', '{after}', '{d}', '{деление}'],
    section: 'evening',
    hint: 'Строка {delta}, когда стало лучше. {деление} — склонение, его считает бот.',
  },
  {
    key: 'ev.delta_same',
    value: 'Ровно. Тоже честный ответ.',
    placeholders: ['{before}', '{after}'],
    section: 'evening',
    hint: 'Строка {delta}, когда цифра не изменилась.',
  },
  {
    key: 'ev.delta_down',
    value: 'Ниже на {d}. Бывает, это тоже часть недели.',
    placeholders: ['{before}', '{after}', '{d}', '{деление}'],
    section: 'evening',
    hint: 'Строка {delta}, когда стало ниже.',
  },
  {
    key: 'ev.delta_morning',
    value: 'Вечером было {before}, утром {after}.',
    placeholders: ['{before}', '{after}', '{d}'],
    section: 'evening',
    hint: 'Строка {delta}, когда цифра «после» пришла утром.',
  },
  {
    key: 'ev.morning',
    value:
      'Доброе утро. Вчера сон, похоже, пришёл раньше моего вопроса. Так и надо. Как ты сейчас, от 0 до 10?',
    placeholders: ['{n}'],
    section: 'evening',
    hint: 'Утренний догон: человек уснул, не ответив на «после».',
  },
  {
    key: 'ev.not_today',
    value: 'Хорошо. Напишу завтра в {time}.',
    placeholders: ['{time}', '{n}'],
    section: 'evening',
    hint: 'Нажата кнопка «Не сегодня».',
  },
  {
    key: 'ev.pause_offer',
    value: 'Хорошо. Хочешь, поставлю на паузу? Практики никуда не денутся.',
    placeholders: ['{n}'],
    section: 'evening',
    hint: 'Второе «Не сегодня» подряд.',
  },
  {
    key: 'ev.autopause',
    value:
      'Три вечера без практики. Поставила на паузу, чтобы не дёргать тебя. Когда захочешь — нажми «Продолжить».',
    placeholders: ['{n}'],
    section: 'evening',
    hint: 'Автопауза после трёх вечеров без единого ответа.',
  },

  // ─────────────────────── «Практика сейчас» (§2.3) ───────────────────────
  {
    key: 'now.before',
    value: 'Как ты сейчас, от 0 до 10?',
    placeholders: [],
    section: 'now',
    hint: 'Начало внесчётной сессии «Практика сейчас».',
  },
  {
    key: 'now.before_ack',
    value: 'Записала: {before} {bar}\nЧто сейчас ближе?',
    placeholders: ['{before}', '{bar}'],
    section: 'now',
    hint: 'Ответ на цифру «до» в сессии «Практика сейчас».',
  },
  {
    key: 'now.practice_caption',
    value: 'Найди место, где тебя не потревожат, надень наушники и просто слушай.\n\n{line1}\n{line2}',
    placeholders: ['{line1}', '{line2}', '{title}'],
    section: 'now',
    hint: 'Подпись под аудио в сессии «Практика сейчас».',
  },
  {
    key: 'now.after',
    value: 'А сейчас как, от 0 до 10?',
    placeholders: [],
    section: 'now',
    hint: 'Вопрос «после» в сессии «Практика сейчас».',
  },
  {
    key: 'now.close',
    value: 'Записала: {after} {bar}\n{delta}',
    placeholders: ['{after}', '{bar}', '{delta}'],
    section: 'now',
    hint: 'Закрытие сессии «Практика сейчас». Полоски пути {dots} здесь нет — вечер не засчитывается.',
  },
  {
    key: 'now.finish_first',
    value: 'Сначала цифра: как ты сейчас, от 0 до 10? Потом дам ещё практику.',
    placeholders: [],
    section: 'now',
    hint: '«Практика сейчас» нажата, пока бот ждёт цифру «после».',
  },

  // ────────────── Пауза, возвращение, смена времени (§2.5, §2.9) ──────────────
  {
    key: 'pause.on',
    value: 'Поставила на паузу. Ничего не сгорает. Когда захочешь — нажми «Продолжить».',
    placeholders: ['{n}'],
    section: 'pause',
    hint: 'Пауза кнопкой или словом «пауза», «стоп», «хватит», «не сейчас».',
  },
  {
    key: 'pause.off',
    value: 'Продолжаем. Вечер {n} из 7 — {when} в {time}.',
    placeholders: ['{n}', '{when}', '{time}'],
    section: 'pause',
    hint: '«Продолжить» вне вечернего окна.',
  },
  {
    key: 'start.idle',
    value: 'Ты на вечере {n} из 7. {when} в {time} пришлю практику.',
    placeholders: ['{n}', '{when}', '{time}', '{dots}'],
    section: 'pause',
    hint: 'Повторный /start, когда человек просто ждёт вечера.',
  },
  {
    key: 'start.paused',
    value: 'Сейчас пауза. Вечер {n} из 7 ждёт.',
    placeholders: ['{n}', '{dots}'],
    section: 'pause',
    hint: 'Повторный /start на паузе.',
  },
  {
    key: 'start.completed',
    value: 'Семь вечеров позади. Практика сейчас — кнопка внизу.',
    placeholders: [],
    section: 'pause',
    hint: 'Повторный /start после седьмого вечера.',
  },
  {
    key: 'time.hour_ask',
    value: 'Во сколько удобно получать практику?',
    placeholders: ['{time}'],
    section: 'pause',
    hint: 'Смена вечернего часа по кнопке «Поменять время».',
  },
  {
    key: 'time.clock_ask',
    value: 'И сколько сейчас у тебя на часах?',
    placeholders: [],
    section: 'pause',
    hint: 'Уточнение пояса при смене времени.',
  },
  {
    key: 'time.done',
    value: 'Теперь буду писать в {time}. Следующая практика — {when} в {time}.',
    placeholders: ['{time}', '{when}'],
    section: 'pause',
    hint: 'Время изменено.',
  },

  // ───────────────── Не цифра и свободный текст (§2.6) ─────────────────
  {
    key: 'num.fraction',
    value: 'Только целое. {a} или {b}?',
    placeholders: ['{a}', '{b}'],
    section: 'numbers',
    hint: 'Человек прислал дробь, например 6,5.',
  },
  {
    key: 'num.range',
    value: 'От 0 до 10 — какая ближе?',
    placeholders: [],
    section: 'numbers',
    hint: 'Число вне диапазона 0–10.',
  },
  {
    key: 'num.not_number',
    value: 'Мне нужна просто цифра от 0 до 10. Можно нажать на клавиатуре.',
    placeholders: [],
    section: 'numbers',
    hint: 'В ответе на вопрос про цифру числа нет вовсе.',
  },
  {
    key: 'num.long_text',
    value: 'Слышу тебя. Передала. Чтобы я могла это записать — одной цифрой, от 0 до 10.',
    placeholders: [],
    section: 'numbers',
    hint: 'Длинное сообщение вместо цифры: текст уходит специалисту, цифру всё равно ждём.',
  },
  {
    key: 'free.idle',
    value: 'Передала. Цифру спрошу вечером, в {time}. А если хочется практику сейчас — кнопка внизу.',
    placeholders: ['{time}', '{n}'],
    section: 'numbers',
    hint: 'Свободный текст между вечерами.',
  },
  {
    key: 'free.practicing',
    value: 'Практика у тебя выше. Когда дослушаешь, нажми «Готово».',
    placeholders: [],
    section: 'numbers',
    hint: 'Свободный текст, пока играет практика.',
  },
  {
    key: 'free.paused',
    value: 'Сейчас пауза. Передала твоё сообщение. Нажми «Продолжить», и вечером спрошу.',
    placeholders: ['{n}'],
    section: 'numbers',
    hint: 'Свободный текст на паузе.',
  },
  {
    key: 'free.completed',
    value: 'Передала. Если хочется практику — кнопка внизу.',
    placeholders: [],
    section: 'numbers',
    hint: 'Свободный текст после седьмого вечера.',
  },
  {
    key: 'err.no_practices',
    value: 'Практики ещё загружаются. Загляни чуть позже.',
    placeholders: [],
    section: 'numbers',
    hint: 'В библиотеке нет ни одной активной практики. Владельцу уходит отдельное уведомление.',
  },
  {
    key: 'cb.expired',
    value: 'Это уже прошло',
    placeholders: [],
    section: 'numbers',
    hint: 'Всплывающий ответ на нажатие устаревшей inline-кнопки.',
  },
  {
    key: 'cb.need_number',
    value: 'Жду цифру от 0 до 10',
    placeholders: [],
    section: 'numbers',
    hint: 'Всплывающий ответ на кнопку, когда ожидается цифра.',
  },

  // ──────────────── Финал, день восьмой, перезапуск (§2.7, §2.8) ────────────────
  {
    key: 'final.close',
    value: 'Записала: {after} {bar}\n{delta}',
    placeholders: ['{after}', '{bar}', '{delta}'],
    section: 'final',
    hint: 'Первое сообщение финала седьмого вечера, до графика.',
  },
  {
    key: 'final.chart_caption',
    value: 'Смотри, где всё началось и где ты сейчас.\n\nБыло {first_before}. Стало {last_after}.',
    placeholders: ['{first_before}', '{last_after}'],
    section: 'final',
    hint: 'Подпись под картинкой с графиком недели.',
  },
  {
    key: 'final.no_after',
    value: 'Было {first_before}. Стало — ты знаешь лучше меня.',
    placeholders: ['{first_before}'],
    section: 'final',
    hint: 'Подпись под графиком, если ни одной цифры «после» не было.',
  },
  {
    key: 'final.invite',
    value: 'Если захочешь разобрать своё, приходи на разговор. Тридцать минут, вдвоём.',
    placeholders: [],
    section: 'final',
    hint: 'Приглашение после графика. Кнопка появляется, только если в настройках задана ссылка.',
  },
  {
    key: 'final.day8',
    value:
      'Семь ночей позади. Практики остаются с тобой: кнопка «Практика сейчас» никуда не денется. Спасибо за эту неделю.',
    placeholders: ['{first_before}', '{last_after}'],
    section: 'final',
    hint: 'Утро восьмого дня. Отправляется один раз, дальше бот молчит.',
  },
  {
    key: 'restart.done',
    value: 'Открыла тебе семь вечеров заново. Первая практика — {when} в {time}.',
    placeholders: ['{when}', '{time}'],
    section: 'final',
    hint: 'Нажата кнопка «Ещё семь вечеров».',
  },

  // ─────────────────────────── Подписи кнопок (§4) ───────────────────────────
  { key: 'btn.practice_now', value: 'Практика сейчас', placeholders: [], section: 'buttons',
    hint: 'Постоянная кнопка внизу экрана.' },
  { key: 'btn.done', value: 'Готово', placeholders: [], section: 'buttons',
    hint: 'Кнопка под аудио.' },
  { key: 'btn.not_today', value: 'Не сегодня', placeholders: [], section: 'buttons',
    hint: 'Третий ряд клавиатуры цифр на вечернем пинге.' },
  { key: 'btn.better_at', value: 'Лучше в {time}', placeholders: ['{time}'], section: 'buttons',
    hint: 'Перенести первый вечер на вечерний час (только в онбординге).' },
  { key: 'btn.pause', value: 'Пауза', placeholders: [], section: 'buttons',
    hint: 'Появляется после второго «Не сегодня» подряд.' },
  { key: 'btn.remind_tomorrow', value: 'Завтра напомни', placeholders: [], section: 'buttons',
    hint: 'Рядом с «Пауза» в предложении паузы.' },
  { key: 'btn.resume', value: 'Продолжить', placeholders: [], section: 'buttons',
    hint: 'Выход из паузы.' },
  { key: 'btn.cat_sleep', value: '😴 Сон и расслабление', placeholders: [], section: 'buttons',
    hint: 'Категория практики.' },
  { key: 'btn.cat_stress', value: '🌿 Тревога и стресс', placeholders: [], section: 'buttons',
    hint: 'Категория практики.' },
  { key: 'btn.cat_day_morning', value: '🌅 Настроиться на день', placeholders: [], section: 'buttons',
    hint: 'Третья категория до 14:00 по местному времени человека.' },
  { key: 'btn.cat_day_evening', value: '🌅 Настроиться на завтра', placeholders: [], section: 'buttons',
    hint: 'Та же категория после 14:00.' },
  { key: 'btn.change_time', value: 'Поменять время', placeholders: [], section: 'buttons',
    hint: 'Inline-кнопка под ответом на повторный /start.' },
  { key: 'btn.other_hour', value: 'Другое время', placeholders: [], section: 'buttons',
    hint: 'В вопросе про удобный вечерний час.' },
  { key: 'btn.other_clock', value: 'Другое', placeholders: [], section: 'buttons',
    hint: 'В вопросе «сколько сейчас на часах».' },
  { key: 'btn.talk', value: 'Записаться на разговор', placeholders: [], section: 'buttons',
    hint: 'Ссылка в финале. Без ссылки в настройках кнопки нет.' },
  { key: 'btn.channel', value: 'Мой канал', placeholders: [], section: 'buttons',
    hint: 'Ссылка в сообщении дня восьмого.' },
  { key: 'btn.restart', value: 'Ещё семь вечеров', placeholders: [], section: 'buttons',
    hint: 'Новый круг программы. Скрывается настройкой allow_restart.' },
  { key: 'btn.quiz_start', value: 'Пройти семь вопросов', placeholders: [], section: 'buttons',
    hint: 'Предложение повторить тест после седьмого вечера.' },
  { key: 'btn.quiz_skip', value: 'Не сейчас', placeholders: [], section: 'buttons',
    hint: 'Отказ от повторного теста — больше не предлагаем.' },
  { key: 'btn.quiz_back', value: 'Назад', placeholders: [], section: 'buttons',
    hint: 'Вернуться к предыдущему вопросу теста.' },
  { key: 'btn.quiz_resume', value: 'Продолжить тест', placeholders: [], section: 'buttons',
    hint: 'Человек бросил тест на середине — предлагаем один раз.' },

  // ─────────── Уведомления владельцу и служебные ответы (Приложение А) ───────────
  {
    key: 'admin.started',
    value: '🟢 Новый участник #{id}. Вечер в {time}, пояс {tz}.',
    placeholders: ['{id}', '{time}', '{tz}'],
    section: 'admin',
    hint: 'Онбординг завершён. {id} — номер участника, telegram id владельцу не показываем.',
  },
  {
    key: 'admin.finished',
    value:
      '🏁 Участник #{id} прошёл седьмой вечер. Было {first_before}, стало {last_after}. Средний прирост за вечер {avg}.',
    placeholders: ['{id}', '{first_before}', '{last_after}', '{avg}'],
    section: 'admin',
    hint: 'Седьмой вечер закрыт.',
  },
  {
    key: 'admin.silent',
    value: '🔕 Участник #{id} (вечер {n} из 7) не открывал бота 3 дня.',
    placeholders: ['{id}', '{n}'],
    section: 'admin',
    hint: 'Один раз на одну серию молчания.',
  },
  {
    key: 'admin.blocked',
    value: '⛔ Участник #{id} заблокировал бота на вечере {n} из 7.',
    placeholders: ['{id}', '{n}'],
    section: 'admin',
    hint: 'Telegram ответил 403 на отправке.',
  },
  {
    key: 'admin.message',
    value: '✉️ Участник #{id} написал: «{text}»',
    placeholders: ['{id}', '{text}', '{n}'],
    section: 'admin',
    hint: 'Человек написал длинное сообщение вместо цифры.',
  },
  {
    key: 'admin.no_practices',
    value: '⚠️ Библиотека практик пуста — участник #{id} не получил практику.',
    placeholders: ['{id}'],
    section: 'admin',
    hint: 'Критическая ситуация: человек дошёл до практики, а отдавать нечего.',
  },
  {
    key: 'admin.whoami',
    value: 'Твой telegram id: {tg_id}. Номер участника: #{id}.',
    placeholders: ['{id}', '{tg_id}'],
    section: 'admin',
    hint: 'Ответ на /whoami — так владелец узнаёт свой id для ADMIN_TG_IDS.',
  },
  {
    key: 'demo.on',
    value: 'Демо-режим: вечер длится пару минут.',
    placeholders: [],
    section: 'admin',
    hint: 'Ответ на /demo с верным секретом.',
  },
  {
    key: 'demo.off',
    value: 'Демо-режим выключен.',
    placeholders: [],
    section: 'admin',
    hint: 'Повторный /demo выключает ускоренный режим.',
  },
  {
    key: 'demo.reset_done',
    value: 'Готово.',
    placeholders: [],
    section: 'admin',
    hint: 'Ответ на /reset: человек удалён, следующий /start начнёт всё заново.',
  },

  // ───────── Тест «Индекс внутренней опоры» (quiz-spec.md, дословно) ─────────
  {
    key: 'quiz.offer',
    value: 'Семь вечеров назад твой индекс опоры был {quiz_index}. Хочешь посмотреть, что с ним сейчас?',
    placeholders: ['{quiz_index}'],
    section: 'quiz',
    hint: 'Отдельное сообщение после графика и приглашения. Только если входной индекс есть.',
  },
  {
    key: 'quiz.question',
    value: '{k} / 7\n\n{text}\n\n0 — {low}\n10 — {high}',
    placeholders: ['{k}', '{text}', '{low}', '{high}'],
    section: 'quiz',
    hint: 'Формат сообщения с вопросом теста. {text}, {low}, {high} берутся из quiz.qN ниже.',
  },
  {
    key: 'quiz.resume_offer',
    value: 'Осталось {k} {вопрос}. Продолжим?',
    placeholders: ['{k}', '{вопрос}'],
    section: 'quiz',
    hint: 'Тест брошен на середине. Предлагаем ровно один раз. {вопрос} — склонение, его считает бот.',
  },
  {
    key: 'quiz.compare',
    value: 'Было {quiz_index}. Стало {quiz_index_after}.',
    placeholders: ['{quiz_index}', '{quiz_index_after}'],
    section: 'quiz',
    hint: 'Первая строка результата повторного теста.',
  },
  {
    key: 'quiz.q1',
    value: 'Когда что-то идёт не по плану, насколько быстро ты можешь вернуться в нормальное состояние?',
    placeholders: [], section: 'quiz', hint: 'Вопрос 1. Формулировка согласована, менять нельзя.',
  },
  { key: 'quiz.q1.low', value: 'меня надолго выбивает', placeholders: [], section: 'quiz', hint: 'Что значит 0 в вопросе 1.' },
  { key: 'quiz.q1.high', value: 'довольно быстро возвращаюсь к себе', placeholders: [], section: 'quiz', hint: 'Что значит 10 в вопросе 1.' },
  {
    key: 'quiz.q2',
    value: 'Насколько ты можешь принимать решения, даже если близкие с тобой не согласны?',
    placeholders: [], section: 'quiz', hint: 'Вопрос 2. Формулировка согласована, менять нельзя.',
  },
  { key: 'quiz.q2.low', value: 'чужое мнение сильно определяет мой выбор', placeholders: [], section: 'quiz', hint: 'Что значит 0 в вопросе 2.' },
  { key: 'quiz.q2.high', value: 'могу услышать других, но решение остаётся моим', placeholders: [], section: 'quiz', hint: 'Что значит 10 в вопросе 2.' },
  {
    key: 'quiz.q3',
    value: 'Насколько легко ты можешь сказать «нет», когда внутри действительно не хочешь?',
    placeholders: [], section: 'quiz', hint: 'Вопрос 3. Формулировка согласована, менять нельзя.',
  },
  { key: 'quiz.q3.low', value: 'почти всегда соглашаюсь через себя', placeholders: [], section: 'quiz', hint: 'Что значит 0 в вопросе 3.' },
  { key: 'quiz.q3.high', value: 'могу спокойно отказать без долгого чувства вины', placeholders: [], section: 'quiz', hint: 'Что значит 10 в вопросе 3.' },
  {
    key: 'quiz.q4',
    value:
      'Когда тебе тревожно, обидно или тяжело, насколько ты умеешь помочь себе вернуться в более спокойное состояние?',
    placeholders: [], section: 'quiz', hint: 'Вопрос 4. Формулировка согласована, менять нельзя.',
  },
  { key: 'quiz.q4.low', value: 'мне обязательно нужен кто-то или что-то извне', placeholders: [], section: 'quiz', hint: 'Что значит 0 в вопросе 4.' },
  { key: 'quiz.q4.high', value: 'у меня есть способы помочь себе', placeholders: [], section: 'quiz', hint: 'Что значит 10 в вопросе 4.' },
  {
    key: 'quiz.q5',
    value: 'Насколько хорошо ты умеешь оставлять чужие проблемы, работу и конфликты там, где они произошли?',
    placeholders: [], section: 'quiz', hint: 'Вопрос 5. Формулировка согласована, менять нельзя.',
  },
  { key: 'quiz.q5.low', value: 'долго ношу всё это с собой', placeholders: [], section: 'quiz', hint: 'Что значит 0 в вопросе 5.' },
  { key: 'quiz.q5.high', value: 'умею переключаться и возвращаться в свою жизнь', placeholders: [], section: 'quiz', hint: 'Что значит 10 в вопросе 5.' },
  {
    key: 'quiz.q6',
    value: 'Когда ты не можешь контролировать происходящее, насколько тебе удаётся сохранять ощущение, что ты справишься?',
    placeholders: [], section: 'quiz', hint: 'Вопрос 6. Формулировка согласована, менять нельзя.',
  },
  { key: 'quiz.q6.low', value: 'неопределённость выбивает почву из-под ног', placeholders: [], section: 'quiz', hint: 'Что значит 0 в вопросе 6.' },
  { key: 'quiz.q6.high', value: 'даже без всех ответов чувствую: разберусь по ходу', placeholders: [], section: 'quiz', hint: 'Что значит 10 в вопросе 6.' },
  {
    key: 'quiz.q7',
    value:
      'Если из твоей жизни временно убрать одобрение, помощь и поддержку других людей, насколько внутри остаётся ощущение: «Я у себя есть»?',
    placeholders: [], section: 'quiz', hint: 'Вопрос 7. Формулировка согласована, менять нельзя.',
  },
  { key: 'quiz.q7.low', value: 'почти не чувствую этого', placeholders: [], section: 'quiz', hint: 'Что значит 0 в вопросе 7.' },
  { key: 'quiz.q7.high', value: 'очень хорошо чувствую', placeholders: [], section: 'quiz', hint: 'Что значит 10 в вопросе 7.' },
  {
    key: 'quiz.result1',
    value:
      'Сейчас значительная часть твоего чувства устойчивости зависит от того, что происходит вокруг. Это точка, с которой можно начинать.',
    placeholders: [], section: 'quiz', hint: 'Сумма 0–21 (индекс 0–30).',
  },
  {
    key: 'quiz.result2',
    value:
      'Опора уже есть, но в сложных ситуациях её легко потерять, особенно в отношениях, конфликтах или неопределённости.',
    placeholders: [], section: 'quiz', hint: 'Сумма 22–35 (индекс 31–50).',
  },
  {
    key: 'quiz.result3',
    value:
      'Во многих ситуациях ты умеешь возвращаться к себе, но есть обстоятельства, которые всё ещё сильно выбивают.',
    placeholders: [], section: 'quiz', hint: 'Сумма 36–49 (индекс 51–70).',
  },
  {
    key: 'quiz.result4',
    value:
      'Внутренняя опора достаточно устойчива. Ты чаще можешь оставаться собой, даже когда внешнее меняется.',
    placeholders: [], section: 'quiz', hint: 'Сумма 50–59 (индекс 71–85).',
  },
  {
    key: 'quiz.result5',
    value:
      'Сейчас ты ощущаешь высокую внутреннюю устойчивость. Но это не «уровень навсегда»: состояние меняется, поэтому внутреннюю опору продолжают поддерживать.',
    placeholders: [], section: 'quiz', hint: 'Сумма 60–70 (индекс 86–100).',
  },
  {
    key: 'quiz.disclaimer',
    value: 'Это не диагноз и не оценка твоей личности. Это фотография твоего состояния сегодня.',
    placeholders: [], section: 'quiz',
    hint: 'Обязателен под любым результатом. Убирать нельзя.',
  },
]

/** Границы результата теста по СУММЕ (§ «Подсчёт» quiz-spec): первичны, чтобы округление индекса не сдвигало группу. */
export const QUIZ_RESULT_BOUNDS: ReadonlyArray<{ maxSum: number; key: string }> = [
  { maxSum: 21, key: 'quiz.result1' },
  { maxSum: 35, key: 'quiz.result2' },
  { maxSum: 49, key: 'quiz.result3' },
  { maxSum: 59, key: 'quiz.result4' },
  { maxSum: 70, key: 'quiz.result5' },
]

/** Ключ текста результата по сумме ответов 0…70. */
export function quizResultKey(sum: number): string {
  for (const b of QUIZ_RESULT_BOUNDS) if (sum <= b.maxSum) return b.key
  return 'quiz.result5'
}

/** Индекс 0…100 из суммы 0…70. Считается по сумме, не наоборот. */
export function quizIndex(sum: number): number {
  return Math.round((sum / 70) * 100)
}

/**
 * Настройки по умолчанию (§2.4 архитектуры). Значения — строки: колонка settings.value
 * текстовая, типизацию делает src/db/settings.ts. Так админка может править любую
 * настройку одним и тем же полем ввода, не зная про типы.
 */
export const DEFAULT_SETTINGS: ReadonlyArray<{ key: string; value: string }> = [
  { key: 'talk_url', value: '' },
  { key: 'channel_url', value: '' },
  { key: 'admin_tg_ids', value: '' },
  { key: 'default_tz_offset_min', value: '180' },
  { key: 'allow_restart', value: '1' },
  { key: 'demo_secret', value: '' }, // пустое = «сгенерировать при засеве», см. scripts/seed.ts
  {
    key: 'sleep_route',
    value: JSON.stringify([
      'sleep-landing', 'sleep-warmth', 'sleep-release', 'sleep-shuffle',
      'sleep-warmth', 'sleep-release', 'sleep-landing',
    ]),
  },
  { key: 'autopause_after_skips', value: '3' },
  { key: 'silence_hours', value: '72' },
  { key: 'morning_hour', value: '10:00' },
  { key: 'ritual_day_start_hour', value: '4' },
  { key: 'evening_window_lead_min', value: '60' },
  { key: 'long_text_threshold', value: '60' },
  { key: 'quiz_after_enabled', value: '1' },
]
