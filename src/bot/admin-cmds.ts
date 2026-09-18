/**
 * Скрытые команды. Строки 54–56 таблицы переходов §3.2, §3.6 design-bot.
 *
 * В меню Telegram их нет и быть не должно: setMyCommands([]) — часть обещания
 * «ноль меню, ноль настроек». Это инструмент владельца и приёмочного прогона,
 * а не интерфейс продукта.
 *
 * /demo и /reset закрыты секретом из настроек, а не списком admin_tg_ids: секрет
 * можно передать тестировщику на один прогон и сменить, не трогая .env.
 */

import type { Ctx } from '../ctx.ts'
import type { UserRow } from '../db/types.ts'
import { commonVars, fresh, homeKbFor, recomputeDue } from './flow.ts'

export type CommandResult = 'handled' | 'unknown'

/** Секрет сравниваем целиком и без учёта регистра — его диктуют голосом. */
function secretOk(ctx: Ctx, arg: string): boolean {
  const secret = ctx.settings.str('demo_secret', '')
  if (secret === '') return false
  return arg.trim().toLowerCase() === secret.toLowerCase()
}

export async function handleCommand(
  ctx: Ctx,
  user: UserRow,
  cmd: string,
  arg: string,
  now: number,
): Promise<CommandResult> {
  const u = fresh(ctx, user)

  switch (cmd) {
    case 'whoami':
      // Единственный способ узнать свой tg_id, чтобы вписать его в ADMIN_TG_IDS.
      await ctx.send.text(u, 'admin.whoami', { id: u.id, tg_id: u.tg_id })
      return 'handled'

    case 'demo': {
      if (!secretOk(ctx, arg)) return 'unknown'
      const on = u.demo === 0
      ctx.db.transaction(() => {
        ctx.repo.users.update(u.id, { demo: on ? 1 : 0, demo_day_counter: 0 })
        ctx.repo.events.add(u.id, on ? 'demo_on' : 'demo_off', now, {})
      })()
      const u2 = fresh(ctx, u)
      // Сроки в демо другие — всё, что уже стояло, нужно пересчитать, иначе
      // человек остаётся с вечерним пингом «завтра в 21:00» в ускоренном режиме.
      recomputeDue(ctx, u2, now)
      await ctx.send.text(u2, on ? 'demo.on' : 'demo.off', commonVars(ctx, u2, now), homeKbFor(ctx, u2))
      return 'handled'
    }

    case 'reset': {
      if (!secretOk(ctx, arg)) return 'unknown'
      // Отвечаем ДО удаления: после каскада отправлять уже некому — строки не будет.
      await ctx.send.text(u, 'demo.reset_done', { id: u.id }, { removeReply: true })
      ctx.repo.events.add(null, 'reset', now, { user_id: u.id, tg_id: u.tg_id })
      ctx.repo.users.deleteCascade(u.id)
      ctx.log.info('пользователь удалён по /reset', { user_id: u.id })
      return 'handled'
    }

    default:
      return 'unknown'
  }
}
