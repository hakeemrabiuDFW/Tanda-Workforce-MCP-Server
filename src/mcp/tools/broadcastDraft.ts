/**
 * WFM-105 (#64): a bilingual (Spanish / English) SMS draft for a crew, with who it would go to
 * and what it costs in segments. Draft only: there is no send path, and the only Tanda calls are
 * GETs to /locations, /departments, /users and /schedules. Phone numbers never leave the server;
 * each recipient only says whether one is on file.
 */
import { Tool } from './types';
import { ArgError, idList, num, oneOf, S, text } from '../args';
import { loadOrg, peopleFrom, USERS_TTL_MS } from '../context';
import { guardResponse } from '../guard';
import { Rec } from '../../tanda/client';
import { itemDate } from '../../tanda/normalize';
import { isDate, todayInZone, toZonedISO } from '../../utils/time';
import { isTestOrNoStartDate } from '../apps/staffing';
import { smsLength } from '../sms';
import { soft, Warning, withWarnings } from '../warnings';

const MAX_MESSAGE = 320;

export const TEMPLATES = {
  shift_reminder: {
    es: 'Recordatorio: tiene turno en {site} el {date}{time}. Responda si no puede ir.',
    en: "Reminder: you have a shift at {site} on {date}{time}. Reply if you can't make it.",
  },
  schedule_change: {
    es: 'Cambio de horario en {site} el {date}{time}. Revise su horario en la app Workforce.',
    en: 'Schedule change at {site} on {date}{time}. Please check your schedule in the Workforce app.',
  },
  cover_needed: {
    es: 'Se necesita personal en {site} el {date}{time}. Responda SÍ si puede cubrir el turno.',
    en: 'Cover needed at {site} on {date}{time}. Reply YES if you can take the shift.',
  },
  site_closed: {
    es: '{site} estará cerrado el {date}. No vaya a trabajar ese día; su supervisor le confirmará.',
    en: '{site} is closed on {date}. Do not come in that day; your supervisor will confirm.',
  },
} as const;
type TemplateName = keyof typeof TEMPLATES;
const TEMPLATE_NAMES = Object.keys(TEMPLATES) as TemplateName[];

