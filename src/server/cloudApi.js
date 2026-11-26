'use strict';

/**
 * WhatsApp Cloud API delivery line (Meta's official Graph API).
 *
 * One business number registered on the Cloud API can deliver alongside the
 * Baileys lines. Users message it from the wa.me link exactly as before; the
 * message reaches POST /webhook, and the reply (verified text + clips) is sent
 * with Graph API calls instead of a Baileys socket.
 *
 * Configuration (all required, or the line stays off):
 *   WHATSAPP_CLOUD_TOKEN            permanent System User access token
 *   WHATSAPP_CLOUD_PHONE_NUMBER_ID  the number's Phone number ID (not the WABA ID)
 *   WHATSAPP_CLOUD_NUMBER           the number itself, with country code
 *   META_APP_SECRET                 signs webhook POSTs; required because a
 *                                   webhook message now triggers a delivery
 * Optional:
 *   GRAPH_API_VERSION               default v26.0
 *   WHATSAPP_CLOUD_ENABLED=false    keeps the line off without removing settings
 *
 * The parsing helpers are pure so they can be tested; the client takes an
 * injectable fetch.
 */

const DEFAULT_GRAPH_VERSION = 'v26.0';

/**
 * Largest MP4 Meta's media upload accepts: exactly 16 MiB (16,777,216 bytes
 * uploaded on 26 Nov 2026, one byte more was "File too large"). It applies to
 * MP4s sent as a document too, so bigger clips can't go through the Cloud API.
 */
const CLOUD_VIDEO_MAX_BYTES = 16 * 1024 * 1024;

/** Meta error codes that mean the access token itself is unusable. */
const TOKEN_ERROR_CODES = new Set([190, 102, 10, 200]);

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

/**
 * @param {Record<string, string|undefined>} [env]
 * @returns {{enabled: true, token: string, phoneNumberId: string, number: string, graphVersion: string, appSecret: string}
 *   | {enabled: false, reason: string, configured: boolean}}
 *   configured: true when some Cloud API setting is present (so a missing one is a mistake worth logging)
 */
function parseCloudConfig(env = process.env) {
  const token = String(env.WHATSAPP_CLOUD_TOKEN || '').trim();
  const phoneNumberId = digitsOnly(env.WHATSAPP_CLOUD_PHONE_NUMBER_ID);
  const number = digitsOnly(env.WHATSAPP_CLOUD_NUMBER);
  const appSecret = String(env.META_APP_SECRET || '').trim();
  const graphVersion = /^v\d+\.\d+$/.test(String(env.GRAPH_API_VERSION || ''))
    ? env.GRAPH_API_VERSION
    : DEFAULT_GRAPH_VERSION;
  const configured = !!(token || phoneNumberId || number);

  if (!configured) return { enabled: false, configured, reason: 'not configured' };
  if (env.WHATSAPP_CLOUD_ENABLED === 'false') {
    return { enabled: false, configured, reason: 'WHATSAPP_CLOUD_ENABLED=false' };
  }
  const missing = [];
  if (!token) missing.push('WHATSAPP_CLOUD_TOKEN');
  if (!phoneNumberId) missing.push('WHATSAPP_CLOUD_PHONE_NUMBER_ID');
  if (number.length < 10) missing.push('WHATSAPP_CLOUD_NUMBER');
  // Without the app secret anyone could POST a forged webhook and trigger a
  // delivery, so the line refuses to start instead of running unsigned.
  if (!appSecret) missing.push('META_APP_SECRET');
  if (missing.length) {
    return { enabled: false, configured, reason: `missing ${missing.join(', ')}` };
  }
  return { enabled: true, token, phoneNumberId, number, graphVersion, appSecret };
}

/**
 * Text a user typed, from the message types that can carry an activation code.
 * @param {object} message one entry of value.messages
 * @returns {string}
 */
function messageText(message) {
  if (!message || typeof message !== 'object') return '';
  switch (message.type) {
    case 'text': return String(message.text?.body || '');
    case 'button': return String(message.button?.text || '');
    case 'interactive':
      return String(message.interactive?.button_reply?.title
        || message.interactive?.list_reply?.title || '');
    case 'image': return String(message.image?.caption || '');
    case 'video': return String(message.video?.caption || '');
    case 'document': return String(message.document?.caption || '');
    default: return '';
  }
}

