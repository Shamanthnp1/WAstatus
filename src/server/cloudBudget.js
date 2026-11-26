'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * Message budget for the WhatsApp Cloud API line.
 *
 * Meta gives each business number 1,000 free service messages a month and
 * charges for every one after that. This counts what the server sends, keeps
 * the line inside a monthly budget (default 950, leaving a margin for sends we
 * can't see, such as the old container's last ones during a restart), and by
 * default spreads what is left evenly over the rest of the month so the free
 * messages don't run out on the first busy day.
 *
 * Counts persist in a small JSON file (on Azure: /home, which survives
 * restarts). Months and days follow CLOUD_BUDGET_TZ, which must match the
 * Messaging account's timezone: Meta resets the free tier at midnight there.
 *
 * Settings:
 *   CLOUD_MONTHLY_MESSAGE_BUDGET  default 950; raise it to allow paid messages
 *   CLOUD_DAILY_MESSAGE_BUDGET    'auto' (default: spread the month), a number, or 'off'
 *   CLOUD_BUDGET_TZ               default Asia/Kolkata
 *   CLOUD_USAGE_FILE              where the counts are kept
 *
 * Also records deliveries and messages per country calling code (never full
 * numbers), so pricing can be based on where users really are.
 */

const DEFAULT_MONTHLY_BUDGET = 950;
const DEFAULT_TIME_ZONE = 'Asia/Kolkata';
/** Deliveries one WhatsApp number may get per day (CLOUD_USER_DAILY_DELIVERIES). */
const DEFAULT_USER_DAILY_DELIVERIES = 7;

// Two-digit country calling codes. 1 (North America) and 7 (Russia,
// Kazakhstan) are one digit; every other code is three digits.
const TWO_DIGIT_CODES = new Set([
  '20', '27', '30', '31', '32', '33', '34', '36', '39', '40', '41', '43', '44', '45', '46', '47',
  '48', '49', '51', '52', '53', '54', '55', '56', '57', '58', '60', '61', '62', '63', '64', '65',
  '66', '81', '82', '84', '86', '90', '91', '92', '93', '94', '95', '98',
]);

/** Country calling code of an international number ('49' for +49 ...), or 'unknown'. */
function callingCode(number) {
  const digits = String(number || '').replace(/\D/g, '');
  if (digits.length < 7) return 'unknown';
  if (digits[0] === '1' || digits[0] === '7') return digits[0];
  if (TWO_DIGIT_CODES.has(digits.slice(0, 2))) return digits.slice(0, 2);
  return digits.slice(0, 3);
}

/** 'YYYY-MM-DD' for `date` in `timeZone`. */
function dayKey(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function daysInMonth(day) {
  const [y, m] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * @param {Record<string, string|undefined>} [env]
 */
function parseBudgetConfig(env = process.env) {
  const monthly = Number.parseInt(env.CLOUD_MONTHLY_MESSAGE_BUDGET, 10);
  const dailyRaw = String(env.CLOUD_DAILY_MESSAGE_BUDGET || 'auto').trim().toLowerCase();
  const dailyNumber = Number.parseInt(dailyRaw, 10);
  let timeZone = String(env.CLOUD_BUDGET_TZ || DEFAULT_TIME_ZONE).trim();
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone });
  } catch (_) {
    timeZone = DEFAULT_TIME_ZONE;
  }
  const userRaw = String(env.CLOUD_USER_DAILY_DELIVERIES ?? '').trim().toLowerCase();
  const userNumber = Number.parseInt(userRaw, 10);
  return {
    monthlyLimit: Number.isFinite(monthly) && monthly >= 0 ? monthly : DEFAULT_MONTHLY_BUDGET,
    // 'auto' spreads the month; a number is a fixed cap; 'off' means only the monthly budget.
    daily: dailyRaw === 'off' ? 'off' : (Number.isFinite(dailyNumber) && dailyNumber >= 0 ? dailyNumber : 'auto'),
    // Deliveries per WhatsApp number per day; 'off' (or 0) means no per-user limit.
    userDailyLimit: userRaw === 'off' || userNumber === 0
      ? null
      : (Number.isFinite(userNumber) && userNumber > 0 ? userNumber : DEFAULT_USER_DAILY_DELIVERIES),
    timeZone,
  };
}

class CloudBudget {
  /**
   * @param {{file: string, monthlyLimit?: number, daily?: 'auto'|'off'|number,
   *   timeZone?: string, now?: () => number, fsImpl?: typeof fs, logger?: Console}} options
   */
  constructor({
    file,
    monthlyLimit = DEFAULT_MONTHLY_BUDGET,
    daily = 'auto',
    userDailyLimit = DEFAULT_USER_DAILY_DELIVERIES,
    // Key for hashing phone numbers. A plain hash of a phone number can be
    // reversed by trying every number, so it is keyed with a server secret
    // that is not stored in the usage file.
    hashKey = '',
    timeZone = DEFAULT_TIME_ZONE,
    now = Date.now,
    fsImpl = fs,
    logger = console,
  }) {
    this.file = file;
    this.monthlyLimit = monthlyLimit;
    this.daily = daily;
    this.userDailyLimit = userDailyLimit;
    this.hashKey = hashKey || 'statusdrop-cloud-users';
    this.timeZone = timeZone;
    this.now = now;
    this.fs = fsImpl;
    this.logger = logger;
    this.saveTimer = null;
    this.state = this._load();
    this._rollover();
  }

