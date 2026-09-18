/**
 * Русские склонения после числительного.
 *
 * Нужны ровно в одном месте продукта, но это место человек видит семь вечеров
 * подряд: «На 3 деления легче». «На 3 делений» сломало бы ощущение, что с тобой
 * говорит человек, а не рассылка.
 */

export type PluralForms = [one: string, few: string, many: string]

/**
 * 1, 21, 31 → forms[0]; 2–4, 22–24 → forms[1]; 0, 5–20, 25–30 → forms[2].
 * Исключение 11–14 — «одиннадцать делений», а не «одиннадцать деление».
 */
export function plural(n: number, forms: PluralForms): string {
  const abs = Math.abs(Math.trunc(n))
  const mod100 = abs % 100
  if (mod100 >= 11 && mod100 <= 14) return forms[2]
  const mod10 = abs % 10
  if (mod10 === 1) return forms[0]
  if (mod10 >= 2 && mod10 <= 4) return forms[1]
  return forms[2]
}

/** Число вместе с формой: «3 деления». */
export function pluralize(n: number, forms: PluralForms): string {
  return `${n} ${plural(n, forms)}`
}

export const DIVISION_FORMS: PluralForms = ['деление', 'деления', 'делений']
export const QUESTION_FORMS: PluralForms = ['вопрос', 'вопроса', 'вопросов']
export const EVENING_FORMS: PluralForms = ['вечер', 'вечера', 'вечеров']
export const DAY_FORMS: PluralForms = ['день', 'дня', 'дней']
export const MINUTE_FORMS: PluralForms = ['минута', 'минуты', 'минут']

/** Значение служебного плейсхолдера {деление} из Приложения А design-bot. */
export function divisionWord(n: number): string {
  return plural(n, DIVISION_FORMS)
}

/**
 * Значение служебного плейсхолдера {вопрос} в quiz.resume_offer.
 * Тот же приём, что и {деление}: склонение считает бот, в тексте админки
 * стоит плейсхолдер — иначе владелец, правя формулировку, обязан был бы
 * держать в голове три формы.
 */
export function questionWord(n: number): string {
  return plural(n, QUESTION_FORMS)
}