/**
 * Pull the user messages addressed to our number out of a webhook payload.
 * Payloads for other numbers on the same app are ignored.
 *
 * @param {object} body parsed webhook JSON
 * @param {string} phoneNumberId our Phone number ID
 * @returns {Array<{id: string, from: string, timestamp: number, type: string, text: string}>}
 */
function extractInboundMessages(body, phoneNumberId) {
  const out = [];
  if (!body || body.object !== 'whatsapp_business_account') return out;
  for (const entry of Array.isArray(body.entry) ? body.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      if (change?.field !== 'messages') continue;
      const value = change.value || {};
      if (String(value.metadata?.phone_number_id || '') !== String(phoneNumberId)) continue;
      for (const message of Array.isArray(value.messages) ? value.messages : []) {
        const from = digitsOnly(message?.from);
        if (!from || !message.id) continue;
        out.push({
          id: String(message.id),
          from,
          timestamp: Number(message.timestamp) || 0,
          type: String(message.type || 'unknown'),
          text: messageText(message).trim(),
        });
      }
    }
  }
  return out;
}

/**
 * WhatsApp Business Account ID (entry.id) of a webhook that concerns our number.
 * @returns {string|null}
 */
function extractWabaId(body, phoneNumberId) {
  if (!body || body.object !== 'whatsapp_business_account') return null;
  for (const entry of Array.isArray(body.entry) ? body.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      if (String(change?.value?.metadata?.phone_number_id || '') === String(phoneNumberId) && entry.id) {
        return String(entry.id);
      }
    }
  }
  return null;
}

/**
 * True when a delivery report for our number says Meta billed the message
 * (pricing.type 'regular', or the older billable flag). Service messages are
 * only billed once the monthly free tier is used up.
 */
function hasBillableStatus(body, phoneNumberId) {
  if (!body || body.object !== 'whatsapp_business_account') return false;
  for (const entry of Array.isArray(body.entry) ? body.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const value = change?.value || {};
      if (String(value.metadata?.phone_number_id || '') !== String(phoneNumberId)) continue;
      for (const status of Array.isArray(value.statuses) ? value.statuses : []) {
        const pricing = status?.pricing;
        if (pricing && (pricing.type === 'regular' || pricing.billable === true)) return true;
      }
    }
  }
  return false;
}

/**
 * Sum Meta's pricing analytics into this month's service messages.
 * @param {Array<{start: number, pricing_category?: string, pricing_type?: string, volume?: number}>} points
 * @param {number} sinceSeconds count only buckets starting at or after this
 * @returns {{used: number, billable: boolean}}
 */
function summarizeServiceUsage(points, sinceSeconds) {
  let used = 0;
  let regular = 0;
  for (const p of Array.isArray(points) ? points : []) {
    if (Number(p.start) < sinceSeconds) continue;
    if (String(p.pricing_category || '').toUpperCase() !== 'SERVICE') continue;
    const volume = Number(p.volume) || 0;
    used += volume;
    if (String(p.pricing_type || '').toUpperCase() === 'REGULAR') regular += volume;
  }
  return { used, billable: regular > 0 };
}

/**
 * Failed delivery reports for our number, for logging. No phone numbers.
 * @returns {Array<{id: string, code: number|null, title: string}>}
 */
function extractFailedStatuses(body, phoneNumberId) {
  const out = [];
  if (!body || body.object !== 'whatsapp_business_account') return out;
  for (const entry of Array.isArray(body.entry) ? body.entry : []) {
    for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
      const value = change?.value || {};
      if (change?.field !== 'messages') continue;
      if (String(value.metadata?.phone_number_id || '') !== String(phoneNumberId)) continue;
      for (const status of Array.isArray(value.statuses) ? value.statuses : []) {
        if (status?.status !== 'failed') continue;
        const error = Array.isArray(status.errors) ? status.errors[0] : null;
        out.push({
          id: String(status.id || ''),
          code: error?.code ?? null,
          title: String(error?.title || error?.message || 'unknown error'),
        });
      }
    }
  }
  return out;
}