  _empty(day) {
    return {
      version: 1,
      month: day.slice(0, 7),
      monthSent: 0,
      billableSeen: false,
      day,
      daySent: 0,
      dayLimit: null,
      countries: {},
      wabaId: null, // WhatsApp Business Account, learned from webhooks (entry.id)
      // Today's deliveries per WhatsApp number (keyed hash), and who has
      // already been told they reached the limit. Cleared every day.
      users: { day, counts: {}, notified: {} },
    };
  }

  _userKey(number) {
    const digits = String(number || '').replace(/\D/g, '');
    return crypto.createHmac('sha256', this.hashKey).update(digits).digest('hex').slice(0, 20);
  }

  /** Deliveries this WhatsApp number got today. */
  userDeliveriesToday(number) {
    this._rollover();
    return this.state.users.counts[this._userKey(number)] || 0;
  }

  /** May this WhatsApp number get another delivery today? */
  userCanDeliver(number) {
    if (!this.userDailyLimit) return true;
    return this.userDeliveriesToday(number) < this.userDailyLimit;
  }

  /**
   * Record that this number was told about the daily limit. Returns true the
   * first time today, so the notice costs at most one message per number per day.
   */
  markUserNotified(number) {
    this._rollover();
    const key = this._userKey(number);
    if (this.state.users.notified[key]) return false;
    this.state.users.notified[key] = true;
    this._scheduleSave();
    return true;
  }

  /** Remember the WhatsApp Business Account ID for usage checks with Meta. */
  setWabaId(id) {
    const value = String(id || '').replace(/\D/g, '');
    if (value && value !== this.state.wabaId) {
      this.state.wabaId = value;
      this.logger.log(`[WA cloud] WhatsApp Business Account ID: ${value}`);
      this._scheduleSave();
    }
  }

  get wabaId() {
    return this.state.wabaId;
  }