const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** "lunes, 23 de noviembre" / "Monday, November 23" for a YYYY-MM-DD date. */
function spokenDate(date: string, lang: 'es' | 'en'): string {
  const fmt = new Intl.DateTimeFormat(lang === 'es' ? 'es-US' : 'en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  return fmt.format(new Date(`${date}T12:00:00Z`));
}

/** " a las 17:00" / " at 5:00 PM", or "" with no time. */
function spokenTime(time: string | undefined, lang: 'es' | 'en'): string {
  if (!time) return '';
  const [, h, m] = TIME_RE.exec(time) as RegExpExecArray;
  const hour = Number(h);
  if (lang === 'es') return ` a las ${hour}:${m}`;
  return ` at ${hour % 12 || 12}:${m} ${hour < 12 ? 'AM' : 'PM'}`;
}

function fill(message: string, values: Record<string, string | null>, lang: string): string {
  return message.replace(/\{(\w+)\}/g, (whole, key: string) => {
    if (!(key in values)) throw new ArgError(`Unknown placeholder ${whole} in the ${lang} message. Use {site}, {date} or {time}.`);
    const v = values[key];
    if (v === null) throw new ArgError(`The ${lang} message uses ${whole}; give ${key === 'site' ? 'location_id' : key}.`);
    return v;
  });
}

export const broadcastDraftTool: Tool = {
  name: 'tanda_broadcast_draft',
  description:
    'Drafts a bilingual (Spanish then English) SMS for the crew rostered at a site or department on a date, or for chosen user_ids, with SMS segment counts and the recipient list (phone on file yes/no, never the number); nothing is sent or written to Tanda.',
  inputSchema: {
    type: 'object',
    properties: {
      template: { type: 'string', enum: TEMPLATE_NAMES, description: 'Built-in wording in both languages. Or write your own with message_es + message_en' },
      message_es: { type: 'string', description: `Spanish text, at most ${MAX_MESSAGE} characters. Placeholders {site}, {date}, {time}` },
      message_en: { type: 'string', description: `English text, at most ${MAX_MESSAGE} characters. Same placeholders` },
      date: { type: 'string', description: 'YYYY-MM-DD the message is about; also the day whose roster picks the crew. Default today' },
      time: { type: 'string', description: 'Optional "HH:MM" (24h) for {time}' },
      location_id: { type: 'number', description: 'Site: the crew rostered there on `date`, and {site}' },
      department_ids: S.departmentIds,
      user_ids: { ...S.userIds, description: 'Send to exactly these people instead of the rostered crew' },
      offset: S.offset,
      limit: S.limit,
    },
  },
  async run(client, args) {
    const template = args.template === undefined || args.template === null || args.template === ''
      ? null : oneOf(args.template, TEMPLATE_NAMES, TEMPLATE_NAMES[0], 'template');
    const customEs = text(args.message_es, 'message_es', MAX_MESSAGE);
    const customEn = text(args.message_en, 'message_en', MAX_MESSAGE);
    if (template && (customEs || customEn)) throw new ArgError('Give a template or message_es + message_en, not both.');
    if (!template && !(customEs && customEn)) {
      throw new ArgError('Give a template, or both message_es and message_en (write the Spanish yourself; this server does not translate).');
    }
    const date = args.date === undefined || args.date === null || args.date === '' ? todayInZone() : args.date;
    if (!isDate(date)) throw new ArgError('`date` must be a date in YYYY-MM-DD format.');
    const time = text(args.time, 'time', 5);
    if (time && !TIME_RE.test(time)) throw new ArgError('time must be "HH:MM" in 24-hour time, e.g. "17:00".');
    const locationId = num(args.location_id) ?? null;
    const deptIds = idList(args.department_ids);
    const userIds = idList(args.user_ids);
    if (!userIds && locationId === null && !deptIds) {
      throw new ArgError('Say who it goes to: location_id or department_ids (the crew rostered that day), or user_ids.');
    }

    const warnings: Warning[] = [];
    const [org, users] = await Promise.all([
      loadOrg(client),
      soft(warnings, 'recipients', null as Rec[] | null, () => client.getUsers({ freshMs: USERS_TTL_MS })),
    ]);
    if (locationId !== null && !org.locationById.has(locationId)) throw new ArgError(`No site with location_id ${locationId}.`);

    const site = locationId !== null ? org.locationName(locationId) : null;
    const draftFor = (lang: 'es' | 'en') => {
      const raw = template ? TEMPLATES[template][lang] : lang === 'es' ? customEs as string : customEn as string;
      return fill(raw, { site, date: spokenDate(date, lang), time: spokenTime(time, lang) }, lang === 'es' ? 'Spanish' : 'English');
    };
    const es = draftFor('es');
    const en = draftFor('en');
    const combined = `${es}\n\n${en}`;

    // The crew: everyone rostered that day at the site or departments, unless user_ids names them
    let shiftsByUser = new Map<number, Rec[]>();
    if (!userIds) {
      const depts = new Set(deptIds ?? []);
      const schedules = await client.getSchedules({ from: date, to: date });
      for (const x of schedules) {
        const uid = x.user_id as number | null | undefined;
        const dept = (x.department_id as number | undefined) ?? null;
        if (!uid || itemDate(x) !== date || dept === null) continue;
        const atSite = locationId !== null && org.deptLocation.get(dept) === locationId;
        if (!atSite && !depts.has(dept)) continue;
        const list = shiftsByUser.get(uid) ?? [];
        list.push(x);
        shiftsByUser.set(uid, list);
      }
    } else {
      shiftsByUser = new Map(userIds.map((id) => [id, []]));
    }

    const people = users ? peopleFrom(users) : null;
    const leftOut = { not_active: 0, test_or_no_start_date: 0 };
    const rows: Rec[] = [];
    for (const [uid, shifts] of shiftsByUser) {
      const u = people?.byId.get(uid);
      if (people && !u) { leftOut.not_active++; continue; }
      if (u && isTestOrNoStartDate(u)) { leftOut.test_or_no_start_date++; continue; }
      const sorted = [...shifts].sort((a, b) => Number(a.start) - Number(b.start));
      rows.push({
        user_id: uid,
        user_name: u ? (u.name as string) ?? null : null,
        has_phone: u ? Boolean(u.phone || u.normalised_phone) : null,
        ...(sorted.length ? {
          shifts: sorted.map((x) => ({
            location_name: org.locationName(org.deptLocation.get(x.department_id as number) ?? null),
            department_name: org.departmentName(x.department_id as number),
            start_iso: toZonedISO(x.start),
            finish_iso: toZonedISO(x.finish),
          })),
        } : {}),
      });
    }
    rows.sort((a, b) => String(a.user_name ?? '').localeCompare(String(b.user_name ?? '')) || Number(a.user_id) - Number(b.user_id));

    const withPhone = rows.filter((r) => r.has_phone === true).length;
    const combinedLength = smsLength(combined);
    return guardResponse(
      {
        date,
        ...(site ? { location_id: locationId, location_name: site } : {}),
        ...(deptIds ? { department_ids: deptIds } : {}),
        audience: userIds ? 'user_ids' : 'rostered',
        ...(template ? { template } : {}),
        draft: {
          es: { text: es, ...smsLength(es) },
          en: { text: en, ...smsLength(en) },
          combined: { text: combined, ...combinedLength },
        },
        recipients: rows.length,
        with_phone: people ? withPhone : null,
        without_phone: people ? rows.length - withPhone : null,
        estimated_segments: people ? withPhone * combinedLength.segments : null,
        left_out: leftOut,
        ...(rows.length ? {} : { note_empty: userIds ? 'None of the user_ids is an active, real staff member.' : 'Nobody is rostered there on that date.' }),
        note: 'Draft only: nothing was sent and nothing was written to Tanda. A manager approves the wording and sends it from Workforce. Phone numbers are not returned.',
      },
      rows,
      { offset: args.offset, pageSize: args.limit, extra: withWarnings(warnings) }
    );
  },
};