/** Error from a Graph API call. `code` is Meta's error code when there is one. */
class CloudApiError extends Error {
  constructor(message, { status = 0, code = null, details = '' } = {}) {
    super(message);
    this.name = 'CloudApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.isTokenError = TOKEN_ERROR_CODES.has(code) || status === 401;
  }
}

/**
 * @param {{token: string, phoneNumberId: string, graphVersion?: string,
 *   fetchImpl?: typeof fetch, timeoutMs?: number}} options
 */
function createCloudClient({
  token,
  phoneNumberId,
  graphVersion = DEFAULT_GRAPH_VERSION,
  fetchImpl = globalThis.fetch,
  timeoutMs = 60000,
}) {
  const base = `https://graph.facebook.com/${graphVersion}`;

  async function call(method, path, { json, form, timeout = timeoutMs } = {}) {
    let res;
    try {
      res = await fetchImpl(`${base}/${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(json ? { 'content-type': 'application/json' } : {}),
        },
        body: json ? JSON.stringify(json) : form,
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      throw new CloudApiError(`Cloud API ${method} ${path.split('?')[0]} failed: ${err.message}`);
    }
    const text = await res.text();
    let body = {};
    try { body = text ? JSON.parse(text) : {}; } catch (_) { body = {}; }
    if (!res.ok) {
      const e = body.error || {};
      throw new CloudApiError(
        `Cloud API error ${e.code ?? res.status}: ${e.message || res.statusText}`,
        { status: res.status, code: e.code ?? null, details: e.error_data?.details || '' },
      );
    }
    return body;
  }

  function sendMessage(to, payload) {
    return call('POST', `${phoneNumberId}/messages`, {
      json: { messaging_product: 'whatsapp', recipient_type: 'individual', to: digitsOnly(to), ...payload },
    }).then((body) => body.messages?.[0]?.id || '');
  }

  return {
    /** The number's details; also proves the token works. */
    getNumber() {
      return call('GET', `${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating,name_status`);
    },
    sendText(to, body) {
      return sendMessage(to, { type: 'text', text: { body: String(body), preview_url: false } });
    },
    /**
     * Upload a file to Meta and return its media id.
     * @param {Blob} blob file contents (fs.openAsBlob keeps it off the heap)
     */
    async uploadMedia(blob, fileName, mimeType = 'video/mp4', timeout = 300000) {
      const form = new FormData();
      form.append('messaging_product', 'whatsapp');
      form.append('type', mimeType);
      form.append('file', blob, fileName);
      const body = await call('POST', `${phoneNumberId}/media`, { form, timeout });
      if (!body.id) throw new CloudApiError('Cloud API media upload returned no id');
      return body.id;
    },
    /** Daily service/other message volume for a WhatsApp Business Account. */
    async pricingAnalytics(wabaId, startSeconds, endSeconds) {
      const field = `pricing_analytics.start(${Math.floor(startSeconds)}).end(${Math.floor(endSeconds)})`
        + '.granularity(DAILY).metric_types(["VOLUME"]).dimensions(["PRICING_CATEGORY","PRICING_TYPE"])';
      const body = await call('GET', `${wabaId}?fields=${encodeURIComponent(field)}`);
      return (body.pricing_analytics?.data || []).flatMap((d) => d.data_points || []);
    },
    sendVideo(to, mediaId, caption = '') {
      return sendMessage(to, { type: 'video', video: { id: mediaId, ...(caption ? { caption } : {}) } });
    },
    sendDocument(to, mediaId, fileName, caption = '') {
      return sendMessage(to, {
        type: 'document',
        document: { id: mediaId, filename: fileName, ...(caption ? { caption } : {}) },
      });
    },
  };
}

module.exports = {
  DEFAULT_GRAPH_VERSION,
  CLOUD_VIDEO_MAX_BYTES,
  CloudApiError,
  parseCloudConfig,
  messageText,
  extractInboundMessages,
  extractFailedStatuses,
  extractWabaId,
  hasBillableStatus,
  summarizeServiceUsage,
  createCloudClient,
};