  /** Unix seconds of midnight on the 1st of this month in the budget timezone. */
  monthStartSeconds() {
    const [y, m] = this.state.month.split('-').map(Number);
    const guess = Date.UTC(y, m - 1, 1);
    // Offset of the timezone at that moment: its wall clock read as UTC, minus the instant.
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: this.timeZone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(guess));
    const get = (type) => Number(parts.find((p) => p.type === type).value);
    const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return Math.floor((guess - (wall - guess)) / 1000);
  }

  /**
   * Apply Meta's own count for this month (pricing analytics): it also sees
   * messages this process didn't send, such as tests or an older container's.
   * @param {{used: number, billable: boolean}} meta service messages Meta counted, and whether any were billed
   */
  syncFromMeta({ used, billable }) {
    this._rollover();
    if (Number.isFinite(used) && used > this.state.monthSent) {
      this.logger.log(`[WA cloud] Meta counts ${used} service messages this month (we had ${this.state.monthSent}); using Meta's number.`);
      // Messages we didn't see were sent before today as far as the daily
      // share is concerned, so today's limit shrinks with them.
      this.state.monthSent = used;
      this.state.dayLimit = this._dayLimitFor(this.state.day);
      this._scheduleSave();
    }
    if (billable) this.markBillable();
  }

  _load() {
    const today = dayKey(new Date(this.now()), this.timeZone);
    try {
      const saved = JSON.parse(this.fs.readFileSync(this.file, 'utf8'));
      if (saved && saved.version === 1 && typeof saved.month === 'string') {
        const users = saved.users && typeof saved.users === 'object'
          ? { day: saved.users.day || today, counts: saved.users.counts || {}, notified: saved.users.notified || {} }
          : { day: today, counts: {}, notified: {} };
        return { ...this._empty(today), ...saved, countries: saved.countries || {}, users };
      }
    } catch (_) { /* first run, or unreadable: start counting from zero */ }
    return this._empty(today);
  }

  /** Start a new day or month when the calendar has moved on. */
  _rollover() {
    const today = dayKey(new Date(this.now()), this.timeZone);
    const s = this.state;
    let changed = false;
    if (today.slice(0, 7) !== s.month) {
      this.logger.log(`[WA cloud] New month ${today.slice(0, 7)}: ${s.month} used ${s.monthSent} of ${this.monthlyLimit} budgeted messages.`);
      s.month = today.slice(0, 7);
      s.monthSent = 0;
      s.billableSeen = false;
      changed = true;
    }
    if (today !== s.day) {
      if (s.daySent) this.logger.log(`[WA cloud] Day ${s.day}: ${s.daySent} messages sent.`);
      s.day = today;
      s.daySent = 0;
      s.dayLimit = null;
      changed = true;
    }
    if (s.dayLimit === null) {
      s.dayLimit = this._dayLimitFor(today);
      changed = true;
    }
    if (s.users.day !== today) {
      const limited = Object.keys(s.users.notified).length;
      if (limited) this.logger.log(`[WA cloud] Day ${s.users.day}: ${limited} number(s) reached the daily limit of ${this.userDailyLimit}.`);
      s.users = { day: today, counts: {}, notified: {} };
      changed = true;
    }
    // Keep about three months of country stats.
    const months = Object.keys(s.countries).sort();
    while (months.length > 3) delete s.countries[months.shift()];
    if (changed) this._scheduleSave();
  }

  _dayLimitFor(today) {
    if (this.daily === 'off') return null;
    if (typeof this.daily === 'number') return this.daily;
    // What was left when today started, shared over today and the days after.
    const usedBeforeToday = Math.max(0, this.state.monthSent - this.state.daySent);
    const left = Math.max(0, this.monthlyLimit - usedBeforeToday);
    const daysLeft = daysInMonth(today) - Number(today.slice(8, 10)) + 1;
    return Math.floor(left / Math.max(1, daysLeft));
  }

  /**
   * Room for `count` more messages on top of `reserved` already promised to
   * open deliveries?
   */
  canSpend(count, reserved = 0) {
    this._rollover();
    const s = this.state;
    if (s.billableSeen) return false;
    const need = Math.max(0, count) + Math.max(0, reserved);
    if (s.monthSent + need > this.monthlyLimit) return false;
    if (s.dayLimit !== null && s.daySent + need > s.dayLimit) return false;
    return true;
  }

  /** Why the line is paused, or null while it has room for one message. */
  pausedReason(reserved = 0) {
    if (this.canSpend(1, reserved)) return null;
    const s = this.state;
    if (s.billableSeen) return 'Meta reported a billable message';
    if (s.monthSent + reserved + 1 > this.monthlyLimit) return `monthly budget of ${this.monthlyLimit} messages used`;
    return `today's share of the free messages (${s.dayLimit}) used`;
  }

  /** Count one message the Cloud API accepted. */
  recordSend(to) {
    this._rollover();
    const s = this.state;
    s.monthSent += 1;
    s.daySent += 1;
    const c = this._country(to);
    c.messages += 1;
    this._scheduleSave();
  }

  /**
   * Count one finished delivery (its messages were counted by recordSend).
   * @returns {number} deliveries this number has had today, including this one
   */
  recordDelivery(to) {
    this._rollover();
    this._country(to).deliveries += 1;
    const key = this._userKey(to);
    this.state.users.counts[key] = (this.state.users.counts[key] || 0) + 1;
    this._scheduleSave();
    return this.state.users.counts[key];
  }

  /** Meta said a message was billed: stop for the rest of the month. */
  markBillable() {
    this._rollover();
    if (!this.state.billableSeen) {
      this.state.billableSeen = true;
      this.logger.error('!!! [WA cloud] Meta reported a billable message: the free tier is used up. The Cloud API line is paused until next month.');
      this._scheduleSave();
    }
  }

  _country(to) {
    const s = this.state;
    const code = callingCode(to);
    s.countries[s.month] = s.countries[s.month] || {};
    s.countries[s.month][code] = s.countries[s.month][code] || { deliveries: 0, messages: 0 };
    return s.countries[s.month][code];
  }

  /** Short text for logs: today and this month against their limits. */
  summary() {
    this._rollover();
    const s = this.state;
    const today = s.dayLimit === null ? `${s.daySent}` : `${s.daySent}/${s.dayLimit}`;
    return `today ${today}, ${s.month} ${s.monthSent}/${this.monthlyLimit}`;
  }

  /** This month's countries, busiest first: '+91 40 (52 msgs), +49 3 (3 msgs)'. */
  countrySummary(limit = 8) {
    const month = this.state.countries[this.state.month] || {};
    return Object.entries(month)
      .sort((a, b) => b[1].messages - a[1].messages)
      .slice(0, limit)
      .map(([code, v]) => `+${code} ${v.deliveries} (${v.messages} msgs)`)
      .join(', ') || 'none yet';
  }

  _scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => this.flush(), 1000);
    this.saveTimer.unref?.();
  }

  /** Write the counts now (atomic: temp file, then rename). */
  flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      this.fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      this.fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2));
      this.fs.renameSync(tmp, this.file);
    } catch (err) {
      this.logger.error(`[WA cloud] Could not save message counts to ${this.file}: ${err.message}`);
    }
  }
}

module.exports = {
  DEFAULT_MONTHLY_BUDGET,
  DEFAULT_TIME_ZONE,
  DEFAULT_USER_DAILY_DELIVERIES,
  callingCode,
  dayKey,
  parseBudgetConfig,
  CloudBudget,
};
